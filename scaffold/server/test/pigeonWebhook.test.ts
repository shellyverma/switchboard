import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import test from 'node:test';
import { config } from '../src/config.js';
import { closeDb, getDb } from '../src/db.js';
import { handlePigeonWebhook, verifyPigeonSignature } from '../src/pigeonWebhook.js';
import { closeRedis, getRedis } from '../src/redis.js';

const secret = 'test-secret';
const nowSeconds = 1_800_000_000;

function signatureFor(body: Buffer, timestamp: number, signingSecret = secret): string {
  const digest = createHmac('sha256', signingSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test('accepts a signature calculated over the exact raw body', () => {
  const body = Buffer.from('{"text":"hello"}');

  assert.equal(verifyPigeonSignature(body, signatureFor(body, nowSeconds), secret, nowSeconds), true);
});

test('rejects a signature when the raw body changes', () => {
  const signedBody = Buffer.from('{"text":"hello"}');
  const receivedBody = Buffer.from('{"text": "hello"}');

  assert.equal(
    verifyPigeonSignature(receivedBody, signatureFor(signedBody, nowSeconds), secret, nowSeconds),
    false,
  );
});

test('rejects malformed, stale, and too-far-in-the-future signatures', () => {
  const body = Buffer.from('{}');

  assert.equal(verifyPigeonSignature(body, undefined, secret, nowSeconds), false);
  assert.equal(verifyPigeonSignature(body, 't=bad,v1=bad', secret, nowSeconds), false);
  assert.equal(
    verifyPigeonSignature(body, signatureFor(body, nowSeconds - 301), secret, nowSeconds),
    false,
  );
  assert.equal(
    verifyPigeonSignature(body, signatureFor(body, nowSeconds + 301), secret, nowSeconds),
    false,
  );
});

test('allows a final status to replace sent when provider timestamps tie', async () => {
  const workspace = 'ws_acme';
  const clientRef = `status-tie-${cryptoRandomId()}`;
  const firstEventId = `status-event-${cryptoRandomId()}`;
  const olderEventId = `status-event-${cryptoRandomId()}`;
  const occurredAt = new Date();
  const db = await getDb();
  const outbound = db.collection('outbound_messages');
  const receipts = db.collection('pigeon_events');
  const redis = getRedis();
  const streamPrefix = `switchboard:events:${encodeURIComponent(workspace)}`;
  const app = express();
  app.post(
    '/webhooks/pigeon',
    express.raw({ type: 'application/json', limit: '1mb', inflate: false }),
    (req, res) => {
      void handlePigeonWebhook(req, res);
    },
  );
  const server = createServer(app);

  await outbound.insertOne({
    workspace,
    contact: '+14155550101',
    clientRef,
    status: 'sent',
    statusAt: occurredAt,
    sentAt: occurredAt,
    occurredAt,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start');

    const deliveredResponse = await postStatusEvent(address.port, {
      id: firstEventId,
      workspace,
      clientRef,
      occurredAt,
      status: 'delivered',
    });
    assert.equal(deliveredResponse.status, 204);

    const olderSentResponse = await postStatusEvent(address.port, {
      id: olderEventId,
      workspace,
      clientRef,
      occurredAt: new Date(occurredAt.getTime() - 1_000),
      status: 'sent',
    });
    assert.equal(olderSentResponse.status, 204);

    const saved = await outbound.findOne({ workspace, clientRef });
    assert.equal(saved?.['status'], 'delivered');
    const statusAt = saved?.['statusAt'];
    assert.ok(statusAt instanceof Date);
    assert.equal(statusAt.getTime(), occurredAt.getTime());
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
    await Promise.all([
      outbound.deleteOne({ workspace, clientRef }),
      receipts.deleteMany({ workspace, eventId: { $in: [firstEventId, olderEventId] } }),
    ]);
    const eventId = `status:${clientRef}:delivered`;
    const encoded = await redis.hget(`${streamPrefix}:dedupe`, eventId);
    if (encoded) {
      const event: unknown = JSON.parse(encoded);
      if (isRecord(event) && typeof event.seq === 'number') {
        await redis.xdel(`${streamPrefix}:stream`, `${event.seq}-0`);
      }
      await redis.hdel(`${streamPrefix}:dedupe`, eventId);
    }
    await closeDb();
    await closeRedis();
  }
});

async function postStatusEvent(
  port: number,
  input: {
    id: string;
    workspace: string;
    clientRef: string;
    occurredAt: Date;
    status: 'sent' | 'delivered';
  },
): Promise<Response> {
  const body = Buffer.from(
    JSON.stringify({
      id: input.id,
      type: 'message.status',
      workspace: input.workspace,
      occurred_at: input.occurredAt.toISOString(),
      data: {
        message_id: `pm_${input.id}`,
        client_ref: input.clientRef,
        status: input.status,
      },
    }),
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signatureFor(body, timestamp, config.pigeon.webhookSecret);
  return fetch(`http://localhost:${port}/webhooks/pigeon`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pigeon-signature': signature,
      'x-pigeon-event-id': input.id,
      connection: 'close',
    },
    body,
  });
}

function cryptoRandomId(): string {
  return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
