import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closeRedis, getRedis } from '../src/redis.js';
import {
  latestWorkspaceSequence,
  publishWorkspaceEvent,
  readWorkspaceEvents,
} from '../src/realtime.js';

const workspace = `test_realtime_${randomUUID()}`;
const prefix = `switchboard:events:${encodeURIComponent(workspace)}`;

before(async () => {
  await getRedis().ping();
});

after(async () => {
  await getRedis().del(`${prefix}:seq`, `${prefix}:stream`, `${prefix}:dedupe`);
  await closeRedis();
});

test('persists workspace event ordering and deduplicates repeated event ids', async () => {
  const firstSequence = await publishWorkspaceEvent(workspace, 'event-one', {
    type: 'message.inbound',
    contact: 'contact-one',
  });
  const duplicateSequence = await publishWorkspaceEvent(workspace, 'event-one', {
    type: 'message.inbound',
    contact: 'different-payload',
  });
  const secondSequence = await publishWorkspaceEvent(workspace, 'event-two', {
    type: 'conversation.assigned',
    contact: 'contact-one',
  });

  assert.equal(firstSequence, 1);
  assert.equal(duplicateSequence, firstSequence);
  assert.equal(secondSequence, 2);
  assert.equal(await latestWorkspaceSequence(workspace), secondSequence);
  assert.deepEqual(await readWorkspaceEvents(workspace, 0), [
    {
      workspace,
      seq: 1,
      type: 'message.inbound',
      contact: 'contact-one',
    },
    {
      workspace,
      seq: 2,
      type: 'conversation.assigned',
      contact: 'contact-one',
    },
  ]);
  assert.deepEqual(await readWorkspaceEvents(workspace, 1), [
    {
      workspace,
      seq: 2,
      type: 'conversation.assigned',
      contact: 'contact-one',
    },
  ]);
});
