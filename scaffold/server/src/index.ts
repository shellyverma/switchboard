import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  finishLogin,
  getAuthenticatedUser,
  getMembership,
  startLogin,
} from './auth.js';
import { config } from './config.js';
import {
  claimConversation,
  getConversationMessages,
  InvalidConversationCursorError,
  listConversations,
  setConversationStatus,
} from './conversations.js';
import { handlePigeonWebhook } from './pigeonWebhook.js';

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post(
  '/webhooks/pigeon',
  express.raw({ type: 'application/json', limit: '1mb', inflate: false }),
  (req, res) => {
    void handlePigeonWebhook(req, res);
  },
);

app.use(express.json({ limit: '1mb' }));

app.get('/auth/login', asyncRoute(startLogin));
app.get('/auth/callback', asyncRoute(finishLogin));

app.get(
  '/api/me',
  asyncRoute(async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.sendStatus(401);
      return;
    }
    res.json(user);
  }),
);

app.get(
  '/api/conversations',
  asyncRoute(async (req, res) => {
    const workspace = queryString(req.query.workspace);
    if (!workspace) {
      res.status(400).json({ error: 'workspace is required' });
      return;
    }
    if (!(await authorizeWorkspace(req, res, workspace))) return;

    if (Array.isArray(req.query.limit) || Array.isArray(req.query.cursor)) {
      res.status(400).json({ error: 'invalid pagination parameters' });
      return;
    }
    const limitValue = queryString(req.query.limit);
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    const cursor = queryString(req.query.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: 'invalid pagination parameters' });
      return;
    }

    try {
      res.json(await listConversations(workspace, limit, cursor));
    } catch (error) {
      if (error instanceof InvalidConversationCursorError) {
        res.status(400).json({ error: 'invalid conversation cursor' });
        return;
      }
      throw error;
    }
  }),
);

app.get(
  '/api/conversations/:contact/messages',
  asyncRoute(async (req, res) => {
    const workspace = queryString(req.query.workspace);
    if (!workspace) {
      res.status(400).json({ error: 'workspace is required' });
      return;
    }
    if (!(await authorizeWorkspace(req, res, workspace))) return;

    const result = await getConversationMessages(workspace, req.params.contact);
    if (!result) {
      res.sendStatus(404);
      return;
    }
    res.json(result);
  }),
);

app.post(
  '/api/conversations/:contact/claim',
  asyncRoute(async (req, res) => {
    const workspace = queryString(req.query.workspace);
    if (!workspace) {
      res.status(400).json({ error: 'workspace is required' });
      return;
    }
    const user = await authorizeWorkspace(req, res, workspace);
    if (!user) return;

    const result = await claimConversation(workspace, req.params.contact, user.sub);
    if (!result.claimed) {
      res.status(409).json({
        error: 'conversation is already claimed',
        assignee: result.conversation.assignee,
      });
      return;
    }
    res.json(result.conversation);
  }),
);

for (const [action, status] of [
  ['close', 'closed'],
  ['reopen', 'open'],
] as const) {
  app.post(
    `/api/conversations/:contact/${action}`,
    asyncRoute(async (req, res) => {
      const workspace = queryString(req.query.workspace);
      if (!workspace) {
        res.status(400).json({ error: 'workspace is required' });
        return;
      }
      if (!(await authorizeWorkspace(req, res, workspace))) return;

      const conversation = await setConversationStatus(workspace, req.params.contact, status);
      if (!conversation) {
        res.sendStatus(404);
        return;
      }
      res.json(conversation);
    }),
  );
}

app.post(
  '/__grader/claim',
  asyncRoute(async (req, res) => {
    if (!isValidGraderToken(req.get('x-grader-token'))) {
      res.sendStatus(401);
      return;
    }
    const { workspace, contact, agent } = req.body ?? {};
    if (
      typeof workspace !== 'string' ||
      typeof contact !== 'string' ||
      typeof agent !== 'string' ||
      !contact ||
      !agent
    ) {
      res.status(400).json({ error: 'workspace, contact, and agent are required' });
      return;
    }
    if (!Object.hasOwn(config.pigeon.apiKeys, workspace)) {
      res.status(400).json({ error: 'unknown workspace' });
      return;
    }

    const result = await claimConversation(workspace, contact, agent);
    if (!result.claimed) {
      res.status(409).json({ error: 'conversation is already claimed' });
      return;
    }
    res.json(result.conversation);
  }),
);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    isRecord(error) &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : 503;
  if (status === 503) console.error('Request failed', error);
  if (!res.headersSent) res.sendStatus(status);
});

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

async function authorizeWorkspace(
  req: Request,
  res: Response,
  workspace: string,
): Promise<Awaited<ReturnType<typeof getAuthenticatedUser>> | undefined> {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    res.sendStatus(401);
    return undefined;
  }
  if (!getMembership(user, workspace)) {
    res.sendStatus(403);
    return undefined;
  }
  return user;
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isValidGraderToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(config.graderToken);
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
