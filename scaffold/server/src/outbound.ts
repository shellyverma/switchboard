import { randomUUID } from 'node:crypto';
import type { Document } from 'mongodb';
import { config } from './config.js';
import { ensureConversation } from './conversations.js';
import { getDb } from './db.js';
import { publishWorkspaceEvent } from './realtime.js';
import { getRedis } from './redis.js';

type ReplyInput = {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
};

const workerId = randomUUID();
const leaseDurationMs = 30_000;
const requestTimeoutMs = 20_000;
const workerConcurrency = 4;
const rateLimitCapacity = 8;
const rateLimitRefillPerSecond = 4;
const retryAfterMarginMs = 100;
let indexesReady: Promise<void> | undefined;
let workerStarted = false;

const takeRateLimitTokenScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2]) / 1000
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt', 'blockedUntil')
local tokens = tonumber(values[1]) or capacity
local updatedAt = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updatedAt) * refillPerMs)
local blockedUntil = tonumber(values[3]) or 0

if blockedUntil > now then
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', KEYS[1], 3600000)
  return {0, math.ceil(blockedUntil - now)}
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', KEYS[1], 3600000)
  return {1, 0}
end

redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], 3600000)
return {0, math.ceil((1 - tokens) / refillPerMs)}
`;

const setRateLimitCooldownScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local requestedUntil = now + tonumber(ARGV[1])
local blockedUntil = tonumber(redis.call('HGET', KEYS[1], 'blockedUntil')) or 0
if requestedUntil > blockedUntil then
  redis.call('HSET', KEYS[1], 'blockedUntil', requestedUntil)
end
redis.call('PEXPIRE', KEYS[1], 3600000)
return 1
`;

