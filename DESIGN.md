# agent-broker: design notes

> Experimental, work in progress. This document explains why the broker is
> built the way it is. For setup, see the [README](README.md); for the queue
> protocol, see [docs/protocol.md](docs/protocol.md).

## 1. The problem

The setup this was built for has several AI agents (a chat assistant, a
coding agent, a personal agent running on a hosted VM, with more planned)
coordinating through one shared Notion database, the Agent Queue. Two
problems showed up quickly:

1. **Idle burn.** Checking the queue meant waking a full agent session every
   time, even when the queue was empty. In the original setup one agent ran
   about 300 polling sessions a day, and most of each session's tokens were
   spent re-reading context, so even a "quick check" cost nearly a full
   session.
2. **No direct messaging.** Agents could only talk by writing Notion rows
   and hoping the other agent's next poll noticed. Urgent nudges, protocol
   changes and hand-offs had no channel of their own. Some agents can't
   accept inbound connections at all (NAT, firewalls), so they can't be
   pushed to directly either.

The broker fixes both with one always-on Worker: a **watcher** that checks
the queue in plain code, and **inboxes** so agents wake only when there is
something for them.

## 2. Architecture

```
                 ┌───────────────────────────┐
                 │     Notion Agent Queue    │
                 │  tasks, state (truth)     │
                 └─────────────┬─────────────┘
                               │ query Status=Queued
                               │ every 5 min (cron)
                 ┌─────────────▼─────────────┐
                 │  Cloudflare Worker        │
                 │  ┌─────────┐ ┌──────────┐ │
                 │  │ Watcher │ │  Broker  │ │
                 │  │ (cron)  │ │  (HTTP)  │ │
                 │  └────┬────┘ └────┬─────┘ │
                 │       └─────┬─────┘       │
                 │             ▼             │
                 │   KV: inbox:<agent>:*     │
                 └─────────────┬─────────────┘
                    ▲          │          ▲
               peek / read     │ post     peek / read
                 ┌──┴───┐  ┌───┴───┐  ┌───┴────┐
                 │Agent │  │ Agent │  │ Future │
                 │  A   │  │   B   │  │ agents │
                 └──────┘  └───────┘  └────────┘
```

End to end:

1. A row lands in the queue with `Status = Queued` and an `Owner`.
2. Within 5 minutes the watcher's cron fires, queries Notion (one API call,
   no AI involved) and writes one "work waiting" note per owner.
3. Each agent checks only its own inbox via the open `/peek` route. A count
   of 0 costs nothing; anything above 0 wakes a real session, which reads
   the inbox with the key.
4. The agent does the work per the protocol (claim, result, status), then
   acks the message.
5. Direct messages skip the queue: `POST /inbox/<agent>` from any key
   holder.

Scheduled jobs whose only purpose was "check for work" can then be deleted.
Jobs that do real work every run stay as they are.

## 3. Components

### 3.1 Inboxes

One KV namespace bound as `INBOX`:

- `inbox:<agent>:<timestamp>-<rand>` → `{id, from, type, text, ts}`
- `watcher:notified` → `{rowId: timestamp}`, so each queued row is announced
  once
- `watcher:last-run` → last watcher summary, for debugging

Messages carry a 7-day TTL so the namespace can't grow without bound.
Message text is capped at 4,000 characters; reads return at most 200
messages.

### 3.2 Watcher

Each cron run:

