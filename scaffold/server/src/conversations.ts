import { MongoServerError, type Document, type Filter } from 'mongodb';
import { getDb } from './db.js';

export type ConversationStatus = 'open' | 'closed';

export type Conversation = {
  workspace: string;
  contact: string;
  status: ConversationStatus;
  assignee: string | null;
  createdAt: Date;
  lastActivityAt: Date;
};

export type ConversationPage = {
  conversations: Document[];
  next_cursor: string | null;
};

export class InvalidConversationCursorError extends Error {}

let indexesReady: Promise<void> | undefined;

export async function ensureConversationIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection('conversations').createIndex(
          { workspace: 1, contact: 1 },
          { unique: true, name: 'workspace_contact_unique' },
        ),
        db.collection('conversations').createIndex(
          { workspace: 1, lastActivityAt: -1, contact: 1 },
          { name: 'workspace_activity_inbox' },
        ),
        db.collection('inbound_messages').createIndex(
          { workspace: 1, messageId: 1 },
          { unique: true, name: 'workspace_message_id_unique' },
        ),
        db.collection('inbound_messages').createIndex(
          { workspace: 1, contact: 1, occurredAt: 1, messageId: 1 },
          { name: 'workspace_contact_message_order' },
        ),
      ]);
    })();
  }

  try {
    await indexesReady;
  } catch (error) {
    indexesReady = undefined;
    throw error;
  }
}

export async function recordInboundMessage(input: {
  workspace: string;
  contact: string;
  messageId: string;
  text: string;
  eventId: string;
  occurredAt: Date;
}): Promise<void> {
  await ensureConversation(input.workspace, input.contact, input.occurredAt);
  const db = await getDb();
  const messageFilter = { workspace: input.workspace, messageId: input.messageId };
  await upsertOnInsert(db.collection('inbound_messages'), messageFilter, {
    ...messageFilter,
    contact: input.contact,
    text: input.text,
    occurredAt: input.occurredAt,
    eventId: input.eventId,
    receivedAt: new Date(),
  });
}

export async function ensureConversation(
  workspace: string,
  contact: string,
  activityAt = new Date(),
): Promise<void> {
  await ensureConversationIndexes();
  const db = await getDb();
  const conversationFilter = { workspace, contact };
  await upsertOnInsert(db.collection('conversations'), conversationFilter, {
    ...conversationFilter,
    status: 'open',
    assignee: null,
    createdAt: activityAt,
  }, { lastActivityAt: activityAt });
}

export async function listConversations(
  workspace: string,
  limit: number,
  cursor?: string,
): Promise<ConversationPage> {
  await ensureConversationIndexes();
  const filter: Filter<Document> = { workspace };
  if (cursor) {
    const position = decodeCursor(cursor);
    filter.$or = [
      { lastActivityAt: { $lt: position.lastActivityAt } },
      { lastActivityAt: position.lastActivityAt, contact: { $gt: position.contact } },
    ];
  }

  const results = await (await getDb())
    .collection('conversations')
    .find(filter)
    .sort({ lastActivityAt: -1, contact: 1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = results.length > limit;
  const conversations = hasMore ? results.slice(0, limit) : results;
  const last = conversations.at(-1);
  return {
    conversations,
    next_cursor: hasMore && last ? encodeCursor(last.lastActivityAt, last.contact) : null,
  };
}

export async function getConversationMessages(
  workspace: string,
  contact: string,
): Promise<{ conversation: Document; messages: Document[] } | undefined> {
  await ensureConversationIndexes();
  const db = await getDb();
  const conversation = await db.collection('conversations').findOne({ workspace, contact });
  if (!conversation) return undefined;

  const [inbound, outbound] = await Promise.all([
    db
      .collection('inbound_messages')
      .find({ workspace, contact })
      .sort({ occurredAt: 1, messageId: 1 })
      .toArray(),
    db
      .collection('outbound_messages')
      .find({ workspace, contact, occurredAt: { $type: 'date' } })
      .toArray(),
  ]);
  const messages: Document[] = [
    ...inbound.map((message): Document => ({ ...message, direction: 'inbound' })),
    ...outbound.map((message): Document => ({ ...message, direction: 'outbound' })),
  ].sort((a, b) => {
    const timeDifference = new Date(a['occurredAt']).getTime() - new Date(b['occurredAt']).getTime();
    if (timeDifference !== 0) return timeDifference;
    return String(a['messageId'] ?? a['clientRef'] ?? '').localeCompare(
      String(b['messageId'] ?? b['clientRef'] ?? ''),
    );
  });
  return { conversation, messages };
}

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
): Promise<{ claimed: boolean; conversation: Document }> {
  await ensureConversationIndexes();
  const db = await getDb();
  const collection = db.collection('conversations');
  const conversationFilter = { workspace, contact };
  const now = new Date();

  await upsertOnInsert(
    collection,
    conversationFilter,
    {
      ...conversationFilter,
      status: 'open',
      assignee: null,
      createdAt: now,
    },
    { lastActivityAt: now },
  );

  const result = await collection.updateOne(
    {
      ...conversationFilter,
      $or: [{ assignee: null }, { assignee: agent }],
    },
    { $set: { assignee: agent, lastActivityAt: now } },
  );
  const conversation = await collection.findOne(conversationFilter);
  if (!conversation) throw new Error('Conversation disappeared during claim');
  return { claimed: result.matchedCount === 1, conversation };
}

export async function setConversationStatus(
  workspace: string,
  contact: string,
  status: ConversationStatus,
): Promise<Document | undefined> {
  await ensureConversationIndexes();
  const db = await getDb();
  const filter = { workspace, contact };
  const result = await db.collection('conversations').updateOne(filter, {
    $set: { status, lastActivityAt: new Date() },
  });
  if (result.matchedCount === 0) return undefined;
  const conversation = await db.collection('conversations').findOne(filter);
  return conversation ?? undefined;
}

async function upsertOnInsert(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  filter: Document,
  document: Document,
  set: Document = {},
): Promise<void> {
  try {
    await collection.updateOne(
      filter,
      { $setOnInsert: document, ...(Object.keys(set).length ? { $max: set } : {}) },
      { upsert: true },
    );
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const existing = await collection.findOne(filter, { projection: { _id: 1 } });
    if (!existing) throw error;
  }
}

function encodeCursor(lastActivityAt: Date, contact: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt: lastActivityAt.toISOString(), contact })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { lastActivityAt: Date; contact: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('lastActivityAt' in parsed) ||
      typeof parsed.lastActivityAt !== 'string' ||
      !('contact' in parsed) ||
      typeof parsed.contact !== 'string'
    ) {
      throw new Error('Invalid cursor shape');
    }
    const lastActivityAt = new Date(parsed.lastActivityAt);
    if (Number.isNaN(lastActivityAt.getTime())) throw new Error('Invalid cursor date');
    return { lastActivityAt, contact: parsed.contact };
  } catch {
    throw new InvalidConversationCursorError('Invalid conversation cursor');
  }
}
