# agent-broker — Design & Specification

## 1. What problem this solves

The agent team (Muse, Claude, future workers) coordinates through a shared
Notion database, the Agent Queue. Two problems emerged:

1. **Idle burn.** Checking the queue for work required waking a full agent
   session every time, even when the queue was empty. Muse alone was running
   ~312 polling sessions a day (5-minute fast lane + hourly poll), and ~94%
   of an agent session's tokens are context re-reads, so even "lightweight"
   checks cost nearly a full session each.
2. **No direct messaging.** Agents had no way to talk to each other except by
   writing Notion rows and hoping the other agent's next poll noticed. Protocol
   changes, urgent nudges, and handoffs had no direct channel. Inbound network
   connections cannot reach Muse's VM (NAT/firewall), so agents cannot push to
   each other directly either.

The broker fixes both with one always-on Cloudflare Worker: a **watcher** that
checks the queue cheaply (plain code, zero AI tokens), and **inboxes** so
agents only wake when there is actually something for them, plus direct
agent-to-agent messages.

## 2. Architecture

```
                    ┌─────────────────────────────┐
                    │     Notion Agent Queue      │
                    │  tasks, state, checkpoints  │
                    │      (source of truth)      │
                    └──────────────┬──────────────┘
                                   │ query Status=Queued
                                   │ every 5 min (cron)
                    ┌──────────────▼──────────────┐
                    │   Cloudflare Worker         │
                    │   agent-broker              │
                    │                             │
                    │  ┌─────────┐  ┌───────────┐  │
                    │  │ Watcher │  │  Broker   │  │
                    │  │ (cron)  │  │  (HTTP)   │  │
                    │  └────┬────┘  └─────┬─────┘  │
                    │       │             │        │
                    │       └──────┬──────┘        │
                    │              ▼               │
                    │     KV: agent-inbox         │
                    │  inbox:muse:*               │
                    │  inbox:claude:*             │
                    │  inbox:<agent>:*  ...       │
                    └──────────────┬──────────────┘
                     ▲             │              ▲
                     │  GET        │  POST        │  tiny poll loop
                ┌────┴────┐   ┌────┴─────┐   ┌────┴──────┐
                │  Muse   │   │  Claude  │   │  Future   │
                │  hook:  │   │  inbox   │   │  workers  │
                │  check  │   │  check   │   │ (Gemini,  │
                │  inbox→ │   │  → work  │   │  Codex…)  │
                │  wake   │   │          │   │  check→   │
                │  only   │   │          │   │  run→ack  │
                │  on mail│   │          │   │           │
                └─────────┘   └──────────┘   └───────────┘
```

Data flow, end to end:

1. A task row lands in the Agent Queue (`Status=Queued`, `Owner=<agent>`).
2. Within 5 minutes the watcher's cron fires. It queries Notion for queued rows
   (one API call, no AI involved) and writes a "work waiting" note into each
   owner's inbox in KV.
3. Each agent checks **only its own inbox**:
   - Muse: a hook runs a tiny script (`GET /inbox/muse/peek`, no key) every
     5 minutes. Count 0 → stays silent, zero tokens. Count > 0 → wakes a Muse
     session, which reads the inbox with the key.
   - Future API-billed workers: an even tinier loop, `check inbox → run CLI
     if non-empty → ack`. Zero idle cost, no scheduler needed at all.
   - Claude: same inbox-check pattern on its side, replacing its polling
     schedule.
4. The agent does the work per the queue protocol (claim row, write Result /
   Checkpoint, set Done), then acks the inbox message.
5. Direct messages skip the queue entirely: `POST /inbox/claude
   {from:"muse", type:"protocol", text:"..."}`.