export async function ensureOutboundIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection('outbound_messages').createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true, name: 'workspace_client_ref_unique' },
        ),
        db.collection('outbound_messages').createIndex(
          { status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 },
          { name: 'outbound_queue_ready' },
        ),
        db.collection('outbound_messages').createIndex(
          { workspace: 1, contact: 1, occurredAt: 1, clientRef: 1 },
          { name: 'workspace_contact_outbound_order' },
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

export async function enqueueReply(input: ReplyInput): Promise<Document> {
  if (!Object.hasOwn(config.pigeon.apiKeys, input.workspace)) {
    throw new Error(`Unknown Pigeon workspace: ${input.workspace}`);
  }
  await ensureOutboundIndexes();
  const now = new Date();
  await ensureConversation(input.workspace, input.contact, now);

  const collection = (await getDb()).collection('outbound_messages');
  const filter = { workspace: input.workspace, clientRef: input.clientRef };
  const reply = {
    ...filter,
    contact: input.contact,
    text: input.text,
    status: 'queued',
    attempts: 0,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  };

  let stored: Document | null = null;
  try {
    await collection.updateOne(filter, { $setOnInsert: reply }, { upsert: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    stored = await collection.findOne(filter);
    if (!stored) throw error;
  }

  stored ??= await collection.findOne(filter);
  if (!stored) throw new Error('Reply was not persisted');
  await publishWorkspaceEvent(input.workspace, `outbound:${input.clientRef}`, {
    type: 'message.outbound',
    contact: input.contact,
    client_ref: input.clientRef,
    status: String(stored['status']),
  });
  return stored;
}

export async function processNextReply(fetcher: typeof fetch = fetch): Promise<boolean> {
  await ensureOutboundIndexes();
  const collection = (await getDb()).collection('outbound_messages');
  const now = new Date();
  const leaseOwner = workerId;
  const job = await collection.findOneAndUpdate(
    {
      status: 'queued',
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    {
      $set: {
        leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseDurationMs),
        updatedAt: now,
      },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!job) return false;

  const workspace = String(job.workspace);
  const clientRef = String(job.clientRef);
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) {
    await markPermanentlyFailed(collection, job, leaseOwner, 'Unknown Pigeon workspace');
    return true;
  }

  const permit = await takeRateLimitToken(workspace);
  if (!permit.granted) {
    await deferReply(collection, job, leaseOwner, permit.delayMs + retryAfterMarginMs, 'Workspace send rate limit');
    return true;
  }

  const attempt = Number(job.attempts ?? 0) + 1;
  const attemptUpdate = await collection.updateOne(
    { _id: job._id, leaseOwner },
    { $inc: { attempts: 1 }, $set: { lastAttemptAt: new Date() } },
  );
  if (attemptUpdate.matchedCount !== 1) return true;

  let response: Response;
  try {
    response = await fetcher(new URL('/v1/messages', config.pigeon.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': clientRef,
      },
      body: JSON.stringify({
        to: job.contact,
        text: job.text,
        client_ref: clientRef,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    await deferReply(collection, job, leaseOwner, retryDelay(attempt), errorMessage(error));
    return true;
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after')) ?? 2_000;
    const delayMs = retryAfter + retryAfterMarginMs;
    await setRateLimitCooldown(workspace, delayMs);
    await deferReply(collection, job, leaseOwner, delayMs, 'Pigeon rate limit');
    return true;
  }

  if (response.status === 408 || response.status >= 500) {
    const delayMs =
      parseRetryAfter(response.headers.get('retry-after')) ?? retryDelay(attempt);
    await deferReply(collection, job, leaseOwner, delayMs, `Pigeon returned HTTP ${response.status}`);
    return true;
  }

  if (!response.ok) {
    await markPermanentlyFailed(
      collection,
      job,
      leaseOwner,
      `Pigeon rejected reply with HTTP ${response.status}`,
    );
    return true;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    await deferReply(collection, job, leaseOwner, retryDelay(attempt), 'Invalid Pigeon response');
    return true;
  }

  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    payload.status !== 'accepted'
  ) {
    await deferReply(collection, job, leaseOwner, retryDelay(attempt), 'Invalid Pigeon response');
    return true;
  }

  await markAccepted(collection, job, leaseOwner, payload.id);
  return true;
}

export async function startReplyWorker(): Promise<void> {
  if (workerStarted) return;
  await ensureOutboundIndexes();
  await getRedis().ping();
  workerStarted = true;

  let activeWorkers = 0;
  const poll = () => {
    while (activeWorkers < workerConcurrency) {
      activeWorkers += 1;
      void processNextReply()
        .catch((error: unknown) => {
          console.error('Outbound reply worker failed', error);
        })
        .finally(() => {
          activeWorkers -= 1;
        });
    }
  };
  setInterval(poll, 200);
  poll();
}

async function takeRateLimitToken(
  workspace: string,
): Promise<{ granted: boolean; delayMs: number }> {
  const result = await getRedis().eval(
    takeRateLimitTokenScript,
    1,
    rateLimitKey(workspace),
    String(rateLimitCapacity),
    String(rateLimitRefillPerSecond),
  );
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error('Unexpected Redis rate-limit response');
  }
  return { granted: Number(result[0]) === 1, delayMs: Math.max(0, Number(result[1])) };
}

async function setRateLimitCooldown(workspace: string, delayMs: number): Promise<void> {
  await getRedis().eval(
    setRateLimitCooldownScript,
    1,
    rateLimitKey(workspace),
    String(delayMs),
  );
}

function rateLimitKey(workspace: string): string {
  return `switchboard:pigeon:rate-limit:${encodeURIComponent(workspace)}`;
}

async function deferReply(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  job: Document,
  leaseOwner: string,
  delayMs: number,
  reason: string,
): Promise<void> {
  await collection.updateOne(
    { _id: job._id, leaseOwner },
    {
      $set: {
        nextAttemptAt: new Date(Date.now() + Math.max(0, delayMs)),
        lastError: reason.slice(0, 500),
        updatedAt: new Date(),
      },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
}

async function markAccepted(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  job: Document,
  leaseOwner: string,
  providerMessageId: string,
): Promise<void> {
  const now = new Date();
  await collection.updateOne(
    { _id: job._id, leaseOwner },
    [
      {
        $set: {
          status: {
            $cond: [{ $in: ['$status', ['delivered', 'failed']] }, '$status', 'sent'],
          },
          providerMessageId: { $ifNull: ['$providerMessageId', providerMessageId] },
          sentAt: { $ifNull: ['$sentAt', now] },
          updatedAt: now,
        },
      },
      { $unset: ['leaseOwner', 'leaseUntil', 'nextAttemptAt', 'lastError'] },
    ],
  );
  await publishCurrentReplyStatus(collection, job);
}

async function markPermanentlyFailed(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  job: Document,
  leaseOwner: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await collection.updateOne(
    { _id: job._id, leaseOwner },
    [
      {
        $set: {
          status: {
            $cond: [{ $in: ['$status', ['delivered', 'failed']] }, '$status', 'failed'],
          },
          lastError: reason.slice(0, 500),
          failedAt: now,
          updatedAt: now,
        },
      },
      { $unset: ['leaseOwner', 'leaseUntil', 'nextAttemptAt'] },
    ],
  );
  await publishCurrentReplyStatus(collection, job);
}

async function publishCurrentReplyStatus(
  collection: ReturnType<Awaited<ReturnType<typeof getDb>>['collection']>,
  job: Document,
): Promise<void> {
  const reply = await collection.findOne(
    { _id: job._id },
    {
      projection: {
        workspace: 1,
        contact: 1,
        clientRef: 1,
        status: 1,
        statusAt: 1,
        sentAt: 1,
        failedAt: 1,
      },
    },
  );
  if (
    !reply ||
    (reply['status'] !== 'sent' &&
      reply['status'] !== 'delivered' &&
      reply['status'] !== 'failed')
  ) {
    return;
  }
  const statusAt = [reply['statusAt'], reply['sentAt'], reply['failedAt']].find(
    (value): value is Date => value instanceof Date,
  );
  await publishWorkspaceEvent(
    String(reply['workspace']),
    `status:${String(reply['clientRef'])}:${reply['status']}`,
    {
      type: 'message.status',
      contact: String(reply['contact']),
      client_ref: String(reply['clientRef']),
      status: reply['status'],
      ...(statusAt ? { status_at: statusAt.toISOString() } : {}),
    },
  );
}

function retryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isDuplicateKeyError(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Pigeon request failed';
}
