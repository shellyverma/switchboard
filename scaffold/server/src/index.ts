import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
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

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});
