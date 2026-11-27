import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { MongoServerError, type Document, type Filter } from 'mongodb';
import { config } from './config.js';
import { getDb } from './db.js';

const knownWorkspaces = new Set(Object.keys(config.pigeon.apiKeys));

type InboundEvent = {
  id: string;
  type: 'message.inbound';
  workspace: string;
  occurred_at: string;
  data: {
    message_id: string;
    from: string;
    text: string;
  };
};

type StatusEvent = {
  id: string;
  type: 'message.status';
  workspace: string;
  occurred_at: string;
  data: {
    message_id: string;
    client_ref: string;
    status: 'sent' | 'delivered' | 'failed';
  };
};

type PigeonEvent = InboundEvent | StatusEvent;

let indexesReady: Promise<void> | undefined;

export function verifyPigeonSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const match = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(signature ?? '');
  if (!match) return false;

  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 5 * 60) {
    return false;
  }

  const supplied = Buffer.from(match[2], 'hex');
  const expected = createHmac('sha256', secret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function handlePigeonWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyPigeonSignature(rawBody, req.get('x-pigeon-signature'), config.pigeon.webhookSecret)) {
    res.sendStatus(401);
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    res.sendStatus(400);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  if (!isRecord(payload) || typeof payload.type !== 'string') {
    res.sendStatus(400);
    return;
  }

  if (payload.type !== 'message.inbound' && payload.type !== 'message.status') {
    res.sendStatus(204);
    return;
  }

  if (typeof payload.workspace !== 'string') {
    res.sendStatus(400);
    return;
  }
  if (!knownWorkspaces.has(payload.workspace)) {
    res.sendStatus(204);
    return;
  }

  const eventId = req.get('x-pigeon-event-id');
  if (
    typeof payload.id !== 'string' ||
    payload.id.length === 0 ||
    (eventId !== undefined && eventId !== payload.id)
  ) {
    res.sendStatus(400);
    return;
  }

  const occurredAt =
    typeof payload.occurred_at === 'string' ? new Date(payload.occurred_at) : new Date(Number.NaN);
  if (Number.isNaN(occurredAt.getTime()) || !isRecord(payload.data)) {
    res.sendStatus(400);
    return;
  }

  let pigeonEvent: PigeonEvent;
  if (payload.type === 'message.inbound') {
    const data = payload.data;
    if (
      typeof data.message_id !== 'string' ||
      typeof data.from !== 'string' ||
      typeof data.text !== 'string'
    ) {
      res.sendStatus(400);
      return;
    }
    pigeonEvent = {
      id: payload.id,
      type: 'message.inbound',
      workspace: payload.workspace,
      occurred_at: payload.occurred_at as string,
      data: { message_id: data.message_id, from: data.from, text: data.text },
    };
  } else {
    const data = payload.data;
    if (
      typeof data.message_id !== 'string' ||
      typeof data.client_ref !== 'string' ||
      (data.status !== 'sent' && data.status !== 'delivered' && data.status !== 'failed')
    ) {
      res.sendStatus(400);
      return;
    }
    pigeonEvent = {
      id: payload.id,
      type: 'message.status',
      workspace: payload.workspace,
      occurred_at: payload.occurred_at as string,
      data: {
        message_id: data.message_id,
        client_ref: data.client_ref,
        status: data.status,
      },
    };
  }

  try {
    await ensureIndexes();
    if (pigeonEvent.type === 'message.inbound') {
      await storeInboundEvent(pigeonEvent, occurredAt);
    } else {
      await storeStatusEvent(pigeonEvent, occurredAt);
    }
  } catch (error) {
    console.error('Failed to persist Pigeon webhook', error);
    res.sendStatus(503);
    return;
  }

  res.sendStatus(204);
}

async function ensureIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection('pigeon_events').createIndex(
          { workspace: 1, eventId: 1 },
          { unique: true, name: 'workspace_event_id_unique' },
        ),
        db.collection('inbound_messages').createIndex(
          { workspace: 1, messageId: 1 },
          { unique: true, name: 'workspace_message_id_unique' },
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

async function storeInboundEvent(event: InboundEvent, occurredAt: Date): Promise<void> {
  const db = await getDb();
  const messageFilter = { workspace: event.workspace, messageId: event.data.message_id };
  await upsertOnce(db.collection('inbound_messages'), messageFilter, {
    ...messageFilter,
    contact: event.data.from,
    text: event.data.text,
    occurredAt,
    eventId: event.id,
    receivedAt: new Date(),
  });
  await storeEventReceipt(db.collection('pigeon_events'), event, occurredAt);
}

async function storeStatusEvent(event: StatusEvent, occurredAt: Date): Promise<void> {
  const db = await getDb();
  const outboundFilter = { workspace: event.workspace, clientRef: event.data.client_ref };
  const outbound = await db.collection('outbound_messages').findOne(outboundFilter);
  if (!outbound) return;

  await storeEventReceipt(db.collection('pigeon_events'), event, occurredAt);

  const statusFilter: Filter<Document> = {
    _id: outbound._id,
    ...outboundFilter,
    $or: [{ statusAt: { $exists: false } }, { statusAt: { $lt: occurredAt } }],
  };
  if (event.data.status === 'sent') {
    statusFilter.status = { $nin: ['delivered', 'failed'] };
  }

  await db.collection('outbound_messages').updateOne(statusFilter, {
    $set: { status: event.data.status, statusAt: occurredAt },
  });
}

async function storeEventReceipt(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  event: PigeonEvent,
  occurredAt: Date,
): Promise<void> {
  const filter = { workspace: event.workspace, eventId: event.id };
  await upsertOnce(collection, filter, {
    ...filter,
    type: event.type,
    occurredAt,
    payload: event,
    receivedAt: new Date(),
  });
}

async function upsertOnce(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  filter: Document,
  document: Document,
): Promise<void> {
  try {
    await collection.updateOne(filter, { $setOnInsert: document }, { upsert: true });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const existing = await collection.findOne(filter, { projection: { _id: 1 } });
    if (!existing) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
