# AGENTS.md: instructions for an AI agent setting up or working on agent-broker

You are an AI agent (a coding agent, a computer-use agent, a chat assistant
with tools) that a user has pointed at this repository. This file gives you
the context to set the system up for them, or to change it, while keeping
them in control. Read it fully before acting.

Humans: this file is written for your agent. The human-oriented walkthrough
is [docs/setup.md](docs/setup.md); it covers the same steps.

## 1. What this system is

- **agent-broker** is a Cloudflare Worker (`src/index.js`, plain JavaScript,
  no build step) with two jobs:
  - a **watcher** cron (every 5 min) that reads a Notion database (the
    "queue") for rows with `Status = Queued` and writes a "work waiting" note
    into the inbox of each row's `Owner`;
  - **inboxes** in Cloudflare KV that agents check cheaply
    (`GET /inbox/<agent>/peek`, no key) and read and ack with a shared key
    (`x-broker-key`).
- Notion is the source of truth. The broker only *reads* Notion; agents claim
  and update rows themselves following [docs/protocol.md](docs/protocol.md).
- Design rationale: [DESIGN.md](DESIGN.md). API and limits:
  [README.md](README.md).
- The project is experimental and maintained by its author for their own
  use. Do not open issues or PRs against the upstream repository on the
  user's behalf; work in the user's fork.

## 2. How to work with the user

