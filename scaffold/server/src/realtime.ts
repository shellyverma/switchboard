import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { getAuthenticatedUserFromCookie, getMembership } from './auth.js';
import { getRedis } from './redis.js';

export type WorkspaceEvent = {
  workspace: string;
  seq: number;
  type: string;
  [key: string]: unknown;
};

type EventPayload = {
  type: string;
  [key: string]: unknown;
};

type SocketSubscription = {
  workspace: string;
  socket: WebSocket;
  lastSeq: number;
  replaying: boolean;
  pumping: boolean;
  pending: boolean;
};

const eventChannel = 'switchboard:events:bus';
const pageSize = 100;
const appendEventScript = `
local existing = redis.call('HGET', KEYS[3], ARGV[1])
if existing then
  redis.call('PUBLISH', KEYS[4], existing)
  return cjson.decode(existing).seq
end

local seq = redis.call('INCR', KEYS[1])
local event = cjson.decode(ARGV[2])
event.seq = seq
local encoded = cjson.encode(event)
redis.call('XADD', KEYS[2], tostring(seq) .. '-0', 'event', encoded)
redis.call('HSET', KEYS[3], ARGV[1], encoded)
redis.call('PUBLISH', KEYS[4], encoded)
return seq
`;

const subscriptions = new Map<string, Set<SocketSubscription>>();
let realtimeStarted = false;

export async function publishWorkspaceEvent(
  workspace: string,
  eventId: string,
  payload: EventPayload,
  redis: Redis = getRedis(),
): Promise<number> {
  const keys = workspaceEventKeys(workspace);
  const seq = await redis.eval(
    appendEventScript,
    4,
    keys.sequence,
    keys.stream,
    keys.dedupe,
    eventChannel,
    eventId,
    JSON.stringify({ ...payload, workspace }),
  );
  const sequence = Number(seq);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Redis returned an invalid workspace event sequence');
  }
  return sequence;
}

export async function readWorkspaceEvents(
  workspace: string,
  after: number,
  redis: Redis = getRedis(),
): Promise<WorkspaceEvent[]> {
  const entries = await redis.xrange(
    workspaceEventKeys(workspace).stream,
    `(${after}-0`,
    '+',
    'COUNT',
    String(pageSize),
  );
  return entries.map(([, fields]) => {
    const eventIndex = fields.indexOf('event');
    if (eventIndex < 0 || typeof fields[eventIndex + 1] !== 'string') {
      throw new Error('Workspace event stream entry is malformed');
    }
    return parseWorkspaceEvent(fields[eventIndex + 1]);
  });
}

export async function latestWorkspaceSequence(
  workspace: string,
  redis: Redis = getRedis(),
): Promise<number> {
  const value = await redis.get(workspaceEventKeys(workspace).sequence);
  const sequence = value === null ? 0 : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Workspace event sequence is invalid');
  }
  return sequence;
}

export async function attachRealtime(server: Server): Promise<void> {
  if (realtimeStarted) return;
  const subscriber = getRedis().duplicate();
  subscriber.on('message', (_channel, message) => {
    try {
      const event = parseWorkspaceEvent(message);
      for (const subscription of subscriptions.get(event.workspace) ?? []) {
        if (event.seq <= subscription.lastSeq) continue;
        subscription.pending = true;
        if (!subscription.replaying) void drainEvents(subscription);
      }
    } catch (error) {
      console.error('Invalid realtime event notification', error);
    }
  });
  await subscriber.subscribe(eventChannel);

  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketPath(request)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    void authenticateUpgrade(request)
      .then((result) => {
        if (!result.ok) {
          rejectUpgrade(socket, result.status, result.message);
          return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          const subscription: SocketSubscription = {
            workspace: result.workspace,
            socket: webSocket,
            lastSeq: result.after ?? 0,
            replaying: true,
            pumping: false,
            pending: false,
          };
          addSubscription(subscription);
          webSocket.on('close', () => removeSubscription(subscription));
          webSocket.on('error', () => removeSubscription(subscription));
          void initializeSubscription(subscription, result.after).catch((error: unknown) => {
            console.error('Failed to initialize realtime subscription', error);
            webSocket.close(1011, 'Realtime subscription failed');
          });
        });
      })
      .catch((error: unknown) => {
        console.error('WebSocket upgrade failed', error);
        rejectUpgrade(socket, 503, 'Service Unavailable');
      });
  });

  setInterval(() => {
    for (const workspaceSubscriptions of subscriptions.values()) {
      for (const subscription of workspaceSubscriptions) {
        if (subscription.replaying) {
          subscription.pending = true;
        } else {
          void drainEvents(subscription);
        }
      }
    }
  }, 250);
  realtimeStarted = true;
}

