import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';
import { closeDb } from '../src/db.js';
import { ensureOutboundIndexes, enqueueReply, processNextReply } from '../src/outbound.js';
import { closeRedis, getRedis } from '../src/redis.js';

const client = new MongoClient(config.mongoUrl);
const workspaces: string[] = [];

before(async () => {
  await client.connect();
  await Promise.all([
    client.db().collection('outbound_messages').deleteMany({
      workspace: /^test_[0-9a-f-]{36}$/,
      clientRef: /^test-reply-/,
    }),
    client.db().collection('conversations').deleteMany({
      workspace: /^test_[0-9a-f-]{36}$/,
      contact: /^test-contact-/,
    }),
  ]);
  await ensureOutboundIndexes();
  await getRedis().ping();
});

after(async () => {
  await Promise.all(
    workspaces.map(async (workspace) => {
      await Promise.all([
        client.db().collection('outbound_messages').deleteMany({ workspace }),
        client.db().collection('conversations').deleteMany({ workspace }),
        getRedis().del(
          rateLimitKey(workspace),
          `switchboard:events:${encodeURIComponent(workspace)}:seq`,
          `switchboard:events:${encodeURIComponent(workspace)}:stream`,
          `switchboard:events:${encodeURIComponent(workspace)}:dedupe`,
        ),
      ]);
      delete config.pigeon.apiKeys[workspace];
    }),
  );
  await closeDb();
  await closeRedis();
  await client.close();
});

function newWorkspace(): string {
  const workspace = `test_${randomUUID()}`;
  config.pigeon.apiKeys[workspace] = config.pigeon.apiKeys.ws_acme;
  workspaces.push(workspace);
  return workspace;
}

function newReply(workspace = newWorkspace()) {
  const id = randomUUID();
  const input = {
    workspace,
    contact: `test-contact-${id}`,
    text: `test reply ${id}`,
    clientRef: `test-reply-${id}`,
  };
  return input;
}

async function resetRateLimit(workspace: string): Promise<void> {
  await getRedis().del(rateLimitKey(workspace));
}

function rateLimitKey(workspace: string): string {
  return `switchboard:pigeon:rate-limit:${encodeURIComponent(workspace)}`;
}

function acceptedResponse(id = `pigeon-${randomUUID()}`): Response {
  return new Response(JSON.stringify({ id, status: 'accepted' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('durably enqueues one reply per workspace/client_ref and creates its conversation', async () => {
  const input = newReply();
  const first = await enqueueReply(input);
  const duplicate = await enqueueReply(input);

  assert.equal(first.status, 'queued');
  assert.equal(duplicate._id.toString(), first._id.toString());
  assert.equal(
    await client.db().collection('outbound_messages').countDocuments({
      workspace: input.workspace,
      clientRef: input.clientRef,
    }),
    1,
  );
  assert.equal(
    await client.db().collection('conversations').countDocuments({
      workspace: input.workspace,
      contact: input.contact,
    }),
    1,
  );
  await client.db().collection('outbound_messages').updateOne(
    { workspace: input.workspace, clientRef: input.clientRef },
    { $set: { status: 'sent' } },
  );
});

test('honors Retry-After across queued replies without calling Pigeon during cooldown', async () => {
  const workspace = newWorkspace();
  const limited = newReply(workspace);
  const other = newReply(workspace);
  await enqueueReply(limited);
  await enqueueReply(other);
  await resetRateLimit(workspace);

  let requests = 0;
  const rateLimitedFetcher: typeof fetch = async (_input, init) => {
    requests += 1;
    assert.equal(new Headers(init?.headers).get('idempotency-key'), limited.clientRef);
    return new Response('', { status: 429, headers: { 'retry-after': '2' } });
  };
  const blockedFetcher: typeof fetch = async () => {
    requests += 1;
    return acceptedResponse();
  };

  const startedAt = Date.now();
  await processNextReply(rateLimitedFetcher);
  const delayed = await client.db().collection('outbound_messages').findOne({
    workspace: limited.workspace,
    clientRef: limited.clientRef,
  });
  assert.equal(delayed?.status, 'queued');
  assert.ok(new Date(delayed?.nextAttemptAt).getTime() >= startedAt + 1_900);

  await processNextReply(blockedFetcher);
  assert.equal(requests, 1);
  await client.db().collection('outbound_messages').updateMany(
    { workspace, clientRef: { $in: [limited.clientRef, other.clientRef] } },
    { $set: { status: 'failed' } },
  );
});

test('retries 503 with the same idempotency key and marks the reply sent on acceptance', async () => {
  const input = newReply();
  await enqueueReply(input);
  await resetRateLimit(input.workspace);

  const idempotencyKeys: Array<string | null> = [];
  const temporaryFailure: typeof fetch = async (_url, init) => {
    idempotencyKeys.push(new Headers(init?.headers).get('idempotency-key'));
    return new Response('', { status: 503 });
  };
  await processNextReply(temporaryFailure);

  const collection = client.db().collection('outbound_messages');
  const queued = await collection.findOne({ workspace: input.workspace, clientRef: input.clientRef });
  assert.equal(queued?.status, 'queued');
  await collection.updateOne(
    { workspace: input.workspace, clientRef: input.clientRef },
    { $set: { nextAttemptAt: new Date(0) } },
  );
  await resetRateLimit(input.workspace);

  const success: typeof fetch = async (_url, init) => {
    idempotencyKeys.push(new Headers(init?.headers).get('idempotency-key'));
    return acceptedResponse('pigeon-accepted-503-retry');
  };
  await processNextReply(success);

  const sent = await collection.findOne({ workspace: input.workspace, clientRef: input.clientRef });
  assert.deepEqual(idempotencyKeys, [input.clientRef, input.clientRef]);
  assert.equal(sent?.status, 'sent');
  assert.equal(sent?.providerMessageId, 'pigeon-accepted-503-retry');
  assert.equal(sent?.attempts, 2);
});

test('keeps a lease during a delayed response and recovers an expired lease', async () => {
  const input = newReply();
  await enqueueReply(input);
  await resetRateLimit(input.workspace);
  await client.db().collection('outbound_messages').updateOne(
    { workspace: input.workspace, clientRef: input.clientRef },
    { $set: { leaseOwner: 'dead-worker', leaseUntil: new Date(Date.now() - 1_000) } },
  );

  let finishRequest!: (response: Response) => void;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const delayedResponse = new Promise<Response>((resolve) => {
    finishRequest = resolve;
  });
  const slowFetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('idempotency-key'), input.clientRef);
    requestStarted();
    return delayedResponse;
  };

  const activeSend = processNextReply(slowFetcher);
  await started;
  assert.equal(await processNextReply(async () => acceptedResponse()), false);
  finishRequest(acceptedResponse('pigeon-delayed-response'));
  assert.equal(await activeSend, true);

  const sent = await client.db().collection('outbound_messages').findOne({
    workspace: input.workspace,
    clientRef: input.clientRef,
  });
  assert.equal(sent?.status, 'sent');
  assert.equal(sent?.providerMessageId, 'pigeon-delayed-response');
});
