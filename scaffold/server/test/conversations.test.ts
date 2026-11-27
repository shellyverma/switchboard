import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { closeRedis, getRedis } from '../src/redis.js';
import {
  claimConversation,
  ensureConversationIndexes,
  getConversationMessages,
  listConversations,
  recordInboundMessage,
  setConversationStatus,
} from '../src/conversations.js';

const client = new MongoClient(config.mongoUrl);
const workspaces = Array.from({ length: 4 }, () => `test_${randomUUID()}`);

before(async () => {
  await client.connect();
  await ensureConversationIndexes();
});

after(async () => {
  const db = client.db();
  await Promise.all(
    workspaces.map(async (workspace) => {
      await Promise.all([
        db.collection('conversations').deleteMany({ workspace }),
        db.collection('inbound_messages').deleteMany({ workspace }),
        db.collection('outbound_messages').deleteMany({ workspace }),
      ]);
    }),
  );
  await Promise.all(
    workspaces.map((workspace) =>
      getRedis().del(
        `switchboard:events:${encodeURIComponent(workspace)}:seq`,
        `switchboard:events:${encodeURIComponent(workspace)}:stream`,
        `switchboard:events:${encodeURIComponent(workspace)}:dedupe`,
      ),
    ),
  );
  await closeRedis();
  await closeDb();
  await client.close();
});

test('creates workspace-scoped conversations and reads messages oldest first', async () => {
  const [workspace, otherWorkspace] = workspaces;
  const contact = '+14155550101';
  const earlier = new Date('2026-01-01T10:00:00.000Z');
  const later = new Date('2026-01-01T11:00:00.000Z');

  await recordInboundMessage({
    workspace,
    contact,
    messageId: 'message-later',
    text: 'newer',
    eventId: 'event-later',
    occurredAt: later,
  });
  await recordInboundMessage({
    workspace,
    contact,
    messageId: 'message-earlier',
    text: 'older',
    eventId: 'event-earlier',
    occurredAt: earlier,
  });
  await client.db().collection('outbound_messages').insertOne({
    workspace,
    contact,
    clientRef: 'reply-middle',
    text: 'reply',
    status: 'delivered',
    occurredAt: new Date('2026-01-01T10:30:00.000Z'),
  });
  await recordInboundMessage({
    workspace: otherWorkspace,
    contact,
    messageId: 'other-message',
    text: 'other tenant',
    eventId: 'other-event',
    occurredAt: later,
  });

  const result = await getConversationMessages(workspace, contact);
  assert.ok(result);
  assert.deepEqual(
    result.messages.map((message) => message.messageId ?? message.clientRef),
    ['message-earlier', 'reply-middle', 'message-later'],
  );
  assert.deepEqual(
    result.messages.map((message) => message.direction),
    ['inbound', 'outbound', 'inbound'],
  );
  assert.equal(await getConversationMessages(workspace, '+14155550102'), undefined);

  const inbox = await listConversations(workspace, 10);
  assert.deepEqual(inbox.conversations.map((conversation) => conversation.contact), [contact]);
});

test('paginates newest activity first with a stable cursor', async () => {
  const workspace = workspaces[2];
  const contacts = ['contact-old', 'contact-middle', 'contact-new'];
  const timestamps = [
    new Date('2026-02-01T10:00:00.000Z'),
    new Date('2026-02-01T11:00:00.000Z'),
    new Date('2026-02-01T12:00:00.000Z'),
  ];

  for (let index = 0; index < contacts.length; index++) {
    await recordInboundMessage({
      workspace,
      contact: contacts[index],
      messageId: `page-message-${index}`,
      text: contacts[index],
      eventId: `page-event-${index}`,
      occurredAt: timestamps[index],
    });
  }

  const firstPage = await listConversations(workspace, 2);
  assert.deepEqual(
    firstPage.conversations.map((conversation) => conversation.contact),
    ['contact-new', 'contact-middle'],
  );
  assert.ok(firstPage.next_cursor);

  const secondPage = await listConversations(workspace, 2, firstPage.next_cursor);
  assert.deepEqual(
    secondPage.conversations.map((conversation) => conversation.contact),
    ['contact-old'],
  );
  assert.equal(secondPage.next_cursor, null);
});

test('allows only one concurrent claimant and supports close and reopen', async () => {
  const workspace = workspaces[3];
  const contact = 'claim-race';
  const results = await Promise.all([
    claimConversation(workspace, contact, 'agent-one'),
    claimConversation(workspace, contact, 'agent-two'),
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1);

  const winner = results.find((result) => result.claimed);
  const loser = results.find((result) => !result.claimed);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.conversation.assignee, winner.conversation.assignee);
  assert.equal(
    (await claimConversation(workspace, contact, winner.conversation.assignee)).claimed,
    true,
  );

  assert.equal((await setConversationStatus(workspace, contact, 'closed'))?.status, 'closed');
  assert.equal((await setConversationStatus(workspace, contact, 'open'))?.status, 'open');
});
