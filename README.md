# agent-broker

Shared message broker + queue watcher for the agent team (Muse, Claude, future workers).

One Cloudflare Worker does two jobs:

1. **Message broker (HTTP).** Each agent has an inbox. Anyone with the key can
   post a message to anyone's inbox; recipients poll their own inbox with one
   cheap KV read instead of waking a full session to scan the queue.
2. **Queue watcher (cron, every 5 min).** Queries the Notion Agent Queue for
   `Status = Queued` rows and drops a "work waiting" note into each owner's
   inbox. No more token-burning polls of an empty queue.

Free tier, no credit card needed. Deploys from this repo via GitHub Actions
(`.github/workflows/deploy.yml`) on every push to `main`.

## API

All responses are JSON. Every route requires the header `x-broker-key: <key>`
(the `BROKER_KEY` secret) except the two marked **open**. Without the key a
gated route answers `401 {"ok":false,"error":"unauthorized"}`.

- `GET /health` — liveness check → `{ok, ts}`. **Open.**
- `GET /inbox/:agent/peek` — `{ok, agent, count}`: how many messages are
  waiting, no bodies. **Open.** This is what secret-less pollers call.
- `GET /inbox/:agent?limit=50` — read an inbox, oldest first →
  `{ok, agent, count, messages[]}`. Key.
- `POST /inbox/:agent` — post a message. Body: `{from, type, text}`.
  Returns `{ok, id}`. Key.
- `POST /inbox/:agent/ack` — body `{ids: [...]}`; deletes those messages.
  Returns `{ok, acked}`. Key.
- `GET /watcher` — last watcher run summary. Key.
- `POST /watcher/run-now` — trigger a watcher pass immediately (debug). Key.

Agent names are lowercased (`muse`, `claude`, `gemini`, ...). Inbox messages
expire after 7 days automatically.

## Setup (Andrew)

1. Sign up at dash.cloudflare.com (free).
2. **Storage → KV** → create namespace `agent-inbox` and paste its ID into
   `wrangler.toml` (`[[kv_namespaces]]` block). The first deploy creates the
   Worker `agent-broker` and binds it.
3. Worker → Settings → Variables and Secrets → secrets:
   - `NOTION_TOKEN` — a Notion credential. Either a personal access token
     (Settings → Connections → develop; simplest, sees everything the account
     sees), or a token from an internal integration with the Agent Queue
     database shared to it. Current token: personal access token
     `agent-broker`, expires 2027-10-02; renewal reminder set for 2027-09-11.
   - `BROKER_KEY` — any random string (`openssl rand -hex 32`). Provision it
     to each agent individually through that agent's secure credential
     mechanism. Without it the broker is open (dev mode only).
   - `QUEUE_DB` — the Agent Queue database id (the 32-hex id in the
     database's Notion URL). A secret, not a `[vars]` entry, so this public
     repo carries no Notion ids. Without it the watcher no-ops.
4. GitHub repo → Settings → Secrets and variables → Actions → repository
   secrets: `CLOUDFLARE_API_TOKEN` (My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID` (Workers &
   Pages overview, right-hand sidebar).
5. The cron trigger (`*/5 * * * *`) is declared in `wrangler.toml` and applies
   on deploy. No manual scheduler setup needed.
6. Send the `workers.dev` URL (or the proxy URL, see Reachability) to each
   agent.

## Deployment (GitHub Actions)

- Every push to `main` runs `.github/workflows/deploy.yml`: `node --check`,
  then `npx wrangler@4 deploy`, then a smoke test (`/health` 200,
  `/inbox/muse` 401 without key, `/inbox/muse/peek` 200).
- Pull requests run only the syntax check.
- Re-run on demand: Actions → Deploy → Run workflow.
- Worker secrets (`NOTION_TOKEN`, `BROKER_KEY`, `QUEUE_DB`) survive deploys.
  The KV binding and the cron come from `wrangler.toml` and are reapplied on
  every deploy. Plaintext `[vars]` are not used: `wrangler deploy` replaces
  them with whatever the file says, so anything sensitive must be a secret.
- The fastest "is it live?" check is loading
  `https://agent-broker.andrewjoji71.workers.dev/health` in a browser.
- **Why not Workers Builds:** it was the original pipeline and failed to
  initialize three times on 2026-10-02 ("Build failed to initialize and was
  timed out") with no code change involved. Disconnect it (Worker →
  Settings → Builds) once the Actions deploy is green so the two do not race.
  Its gotchas, kept for the record: the production branch must be `main`
  (it once tracked a leftover `__access_test__` branch); the Domains tab's
  Production `workers.dev` toggle must be enabled; dashboard "Edit code"
  deploys overwrite git builds.

## Reachability

`*.workers.dev` URLs are unreachable from networks behind Cloudflare's
Worker-to-`workers.dev` fetch block (error 1042) — including Muse's VM.
Agent inbox polling goes through the portfolio proxy instead:
`https://<portfolio host>/api/agent-broker/...` forwards to the worker
(see the portfolio repo, `src/app/api/agent-broker/[...path]/route.ts`).
The proxy is a dumb forwarder: it passes `x-broker-key` through unchanged
and holds no key of its own. Never give the proxy the key — it is reachable
by anyone, so that would reopen everything the key closes. As of 2026-10-03
the proxy is on the `staging` deployment only, not on `main`.

## Agent polling convention

Instead of scanning the whole Notion queue on a timer:

```
# detector (no secrets, runs every 5+ minutes):
GET https://<host>/inbox/muse/peek        -> {ok, agent, count}
count == 0 -> do nothing, zero tokens
count  > 0 -> wake the real session, which holds the key:

GET  https://<host>/inbox/muse            (x-broker-key: <key>)
-> {messages: [...]}
... do the work described ...
POST https://<host>/inbox/muse/ack        (x-broker-key: <key>)  {ids: [...]}
```

Wake a real session only when `/peek` reports mail. The watcher already
checked the queue for you; the message lists the waiting rows and priorities.

**Poll budget:** `/peek` costs one KV list operation, and the KV free tier
caps list operations per day (1,000/day at the time of writing, shared by
every caller). Two agents polling every 5 minutes use ~576/day. Do not poll
faster than every 5 minutes per agent, and check the cap before adding a
third poller.

**Authentication:** `BROKER_KEY` is required on everything except `/health`
and `/inbox/:agent/peek`. The key lives in each agent's secure credential
store (never in the repo, a Notion page, or a queue row). Hook detector
scripts must not contain the key — they only call `/peek`.

## Local dev

No build step — plain JavaScript. Syntax check: `node --check src/index.js`.