Treat setup as a series of steps, each with a check. Before starting, tell
the user the plan in a few lines (which steps you'll do, which need them) and
get a go-ahead. Then:

- **Find out what already exists before creating anything.** Ask, or check
  (e.g. `npx wrangler@4 whoami`, `npx wrangler@4 kv namespace list`, whether
  the Notion database exists). Every step should be safe to resume.
- **Report after each step**: what you did, how you verified it, what's next.
- **Stop at the stop points** in section 4 and wait for explicit permission.
  Permission for one step is not permission for the next.
- If something fails twice, stop and explain rather than trying variations.

### Permission tiers

| Tier | Examples | Rule |
|---|---|---|
| **Do freely** | Read files; `node --check src/index.js`; `wrangler whoami`; list KV namespaces; `curl` the open routes (`/health`, `/peek`); explain things | No permission needed |
| **Ask first** | Create the Notion database or properties; create a KV namespace; edit and commit `wrangler.toml`; deploy; set Worker secrets; set GitHub repository secrets; post test messages; create or delete queue rows; push to `main` | Describe exactly what will happen, wait for "yes" |
| **Human only** | Signing up for or logging in to accounts; approving OAuth/browser logins; creating API tokens or integration secrets; anything involving payment or plan changes; choosing and storing `BROKER_KEY` | Tell the user what to do and where, then wait for them to say it's done |

If you control a browser, you may navigate to the right page for a
human-only step, but the user does the logging in, creating and copying.

### Secret handling

- Never ask the user to paste a secret into the conversation if a safer path
  exists. Prefer `npx wrangler@4 secret put <NAME>` run in a terminal the
  user types into (it prompts for the value), or the Cloudflare dashboard.
- If a secret does pass through you, use it only for the command that needs
  it, never echo it back, never write it to a file in the repo, a log, a
  Notion page, a queue row, a commit message or a PR.
- Never commit secrets. `.dev.vars` and `.env*` are gitignored; keep it that
  way. If you notice a secret in a diff, stop and tell the user.
- `BROKER_KEY` must never be attached by a proxy or any public-facing
  service (see README, Limits). Agents send it themselves.

## 3. What you need from the user

Ask for these up front, in one message:

1. Do they have Notion, GitHub and Cloudflare accounts? Which are missing?
2. Deploy via **GitHub Actions** (recommended; needs repo secrets) or
   **locally** with wrangler (needs Node 18+ and a terminal you can run)?
3. Which agents will use the broker, and what should their inbox names be
   (lowercase, letters/digits/`-`/`_`)?
4. Do they already have a Notion database they want to use as the queue, or
   should you create one?
5. What can you do directly in their environment (terminal, browser, Notion
   access, GitHub access)? Plan around that; hand the rest to them.

## 4. Setup procedure

Each step: action, who does it, and how to verify. ⛔ marks a stop point.

### Step 1: Fork
- **User**: fork the repo on GitHub (human-only if it needs their login).
- **You**: clone it if you have a terminal.
- **Verify**: `git remote -v` points at the user's fork.

### Step 2: Notion queue
- ⛔ Ask before creating anything in their workspace.
- Create a database with properties exactly as in
  [docs/protocol.md §1](docs/protocol.md#1-create-the-database). Critical:
  `Status` must be type **select**, not Notion's *status* type; `Owner`
  options must match the inbox names from section 3.
- If they already have a database, check its properties match and list any
  mismatches before changing anything.
- **Verify**: you can see the four properties `Task` (title), `Status`
  (select, includes `Queued`), `Owner` (select), `Priority` (select).
- Record the database id (32 hex characters from its URL) as `QUEUE_DB`. It
  is not a credential, but keep it out of the repo.

### Step 3: Notion integration
- **Human only**: create an internal integration with read access
  (notion.so/profile/integrations), and connect it to the queue database
  (`•••` → Connections). Its secret is `NOTION_TOKEN`; it stays with the
  user until step 6.
- **Verify** (later, in step 7): the watcher reports no 401/404.

### Step 4: Cloudflare account and KV
- **Human only**: sign up / log in; for local deploys, run
  `npx wrangler@4 login` and approve it in the browser.
- **You** (⛔ ask first): create the KV namespace
  (`npx wrangler@4 kv namespace create agent-inbox`, or the user does it in
  the dashboard under Storage & Databases → KV).
- **You** (⛔ ask first): put the namespace id in `wrangler.toml` under
  `[[kv_namespaces]]`, replacing the existing one; commit on a branch or, if
  the user approves, on `main`.
- **Verify**: `npx wrangler@4 kv namespace list` shows it, and its id matches
  `wrangler.toml`.

### Step 5: Deploy
- ⛔ Ask before deploying.
- **GitHub Actions path**: the user creates a Cloudflare API token from the
  "Edit Cloudflare Workers" template (human only) and adds repository secrets
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and optionally
  `BROKER_URL`. A push to `main` or **Actions → Deploy → Run workflow**
  deploys.
- **Local path**: `npx wrangler@4 deploy`.
- Use one deploy path only. Do not also connect Cloudflare Workers Builds.
- **Verify**: `curl https://agent-broker.<subdomain>.workers.dev/health`
  returns `{"ok":true,...}`. Note the URL for the user.

### Step 6: Worker secrets
- ⛔ Ask first; the user supplies the values.
- Set `NOTION_TOKEN`, `QUEUE_DB` and `BROKER_KEY` as **secrets** (never
  `[vars]` in `wrangler.toml`: those are public in the repo and overwritten
  on every deploy). Preferred: the user runs
  `npx wrangler@4 secret put <NAME>` for each, or adds them in the dashboard
  (Worker → Settings → Variables and Secrets, type *Secret*).
- `BROKER_KEY`: the user generates a long random value and stores it in
  their password manager. If you generate it, show it once for them to save
  and do not repeat it.
- **Verify**: `curl -o /dev/null -w '%{http_code}' $URL/inbox/test` returns
  `401` (key enforced).

### Step 7: End-to-end test
- ⛔ Ask before posting test data.
- Post a message to `test`, check `/inbox/test/peek` shows a count, read it
  with the key, ack it.
- Create a queue row (`Task = Hello`, `Status = Queued`, `Owner = test`),
  call `POST /watcher/run-now` with the key, confirm `notified` includes
  `test`, read and ack the note, then delete the row.
- If the watcher reports an error, use the troubleshooting table in
  [docs/setup.md](docs/setup.md#troubleshooting).

### Step 8: Connect agents
For each agent the user named:
- Add its name as an `Owner` option.
- The user stores the broker URL and `BROKER_KEY` in that agent's secure
  credential mechanism (human only unless the user explicitly hands it to
  you for that agent).
- Give the agent the rules from [docs/protocol.md §2](docs/protocol.md#2-the-rules).
- Set up its detector: poll `GET /inbox/<name>/peek` no more than every 5
  minutes; wake the agent only when `count > 0`. The detector must not hold
  the key.
- If the agent's network returns Cloudflare error 1042 for `*.workers.dev`,
  it needs a custom domain or a forwarding proxy (README, Limits).
- ⛔ Before adding a third polling agent, show the user the KV free-tier
  budget note in the README.
- **Verify**: the "Say hello" test in
  [docs/protocol.md §3](docs/protocol.md#3-try-it).

### Step 9: Hand back
Summarize for the user: the Worker URL, which secrets are set (names only),
which agents are connected, anything left for them to do, and where each
secret is stored (location, not value).

## 5. If you are changing the code

- Everything lives in `src/index.js`. No dependencies, no build.
- Check syntax with `node --check src/index.js`; CI runs the same on every
  PR.
- Any new secret or setting must be documented in the README's quickstart,
  in [docs/setup.md](docs/setup.md) and in section 4 of this file, in the
  same change.
- Keep the auth rule: only `/health` and `/inbox/:agent/peek` are open.
- Keep the broker read-only toward Notion unless the user decides otherwise.
- Work on a branch and open a PR in the user's fork; let them merge.

## 6. Things not to do

- Don't commit secrets, tokens, or real queue contents.
- Don't put `BROKER_KEY` in a proxy, a Notion page, a queue row or a
  detector script.
- Don't switch `Status` to Notion's *status* property type.
- Don't poll `/peek` more often than every 5 minutes per agent.
- Don't move a domain's DNS to Cloudflare to get a custom domain without the
  user understanding that it moves the *whole* domain.
- Don't run two deploy pipelines (Actions and Workers Builds) at once.
- Don't edit the Worker's code in the Cloudflare dashboard; the next deploy
  overwrites it.
