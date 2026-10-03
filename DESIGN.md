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
   - Muse: a hook runs a tiny script (`GET /inbox/muse`) every few minutes.
     Empty → stays silent, zero tokens. Non-empty → wakes a Muse session.
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

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| POST | `/inbox/:agent` | post `{from, type, text}` → `{ok, id}` |
| GET | `/inbox/:agent?limit=50` | read inbox, oldest first |
| POST | `/inbox/:agent/ack` | `{ids:[...]}` deletes messages |
| GET | `/watcher` | last watcher run summary |
| POST | `/watcher/run-now` | trigger a watcher pass (debug) |

Auth: if the `BROKER_KEY` secret is set, every request must carry header
`x-broker-key`. Without it the broker is open (dev mode). Inbox contents are
task metadata (titles, priorities), never secrets.

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
loop every N minutes:
    inbox = GET https://<worker>/inbox/<me>
    if inbox.messages is empty: do nothing        # zero AI tokens
    else: wake up / run the worker, do the work,
          then POST /inbox/<me>/ack {ids:[...]}
```

- **Muse:** implemented as a runtime hook. The hook's detector script is the
  loop above (plain shell + curl, no agent turn). New hooks start disabled;
  inspect `hooks.dry_run` before `hooks.enable`. Hook scripts live under
  `~/hooks/scripts/`, state under `~/hooks/state/`. Hooks have no connector
  credentials and detectors must not hold secrets — the inbox read needs no
  secret as long as `BROKER_KEY` is unset or GETs are left open.
- **Claude:** same pattern adapted to its side (its polling schedule is
  deleted; only schedules tied to specific recurring work stay).
- **Future workers:** the loop *is* the worker's main. No scheduler at all.

## 4. Connecting a new agent

Checklist (this is the whole integration):

1. Pick an agent name (lowercase, e.g. `gemini`). Inbox is `inbox:<name>`.
2. Implement the inbox loop from 3.3 against `https://<worker>/inbox/<name>`.
   If `BROKER_KEY` is set, send it as `x-broker-key` (store via the agent's
   secure credential mechanism, never in code).
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

## 6. Failure modes

| Failure | Behavior | Recovery |
|---|---|---|
| Worker down / deploy broken | Inboxes unwritable; watcher stops | Fix forward via repo push (auto-deploys); queue itself is unaffected |
| KV unavailable | Routes return 503 | Cloudflare-side; retries on next cron |
| Notion API down / token revoked | Watcher logs error to `watcher:last-run`, broker keeps working | Check `GET /watcher`; re-issue token |
| Muse VM replaced | Hook may need re-enabling | Hourly poll (kept as backstop) or manual `hooks.enable`; hook scripts live in persistent home |
| Agent dies mid-task | Row stays `Running` with last `Checkpoint` | Stale-claim rule: another agent (or the same one later) resumes from the checkpoint |

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
- [ ] Consider requiring `BROKER_KEY` on POST routes only, leaving GETs open
      for secret-less hook detectors.
- [ ] `GET /inbox/:agent` `since` parameter for incremental reads (currently
      clients track acked IDs instead).
