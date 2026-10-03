# agent-broker

Shared message broker + queue watcher for the agent team (Muse, Claude, future workers).

One Cloudflare Worker does two jobs:

1. **Message broker (HTTP).** Each agent has an inbox. Anyone can post a message
   to anyone's inbox; recipients poll their own inbox with one cheap KV read
   instead of waking a full session to scan the queue.
2. **Queue watcher (cron, every 5 min).** Queries the Notion Agent Queue for
   `Status = Queued` rows and drops a "work waiting" note into each owner's
   inbox. No more token-burning polls of an empty queue.

Free tier, no credit card needed. Deploys automatically from this repo via the
Cloudflare GitHub integration.

## API

All responses are JSON. If the `BROKER_KEY` secret is set, every request must
carry the header `x-broker-key: <key>`.

- `GET /health` — liveness check → `{ok: true}`.
- `POST /inbox/:agent` — post a message. Body: `{from, type, text}`.
  Returns `{ok, id}`.
- `GET /inbox/:agent?limit=50` — read an inbox, oldest first.
- `POST /inbox/:agent/ack` — body `{ids: [...]}`; deletes those messages.
- `GET /watcher` — last watcher run summary.
- `POST /watcher/run-now` — trigger a watcher pass immediately (debug).

Agent names are lowercased (`muse`, `claude`, `gemini`, ...). Inbox messages
expire after 7 days automatically.

## Setup (Andrew)

1. Sign up at dash.cloudflare.com (free).
2. **Workers & Pages** → create Worker `agent-broker` → connect GitHub repo
   `AndrewJoji/agent-broker` so pushes auto-deploy.
3. **Storage → KV** → create namespace `agent-inbox`. Then either paste its ID
   into `wrangler.toml` (`[[kv_namespaces]]` block) and push, or bind it in the
   dashboard: Worker → Settings → Bindings → KV Namespace, variable `INBOX`.
   Use only one of the two.
4. Worker → Settings → Variables → secrets:
   - `NOTION_TOKEN` — a Notion credential. Either a personal access token
     (Settings → Connections → develop; simplest, sees everything the account
     sees), or a token from an internal integration with the Agent Queue
     database shared to it. Current token: personal access token
     `agent-broker`, expires 2027-10-02; renewal reminder set for 2027-09-11.
   - `BROKER_KEY` — any random string; share it with the agents via the secure
     vault. Optional; without it the broker is open.
5. The cron trigger (`*/5 * * * *`) is declared in `wrangler.toml` and applies
   on deploy. No manual scheduler setup needed.
6. Send the `workers.dev` URL to Muse.

## Deployment notes (Workers Builds)

- **Production branch:** Settings → Builds → Branch control must say `main`.
  (2026-10-02: it was tracking a leftover `__access_test__` branch, so pushes
  to `main` silently never deployed.)
- **Deploy command:** `npx wrangler deploy`. Build command: none (no build step).
- **Domains tab:** the Production `workers.dev` URL toggle must be enabled,
  or the URL serves nothing.
- Pushes to `main` auto-deploy. Watch progress at Workers & Pages →
  agent-broker → Deployments. The fastest "is it live?" check is loading
  `https://<worker>/health` in a browser — JSON means deployed.

## Reachability

`*.workers.dev` URLs are unreachable from networks behind Cloudflare's
Worker-to-`workers.dev` fetch block (error 1042) — including Muse's VM.
Agent inbox polling goes through the portfolio proxy instead:
`https://andrewjoji.com/api/agent-broker/...` forwards to the worker
(see the portfolio repo, `src/app/api/agent-broker/[...path]/route.ts`).

## Agent polling convention

Instead of scanning the whole Notion queue on a timer:

```
GET https://<worker>/inbox/muse          (header x-broker-key if set)
-> {messages: [...]}
... do the work described ...
POST https://<worker>/inbox/muse/ack     {ids: [...]}
```

Wake a real session only when the inbox is non-empty. The watcher already
checked the queue for you; the message lists the waiting rows and priorities.

## Local dev

No build step — plain JavaScript. Syntax check: `node --check src/index.js`.