1. Queries the database for `Status = Queued` (a **select** filter, so the
   property must be a select, not Notion's *Status* type).
2. Groups not-yet-announced rows by `Owner`; skips rows with no owner.
3. Writes one message per owner listing titles and priorities.
4. Records the announced row ids, pruning ids no longer queued.
5. Writes a run summary (rows checked, owners notified, errors).

If the Notion token or database id is missing, the watcher is a no-op and
the inboxes keep working.

### 3.3 Agent side

```
loop every N minutes (N >= 5):
    peek = GET /inbox/<me>/peek          # open, count only
    if peek.count == 0: nothing          # zero AI tokens
    else: wake the worker, which holds the key:
          GET  /inbox/<me>    -> messages
          ... do the work ...
          POST /inbox/<me>/ack {ids}
```

The detector (a hook, cron or shell loop) never holds a secret. This was a
hard requirement for one of the agents, whose hook runtime does not allow
credentials in detector scripts, and it is a good default anyway.

For an API-billed worker, the loop can simply *be* its main function: no
scheduler, no idle cost.

## 4. Auth model

- Every route requires `x-broker-key` except `/health` and
  `/inbox/:agent/peek`.
- `/peek` is open because a secret-less detector needs exactly one bit
  ("is there mail?") and a count leaks nothing more.
- Inbox contents are task metadata (titles, priorities), not secrets. They
  are still gated, because open reads would let anyone enumerate what the
  agents are working on.
- The key comparison is constant-time.
- With no `BROKER_KEY` set, the broker is fully open. That is for local
  development only.
- The key lives in each agent's own credential store, provisioned by hand.
  Storing it in the queue itself was rejected: Notion content is plain text
  to anyone with access, and it would be circular (the broker guards the
  queue; the queue would hold the broker's key).
- A forwarding proxy used for reachability (section 6) must pass the header
  through and never attach the key itself. A proxy that adds the key
  server-side reopens every gated route to anyone who can reach the proxy.
- An earlier interim model (key on writes only, reads open) was dropped for
  the enumeration reason above.

## 5. Configuration and secrets

Nothing sensitive is committed. The Notion token, the broker key and the
queue database id are Worker secrets, not `[vars]` in `wrangler.toml`.
The database id isn't a credential, but keeping it out of a public repo
costs nothing. Worker secrets survive deploys; plaintext `[vars]` are
replaced by whatever the file says on every `wrangler deploy`, so they are
not used at all.

The KV namespace id in `wrangler.toml` is an opaque identifier, not a
credential. Forks replace it with their own.

## 6. Failure modes and lessons learned

| Failure | Behaviour | Recovery |
|---|---|---|
| Worker down or deploy broken | Inboxes unwritable, watcher stops; the queue itself is unaffected | Fix forward; every push to `main` redeploys |
| KV unavailable | Routes return 503 | Cloudflare-side; next cron retries |
| Notion down or token revoked | Watcher records the error in its run summary; inboxes keep working | Check `GET /watcher`; re-issue the token |
| Agent dies mid-task | Row stays `Running` | Protocol-level: stale-claim rule and checkpoints (see protocol doc) |
| Agent's network can't reach `*.workers.dev` (Cloudflare error 1042) | Polls fail; the agent never wakes | Use a custom domain or a forwarding proxy; never depend on the raw `workers.dev` URL from restricted networks |
| Proxy decompresses the body but forwards `content-encoding: gzip` | Clients get plain text labelled gzip: empty or garbled bodies | When buffering an upstream body, strip `content-length` and `content-encoding` |
| KV list budget exhausted | `/peek` and inbox reads fail until the daily reset | Fixed: `/peek` reads a per-agent `pending:<agent>` flag (one get, no list), so polling no longer spends list operations. Keep pollers at ≥ 5-minute intervals anyway |
| Cloudflare Workers Builds failed to start, repeatedly, with no code change | Pushes never deployed | Deploys moved to GitHub Actions running `wrangler deploy`. If you use Workers Builds instead, check the production branch is `main` and the `workers.dev` route is enabled, and don't run both pipelines at once |
| Dashboard "Edit code" used on a git-deployed Worker | The next deploy silently overwrites it, or it overwrites the deploy | Treat the repo as the only source of the Worker's code |

Delivery is poll-based throughout: expect minutes of latency, not seconds.

## 7. Cost

Before: hundreds of polling sessions a day across agents, almost all of
them finding nothing.
After: polling costs one KV get per check (the per-agent `pending:<agent>`
flag, set on post and cleared when an ack empties the inbox) and zero tokens;
sessions start only for real work. List operations happen only in inbox reads
and acks, which are rare, so polling no longer eats the free tier's daily
list cap.

## 8. Open questions

- **Per-agent keys vs. one shared key.** Per-agent keys limit what a
  compromised agent can read, at the cost of provisioning and rotation work.
- **Should the broker write to Notion?** Today it is read-only on purpose:
  agents own their rows. Letting it mark rows as "announced" would make
  delivery visible in Notion but blur who owns state.
- **Push instead of poll.** Some agent runtimes can receive webhooks; most
  of the ones this was built for can't. Polling is the lowest common
  denominator.
