import type { Db, Document } from 'mongodb';
import type { Redis } from 'ioredis';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

type SnapshotContact = {
  inbound: string[];
  assignee: string | null;
};

type GraderSnapshot = {
  workspaces: Record<
    string,
    {
      contacts: Record<string, SnapshotContact>;
      outbound: Record<string, string>;
    }
  >;
};

const applicationCollections = [
  'pigeon_events',
  'inbound_messages',
  'outbound_messages',
  'conversations',
] as const;

export async function buildGraderSnapshot(): Promise<GraderSnapshot> {
  const db = await getDb();
  const workspaces: GraderSnapshot['workspaces'] = {};
  const getWorkspace = (workspace: string) => {
    workspaces[workspace] ??= { contacts: {}, outbound: {} };
    return workspaces[workspace];
  };
  const getContact = (workspace: string, contact: string) => {
    const data = getWorkspace(workspace);
    data.contacts[contact] ??= { inbound: [], assignee: null };
    return data.contacts[contact];
  };

  for (const workspace of Object.keys(config.pigeon.apiKeys)) getWorkspace(workspace);

  const conversations = await db.collection('conversations').find({}).toArray();
  for (const conversation of conversations) {
    const workspace = String(conversation['workspace']);
    const contact = String(conversation['contact']);
    getContact(workspace, contact).assignee =
      typeof conversation['assignee'] === 'string' ? conversation['assignee'] : null;
  }

  const inbound = await db
    .collection('inbound_messages')
    .find({})
    .sort({ occurredAt: 1, messageId: 1 })
    .toArray();
  for (const message of inbound) {
    getContact(String(message['workspace']), String(message['contact'])).inbound.push(
      String(message['messageId']),
    );
  }

  const outbound = await db.collection('outbound_messages').find({}).toArray();
  for (const message of outbound) {
    getWorkspace(String(message['workspace'])).outbound[String(message['clientRef'])] =
      String(message['status']);
  }

  return { workspaces };
}

export async function resetApplicationData(db?: Db, redisClient?: Redis): Promise<void> {
  const activeDb = db ?? (await getDb());
  await Promise.all(
    applicationCollections.map((name) => activeDb.collection(name).deleteMany({})),
  );

  const redis = redisClient ?? getRedis();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      'switchboard:*',
      'COUNT',
      '500',
    );
    cursor = nextCursor;
    const applicationKeys = keys.filter((key) => !key.startsWith('switchboard:session:'));
    if (applicationKeys.length > 0) await redis.del(...applicationKeys);
  } while (cursor !== '0');
}
