import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { buildGraderSnapshot, resetApplicationData } from '../src/grader.js';
import { recordInboundMessage } from '../src/conversations.js';

const client = new MongoClient(config.mongoUrl);
const workspace = `test_${randomUUID()}`;
const contact = `snapshot-${randomUUID()}`;
const resetDbName = `switchboard_grader_test_${randomUUID().replaceAll('-', '')}`;
const resetRedis = new Redis(config.redisUrl, { db: 15 });

before(async () => {
  await client.connect();
  await resetRedis.ping();
});

after(async () => {
  await Promise.all([
    client.db().collection('conversations').deleteMany({ workspace, contact }),
    client.db().collection('inbound_messages').deleteMany({ workspace, contact }),
    client.db().collection('outbound_messages').deleteMany({ workspace, contact }),
    client.db(resetDbName).dropDatabase(),
    resetRedis.del('switchboard:session:grader-test', 'switchboard:pigeon:rate-limit:grader-test'),
  ]);
  await closeDb();
  await resetRedis.quit();
  await client.close();
});

test('builds the grader snapshot with ordered inbound IDs and outbound statuses', async () => {
  await recordInboundMessage({
    workspace,
    contact,
    messageId: 'snapshot-later',
    text: 'later',
    eventId: 'snapshot-event-later',
    occurredAt: new Date('2026-03-02T10:00:00.000Z'),
  });
  await recordInboundMessage({
    workspace,
    contact,
    messageId: 'snapshot-earlier',
    text: 'earlier',
    eventId: 'snapshot-event-earlier',
    occurredAt: new Date('2026-03-02T09:00:00.000Z'),
  });
  await client.db().collection('conversations').updateOne(
    { workspace, contact },
    { $set: { assignee: 'agent-snapshot' } },
  );
  await client.db().collection('outbound_messages').insertOne({
    workspace,
    contact,
    clientRef: 'snapshot-reply',
    status: 'delivered',
    occurredAt: new Date('2026-03-02T10:30:00.000Z'),
  });

  const snapshot = await buildGraderSnapshot();
  assert.deepEqual(snapshot.workspaces[workspace].contacts[contact], {
    inbound: ['snapshot-earlier', 'snapshot-later'],
    assignee: 'agent-snapshot',
  });
  assert.equal(snapshot.workspaces[workspace].outbound['snapshot-reply'], 'delivered');
});

test('reset removes application data and Redis keys while preserving sessions', async () => {
  const db = client.db(resetDbName);
  await Promise.all([
    db.collection('conversations').insertOne({ workspace, contact }),
    db.collection('outbound_messages').insertOne({ workspace, contact, clientRef: 'reset-reply' }),
    resetRedis.set('switchboard:session:grader-test', 'session'),
    resetRedis.set('switchboard:pigeon:rate-limit:grader-test', 'rate-limit'),
  ]);

  await resetApplicationData(db, resetRedis);

  assert.equal(await db.collection('conversations').countDocuments({}), 0);
  assert.equal(await db.collection('outbound_messages').countDocuments({}), 0);
  assert.equal(await resetRedis.get('switchboard:session:grader-test'), 'session');
  assert.equal(await resetRedis.get('switchboard:pigeon:rate-limit:grader-test'), null);
});
