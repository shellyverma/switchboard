# Decisions

Switchboard uses the provided Express/TypeScript and React/Vite scaffold.
MongoDB stores conversations, inbound events/messages, and durable outbound
replies. Redis stores OIDC sessions, workspace event streams and deduplication
keys, and shared Pigeon rate-limit state. WebSocket clients authenticate with
the same session cookie and workspace membership as the HTTP API; event
sequences and replay are scoped per workspace.

The implementation focuses on the mandatory inbox, webhook, reply, grader,
login, and realtime requirements. Search, encrypted private notes, and billing
were cut as optional work. Replies use Pigeon idempotency keys and durable
MongoDB leases; Redis Pub/Sub notifies other server copies while the stream
provides replay.

Server typecheck and all 14 server tests pass. The web typecheck and production
build pass, and the browser flow was verified through OIDC login and inbox
loading. The public full assessment passed 75/75 across Levels 1, 2, 3, and 5;
Level 4 is private and was not run. Its check resets application and Pigeon
data, so preserve any data before running it again.

Known limitation: the browser keeps its last WebSocket sequence in memory, so
a page reload starts a fresh live stream; the initial inbox and thread are
reloaded from the database. The required AI transcript exports have not been
added; export the original sessions into `ai-logs/` before submission. No
transcripts were reconstructed or edited.