async function authenticateUpgrade(
  request: IncomingMessage,
): Promise<
  | { ok: true; workspace: string; after?: number }
  | { ok: false; status: number; message: string }
> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const workspaces = url.searchParams.getAll('workspace');
  if (url.pathname !== '/ws' || workspaces.length !== 1 || !workspaces[0]) {
    return { ok: false, status: 400, message: 'Bad Request' };
  }

  const afterValues = url.searchParams.getAll('after');
  if (afterValues.length > 1) return { ok: false, status: 400, message: 'Bad Request' };
  let after: number | undefined;
  if (afterValues.length === 1) {
    if (!afterValues[0]) return { ok: false, status: 400, message: 'Bad Request' };
    after = Number(afterValues[0]);
    if (!Number.isSafeInteger(after) || after < 0) {
      return { ok: false, status: 400, message: 'Bad Request' };
    }
  }

  const user = await getAuthenticatedUserFromCookie(request.headers.cookie);
  if (!user) return { ok: false, status: 401, message: 'Unauthorized' };
  if (!getMembership(user, workspaces[0])) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }
  return { ok: true, workspace: workspaces[0], after };
}

function isWebSocketPath(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname === '/ws';
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function addSubscription(subscription: SocketSubscription): void {
  const workspaceSubscriptions = subscriptions.get(subscription.workspace) ?? new Set();
  workspaceSubscriptions.add(subscription);
  subscriptions.set(subscription.workspace, workspaceSubscriptions);
}

function removeSubscription(subscription: SocketSubscription): void {
  const workspaceSubscriptions = subscriptions.get(subscription.workspace);
  workspaceSubscriptions?.delete(subscription);
  if (workspaceSubscriptions?.size === 0) subscriptions.delete(subscription.workspace);
}

async function initializeSubscription(
  subscription: SocketSubscription,
  after: number | undefined,
): Promise<void> {
  if (after === undefined) {
    subscription.lastSeq = await latestWorkspaceSequence(subscription.workspace);
  }
  await drainEvents(subscription);
  subscription.replaying = false;
  if (subscription.pending) void drainEvents(subscription);
}

async function drainEvents(subscription: SocketSubscription): Promise<void> {
  if (subscription.pumping || subscription.socket.readyState !== WebSocket.OPEN) return;
  subscription.pumping = true;
  try {
    do {
      subscription.pending = false;
      const events = await readWorkspaceEvents(subscription.workspace, subscription.lastSeq);
      for (const event of events) {
        if (event.seq <= subscription.lastSeq) continue;
        if (subscription.socket.readyState !== WebSocket.OPEN) return;
        subscription.socket.send(JSON.stringify(event));
        subscription.lastSeq = event.seq;
      }
      if (events.length === pageSize) subscription.pending = true;
    } while (subscription.pending && subscription.socket.readyState === WebSocket.OPEN);
  } catch (error) {
    console.error('Failed to read realtime events', error);
    subscription.socket.close(1011, 'Realtime event read failed');
  } finally {
    subscription.pumping = false;
  }
}

function workspaceEventKeys(workspace: string): {
  sequence: string;
  stream: string;
  dedupe: string;
} {
  const encodedWorkspace = encodeURIComponent(workspace);
  const prefix = `switchboard:events:${encodedWorkspace}`;
  return {
    sequence: `${prefix}:seq`,
    stream: `${prefix}:stream`,
    dedupe: `${prefix}:dedupe`,
  };
}

function parseWorkspaceEvent(value: string): WorkspaceEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Workspace event is not valid JSON');
  }
  if (!isWorkspaceEvent(parsed)) {
    throw new Error('Workspace event shape is invalid');
  }
  return parsed;
}

function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('workspace' in value) ||
    typeof value.workspace !== 'string' ||
    !('seq' in value) ||
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    !('type' in value) ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  return true;
}
