# agent-broker

> **Status: experimental, work in progress.** I built this for my own
> multi-agent setup and share it as-is. It runs my system today, but parts
> of it are unfinished (see [Status](#status) and [Roadmap](#roadmap)) and it
> may change without notice. **Forks are welcome; support is not offered.**
> Issues are turned off and pull requests may not be reviewed. If it is
> useful to you, fork it and make it yours.

A tiny Cloudflare Worker that lets several AI agents share one task queue in
Notion without each of them burning tokens checking an empty queue.

## The problem

If you run more than one AI agent (say a chat assistant, a coding agent and a
personal agent) and coordinate them through a shared Notion task database,
each agent has to keep checking that database for work. A check means waking
a full agent session, and most of a session's tokens go to re-reading context,
so even an empty check costs almost as much as real work. Agents also have no
direct way to message each other: they can only write rows and hope the other
side's next poll notices.

## What it does

One Worker, two jobs:

1. **Queue watcher (cron, every 5 minutes).** Plain code, zero AI tokens.
   It queries the Notion queue for rows with `Status = Queued`, groups them
   by `Owner`, and drops a "work waiting" note into each owner's inbox.
2. **Inboxes (HTTP).** Every agent has an inbox in Cloudflare KV. Agents
   check theirs with one cheap request and only wake a real session when
   there is mail. Any agent holding the key can also message any other agent
   directly.

```
Notion queue  --(watcher, every 5 min)-->  KV inboxes  <--(cheap peek)--  agents
 (source of truth)                          inbox:<agent>:*                wake only on mail
```

Notion stays the source of truth for tasks and their state. The broker never
writes to Notion; it only reads queued rows and tells the right agent. Agents
claim and update rows themselves, following a small protocol
([docs/protocol.md](docs/protocol.md)).

The whole thing fits in Cloudflare's free tier.

## Status

| Piece | State |
|---|---|
| Inboxes, auth, watcher, GitHub Actions deploy | Working |
| First agent consumer (a secret-less polling hook that wakes a session) | Working, being moved to the `/peek` route |
| Second agent consumer (an always-on desktop coding-agent session) | Not built yet |
| Per-agent keys | Not built; one shared key today |
| Tests | A syntax check, a small `/peek` unit test (`node --test 'test/**/*.test.mjs'`), and a post-deploy smoke test |

## How it works with Notion

The watcher reads four properties from your queue database. Everything else
in the database is up to you.

| Property | Notion type | Used for |
|---|---|---|
| `Task` | Title | Shown in the inbox note |
| `Status` | **Select** (not Notion's built-in *Status* type) | Watcher looks for the option `Queued` |
| `Owner` | Select | Which inbox gets the note. Lowercased, so `Claude` goes to inbox `claude` |
| `Priority` | Select (optional) | Shown in the inbox note |

Rows with no `Owner` are skipped. Each queued row is announced once; if it
leaves `Queued` and comes back, it is announced again.

The minimal protocol for how agents claim and finish rows, plus the full set
of suggested properties, is in [docs/protocol.md](docs/protocol.md).

## Setup

Two ways in, covering the same steps (Notion queue, Notion integration,
Cloudflare account and KV, deploy, secrets, test, connect agents):

- **Do it yourself:** [docs/setup.md](docs/setup.md), a click-by-click
  walkthrough assuming no Cloudflare experience, with a troubleshooting
  table. About 30–45 minutes.
- **Have your agent do it:** point your coding or computer-use agent at
  [AGENTS.md](AGENTS.md). It gives the agent the full context, a resumable
  step-by-step procedure with verification checks, and explicit stop points.
  The agent asks before creating or deploying anything, and leaves logins,
  API tokens and secret values to you.

The short version, if you've done this before:

1. Fork. Create the Notion database (schema above) and an internal
   integration with read access, connected to it.
2. Create a KV namespace and put its id in `wrangler.toml`.
3. Deploy with `npx wrangler@4 deploy`, or via GitHub Actions with repo
   secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and optionally
   `BROKER_URL` (enables the post-deploy smoke test).
4. Set Worker secrets `NOTION_TOKEN`, `QUEUE_DB` (the database id) and
   `BROKER_KEY` (a long random string). Without `BROKER_KEY` every route is
   open; only do that for local testing.
5. `curl <url>/health`, then test with a queued row and
   `POST /watcher/run-now`.

For local development, put the secrets in a `.dev.vars` file (gitignored)
and run `npx wrangler@4 dev`.

## API

All responses are JSON. Routes marked **key** need the header
`x-broker-key: <BROKER_KEY>`; without it they return `401`.

| Method | Route | Auth | Returns |
|---|---|---|---|
| GET | `/health` | open | `{ok, ts}` |
| GET | `/inbox/:agent/peek` | open | `{ok, agent, count}`: `count` is 1 if mail is pending, else 0 (read from a per-agent flag, no list); no contents |
| GET | `/inbox/:agent?limit=50` | key | `{ok, agent, count, messages[]}`, oldest first |
| POST | `/inbox/:agent` | key | Body `{from, type, text}` → `{ok, id}` |
| POST | `/inbox/:agent/ack` | key | Body `{ids: [...]}` deletes those messages → `{ok, acked}` |
| GET | `/watcher` | key | Summary of the last watcher run |
| POST | `/watcher/run-now` | key | Runs the watcher immediately |

Agent names are lowercased letters, digits, `-` and `_`. Message text is
capped at 4,000 characters, and messages expire after 7 days.

## Connecting an agent

Each agent runs the same loop, at most every 5 minutes:

```
peek = GET /inbox/<me>/peek              # open, no key, no tokens spent
if peek.count == 0: do nothing
else: start a real session, which holds the key:
      GET  /inbox/<me>         (x-broker-key)   -> messages
      ... do the work, following docs/protocol.md ...
      POST /inbox/<me>/ack     (x-broker-key)   {ids: [...]}
```

The split matters: the cheap detector (a cron job, a hook, a shell loop) can
run without holding any secret, because `/peek` reveals only a count. Only
the session that does the work needs the key.

## Limits

Be aware of these before relying on it:

- **Polling, not push.** Expect minutes of latency, not seconds. Fine for
  queue work, wrong for anything interactive.
- **KV free-tier budget.** `/peek` reads a per-agent `pending:<agent>` flag
  (one KV *get*, no list), set on post and cleared by an ack that leaves the
  inbox empty, so pollers no longer consume the free tier's list-operation
  cap (1,000/day when this was written). Inbox reads and acks still cost one
  list each, which is fine because they are rare. `/peek` `count` is 0 or 1,
  not a true message count.
- **One shared key.** Every agent holds the same `BROKER_KEY`, so any agent
  can read any inbox. Fine for agents you trust equally; not a permission
  model.
- **Watcher reads, never writes.** It can't tell whether an agent actually
  picked up the work. Stuck or stale rows are handled by the protocol, not
  the broker.
- **Fixed Notion schema.** Property names (`Task`, `Status`, `Owner`,
  `Priority`) and the `Queued` option are hard-coded in `src/index.js`.
- **Pinned Notion API.** Uses the database query endpoint with Notion API
  version `2022-06-28`. Newer Notion API versions change how databases are
  queried, so this may need updating.
- **`workers.dev` reachability.** Some networks, including agents that run
  behind Cloudflare's own egress, can't reach `*.workers.dev` URLs
  (Cloudflare error 1042). Put the Worker on a custom domain or behind a
  plain forwarding proxy for those agents. The proxy must pass
  `x-broker-key` through and never hold the key itself.
- **First-100 rows.** The watcher reads one page (100 rows) of queued work
  per run.

## Roadmap

Roughly in the order I expect to get to them:

- Second agent consumer: an always-on desktop coding-agent session reading
  its inbox, replacing that agent's scheduled polling.
- Per-agent keys, so an agent can only read its own inbox.
- `since` parameter on inbox reads for incremental fetching.
- Configurable Notion property names, so the schema isn't hard-coded.
- More agents (other vendors' CLIs and hosted agents) once the first two are
  proven.

## Repo layout

| Path | What |
|---|---|
| `src/index.js` | The whole Worker: routes, auth, watcher. Plain JavaScript, no build step |
| `wrangler.toml` | Worker name, KV binding, cron |
| `.github/workflows/deploy.yml` | Syntax check on PRs; deploy and smoke test on `main` |
| `docs/setup.md` | Step-by-step setup for people |
| `AGENTS.md` | Setup and working instructions for an AI agent acting for you |
| `docs/protocol.md` | The minimal queue protocol agents follow |
| `DESIGN.md` | Why it is built this way, failure modes, lessons learned |

## License

[MIT](LICENSE).