The old polling crons (Muse's 5-minute fast lane, hourly queue poll) are
deleted once this is live. The daily 6 AM Deal Finder scan stays — it does
real work every run.

## 3. Components

### 3.1 Message broker (HTTP)

One KV namespace, `agent-inbox`, bound as `INBOX`. Key scheme:

- `inbox:<agent>:<timestamp>-<rand>` → JSON message
- `watcher:notified` → `{rowId: timestamp}` (dedup state)
- `watcher:last-run` → last watcher summary (debug)

Message shape: `{id, from, type, text, ts}`. `text` capped at 4000 chars.
Messages expire after 7 days (TTL) so the namespace cannot grow unboundedly.

Routes (`src/index.js`):

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | open | liveness |
| GET | `/inbox/:agent/peek` | open | `{ok, agent, count}` — count only, no bodies |
| POST | `/inbox/:agent` | key | post `{from, type, text}` → `{ok, id}` |
| GET | `/inbox/:agent?limit=50` | key | read inbox, oldest first |
| POST | `/inbox/:agent/ack` | key | `{ids:[...]}` deletes messages |
| GET | `/watcher` | key | last watcher run summary |
| POST | `/watcher/run-now` | key | trigger a watcher pass (debug) |

Auth (decided 2026-10-02, shipped 2026-10-03): every route requires header
`x-broker-key` matching the `BROKER_KEY` secret, except `/health` and
`/inbox/:agent/peek`. If the secret is unset the broker is open (dev mode
only). Inbox contents are task metadata (titles, priorities), never secrets,
but open content reads would let anyone enumerate the team's work; `/peek`
leaks only a count, which is all a secret-less detector needs.

### 3.2 Queue watcher (cron)

Declared in `wrangler.toml` as `*/5 * * * *`. Each run:

1. `POST https://api.notion.com/v1/databases/<QUEUE_DB>/query` with filter
   `{property:"Status", select:{equals:"Queued"}}`, using the `NOTION_TOKEN`
   secret. (Note: Status is a **select** property in this database, not a
   Notion "status" property.)
2. Groups un-notified queued rows by `Owner`. Skips rows with no owner.
3. Writes one inbox message per owner listing their rows and priorities.
4. Records notified row IDs in `watcher:notified`; prunes entries for rows no
   longer queued.
5. Writes a run summary to `watcher:last-run` (checked count, notified owners,
   errors) for debugging via `GET /watcher`.

If `NOTION_TOKEN` is missing the watcher no-ops; the broker routes still work.

### 3.3 Agent-side inbox checking (the idle-burn killer)

The pattern, per agent:

```
loop every N minutes (N >= 5):
    peek = GET https://<host>/inbox/<me>/peek     # open, no key, count only
    if peek.count == 0: do nothing                # zero AI tokens
    else: wake up / run the worker, which holds the key:
          GET  /inbox/<me>            (x-broker-key)  -> messages
          ... do the work ...
          POST /inbox/<me>/ack        (x-broker-key)  {ids:[...]}
```

- **Muse:** implemented as a runtime hook. The hook's detector script is the
  loop above (plain shell + curl, no agent turn). New hooks start disabled;
  inspect `hooks.dry_run` before `hooks.enable`. Hook scripts live under
  `~/hooks/scripts/`, state under `~/hooks/state/`. Hooks have no connector
  credentials and detectors must not hold secrets — so the detector calls
  only `/peek`, which needs no key; the woken session reads the mail with
  the key it holds.
- **Claude:** per Andrew's decision of 2026-10-02, the consumer is an
  always-on Claude Code session on the desktop PC (Claude Code Channels),
  not an API-billed Claude. It polls `/peek` and reads with the key it is
  provisioned at setup. Claude's Cowork polling schedule is deleted once that
  session is proven; only schedules tied to specific recurring work stay.
- **Future workers:** the loop *is* the worker's main. No scheduler at all.

**Reachability constraint (learned 2026-10-02):** `*.workers.dev` URLs are
unreachable from any client behind Cloudflare's Worker-to-`workers.dev`
fetch block (Cloudflare error 1042) — this includes Muse's VM, whose egress
proxy is itself a Cloudflare Worker. Agent polling MUST use a
normally-reachable address, never the raw `workers.dev` URL, from such
networks. Current solution: the portfolio site proxies `/api/agent-broker/*`
to the worker (`src/app/api/agent-broker/[...path]/route.ts` in the
portfolio repo), so the hook polls
`https://<portfolio host>/api/agent-broker/inbox/muse/peek` (the proxy is on
the `staging` deployment only as of 2026-10-03). A custom domain on the
worker would also work but requires the domain's DNS to live in Cloudflare;
andrewjoji.com's DNS is on Vercel, so that option was rejected (do not click
"Onboard domain" in the worker's Domains tab — it starts moving the whole
domain's DNS).

## 4. Connecting a new agent

Checklist (this is the whole integration):

1. Pick an agent name (lowercase, e.g. `gemini`). Inbox is `inbox:<name>`.
2. Implement the inbox loop from 3.3: poll `https://<host>/inbox/<name>/peek`
   without a key; read and ack `https://<host>/inbox/<name>` with
   `x-broker-key` (store the key via the agent's secure credential mechanism,
   never in code).
3. Teach it the queue protocol (lives in Notion, "Standing protocol" row):
   claim = `Status=Running` + `Claimed by <agent> <date>` as first Result line;
   never start an already-claimed row; write `Checkpoint` (current step +
   findings + next step) as you go and always before stopping; handoffs as
   compact context packets, never transcript dumps.
4. Lane it: give it an `Owner` value used on queue rows, and only have it
   claim rows where `Owner` matches.
5. Test: post a message to its inbox, confirm it wakes, does a test row, acks.

No Notion API access is strictly required for a worker — the watcher already
checked the queue for it. It only needs Notion access if it must claim/write
rows itself (give it a dedicated Notion internal integration in that case).

## 5. Security notes

- Inbox traffic is task metadata, not secrets. `BROKER_KEY` is defense in
  depth, not a vault.
- The worker never sees Muse/Claude credentials. `NOTION_TOKEN` is a Notion
  credential stored as a Cloudflare secret. Two options: a scoped internal
  integration (Agent Queue database only, shared with it), or a personal
  access token (simpler — sees everything the account sees, so no sharing
  step; caveat: tied to the account, not the workspace — if revoked or the
  account leaves the workspace, the watcher stops).
- Token in use: personal access token `agent-broker`, created 2026-10-02,
  expires 2027-10-02. A renewal reminder is scheduled for 2027-09-11.
- Hook detector scripts must not contain secrets (runtime constraint).
- The worker is public by URL; treat the URL as semi-private and set
  `BROKER_KEY` before any sensitive use.
- `BROKER_KEY` enforcement (decided 2026-10-02, shipped 2026-10-03):
  required on every route except `/health` and `/inbox/:agent/peek`. The
  earlier interim model (writes only, GETs open) was rejected because open
  content reads let anyone enumerate the team's work; `/peek` gives
  secret-less hooks the one bit they need. The key comparison is
  constant-time. Key stored in each agent's secure credential store, never
  in repo, Notion, or a queue row.
- Key storage (2026-10-02): Muse holds the key at `~/.broker_key` (600,
  outside any repo) because the Secure Vault tools are write-only — no
  read-back for scripted API calls. There is currently no shared cross-agent
  secret store: each new agent (Claude, future workers) must be provisioned
  the key individually at setup time by Andrew. Storing the key in Notion was
  considered and rejected: Notion content is plain text visible to anyone with
  page/API access, and it would create a circular dependency (broker protects
  the queue, queue holds the broker's key).
- This repo is public, which is fine: it contains no secrets (`NOTION_TOKEN`
  lives only as a Cloudflare secret; the IDs in `wrangler.toml` are opaque
  identifiers, not credentials). Keep it that way — never commit tokens or
  keys. The portfolio proxy must **not** hold the key: it is reachable by
  anyone, so a key attached server-side would reopen every gated route to
  the public. It forwards `x-broker-key` unchanged; callers that need gated
  routes send the header themselves, and the hook only calls `/peek`.
  (The comment at the top of the proxy's `route.ts` still describes the old
  idea and should be updated.)
- `QUEUE_DB` (a Notion database id) is committed in `wrangler.toml`. It is
  not a credential, but Andrew's stated condition for keeping this repo
  public was "no secrets or Notion IDs". Option: move it to a Worker secret
  and drop the `[vars]` block; the code reads `env.QUEUE_DB` either way.

## 6. Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| Worker down / deploy broken | Inboxes unwritable; watcher stops | Fix forward via repo push (auto-deploys); queue itself is unaffected |
| KV unavailable | Routes return 503 | Cloudflare-side; retries on next cron |
| Notion API down / token revoked | Watcher logs error to `watcher:last-run`, broker keeps working | Check `GET /watcher`; re-issue token |
| Muse VM replaced | Hook may need re-enabling | Hourly poll (kept as backstop) or manual `hooks.enable`; hook scripts live in persistent home |
| Agent dies mid-task | Row stays `Running` with last `Checkpoint` | Stale-claim rule: another agent (or the same one later) resumes from the checkpoint |
| `*.workers.dev` unreachable from agent network (Cloudflare error 1042) | Inbox polls fail; agents never wake | Poll via the portfolio proxy (`/api/agent-broker/*`) or a custom domain; never rely on the raw `workers.dev` URL from restricted networks |
| Cloudflare gzips larger worker responses; proxy passed `content-encoding: gzip` through after decompressing | Clients receive plain text labeled as gzip → empty/garbled bodies | When buffering the upstream body (which decompresses), strip both `content-length` and `content-encoding` (learned 2026-10-02: broke `GET /inbox` for an hour) |
| Workers Builds tracking wrong branch | Pushes to `main` never deploy | Settings → Builds → Branch control: production branch must be `main` (2026-10-02: it was tracking a leftover `__access_test__` branch) |
| `workers.dev` URL toggle disabled | Worker deployed but URL serves nothing | Domains tab: enable the Production `workers.dev` URL |
| Workers Builds "Build failed to initialize and was timed out" (3× on 2026-10-02, no code change) | Pushes to `main` never deploy; Worker keeps serving the previous version | Deploys moved to GitHub Actions (`.github/workflows/deploy.yml`, `wrangler deploy` with repo secrets). Disconnect Workers Builds so the two do not race |
| KV free-tier list budget exhausted (`/peek` and `GET /inbox` each cost one list op; the cap is per day, shared by all callers) | `/peek` and inbox reads fail until the daily reset | Keep every poller at ≥ 5-minute intervals; if a third poller is added, replace the list in `/peek` with a per-agent flag key maintained on post/ack |

Delivery is poll-based throughout: expect minutes of latency, not seconds.
That is acceptable for queue work.

## 7. Token economics

Before: ~312 Muse polling sessions/day (5-min fast lane + hourly), ~94% of
each session's tokens being context re-reads.
After: ~0 scheduled polling sessions. Sessions happen only for real work (plus
the daily 6 AM scan, which does real work every run). Idle burn eliminated on
both Muse's and Claude's sides; schedules whose only job was "check for work"
are deleted.

## 8. Open items / roadmap

- [ ] Claude-side inbox checking (replaces its polling schedule).
- [ ] `Checkpoint` field + convention added to the Agent Queue protocol,
      announced to Claude as a high-priority row (standing rule).
- [ ] Additional workers (Gemini via cron/CLI or managed agents; Codex CLI) —
      deferred until the broker + watcher are proven.
- [x] Auth model settled: key on everything except `/health` and `/peek`
      (2026-10-03).
- [ ] Per-agent keys instead of one shared `BROKER_KEY` (proposed in the
      Agent Queue; Andrew to decide after Muse's position).
- [ ] Muse hook detector switched from `GET /inbox/muse` to
      `GET /inbox/muse/peek`.
- [ ] Portfolio proxy: fix the stale "attach Authorization server-side"
      comment in `route.ts`; get the proxy onto `main` when the blog hold
      lifts.
- [ ] `GET /inbox/:agent` `since` parameter for incremental reads (currently
      clients track acked IDs instead).
- [ ] Portfolio repo pipeline (for the `/api/agent-broker` proxy): Vercel
      auto-deploys on push; CI (`build`: lint + typecheck + build) runs on PRs
      and pushes to `main`/`staging`; `main` is branch-protected (PR required,
      `build` check must pass, strict). No approving-review requirement —
      solo repo, GitHub doesn't let you approve your own PRs.
