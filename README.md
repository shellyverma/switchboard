# Switchboard

Switchboard is a workspace-isolated shared inbox for customer conversations.
Agents sign in through the mock OpenID Connect provider, read and claim
conversations, reply through Pigeon, and receive live updates over WebSockets.

## Run locally

Requirements: Node.js 22+ and Docker.

```sh
cp .env.example .env
npm run up
npm run scaffold:install
```

In separate terminals, start the API and web app:

```sh
npm run scaffold:server
npm run scaffold:web
```

Open <http://localhost:5173>. Select a test user on the identity-provider
screen. The local defaults in `.env.example` match the services started by
`npm run up`.

## Verify

```sh
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
```

The assessment harness also provides `npm run check` and `npm run check:full`.
These start the server themselves and reset the application and Pigeon data;
stop any development server and preserve any data you need before running
them. Restart Pigeon's customer-message trickle afterward with `npm run drizzle`.

## Implementation

- `scaffold/server/src/` contains OIDC auth, tenant-scoped conversation APIs,
  webhook handling, the durable outbound queue, grader endpoints, and the
  Redis-backed realtime event stream.
- `scaffold/web/src/` contains the React agent inbox.
- `scaffold/server/test/` contains server integration tests using the local
  MongoDB and Redis services.

Optional search, encrypted private notes, and billing are not implemented.
