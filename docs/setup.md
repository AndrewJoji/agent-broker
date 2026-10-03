# Setting up agent-broker, step by step

This walks a person through a full setup: the Notion queue, the Cloudflare
Worker, secrets, deployment and a first test. It assumes no Cloudflare
experience. Budget about 30–45 minutes.

If you'd rather have your AI agent do most of this, point it at
[AGENTS.md](../AGENTS.md). It covers the same steps with explicit stop points
where it must ask you first, and it leaves logins, tokens and secret values to
you.

**You will need:** a Notion account, a GitHub account, a free Cloudflare
account, and Node.js 18 or newer if you want to deploy from your own machine.

---

## 1. Fork the repo

1. Click **Fork** on GitHub. Keep the name `agent-broker` or choose your own.
2. Clone your fork if you plan to deploy locally:
   `git clone https://github.com/<you>/agent-broker && cd agent-broker`

## 2. Create the queue in Notion

1. Create a new full-page **database** (table). Name it whatever you like,
   e.g. "Agent Queue".
2. Add the properties from [protocol.md](protocol.md#1-create-the-database).
   The broker itself only reads four of them:
   - `Task`: the title property (rename the default "Name").
   - `Status`: type **Select** with options `Queued`, `Running`, `Done`,
     `Failed`, `Needs approval`. Do *not* use Notion's built-in *Status*
     type; the broker filters on a select.
   - `Owner`: type **Select**, one option per agent (e.g. `claude`, `muse`),
     plus one for you. Option names become inbox names, lowercased.
   - `Priority`: type **Select** with `High`, `Normal`, `Low`.
3. Copy the database id: open the database as a full page, copy its URL, and
   take the 32-character string before any `?`. That is your `QUEUE_DB`.

## 3. Give the broker read access to Notion

1. Go to **notion.so/profile/integrations** (or Settings → Connections →
   Develop or manage integrations) → **New integration**.
2. Type: **Internal**. Name it `agent-broker`. Capabilities: **Read content**
   is enough. Save, then copy the **Internal Integration Secret**. That is your
   `NOTION_TOKEN`. Keep it somewhere safe (a password manager).
3. Back on the queue database: `•••` (top right) → **Connections** → add
   `agent-broker`. Without this step the broker can't see the database.

## 4. Set up Cloudflare

1. Sign up at **dash.cloudflare.com** (free plan; no card needed for
   Workers).
2. Note your **Account ID**: Workers & Pages → Overview, right-hand sidebar.
3. Create the inbox storage: **Storage & Databases → KV → Create a
   namespace**, name it `agent-inbox`. Copy its **ID**.
4. In your fork, open `wrangler.toml` and replace the `id` under
   `[[kv_namespaces]]` with yours. Commit the change.
5. Pick your workers.dev subdomain if prompted (Workers & Pages → Overview).
   Your Worker will live at `https://agent-broker.<subdomain>.workers.dev`.

## 5. Deploy

Choose one way. Don't run both GitHub Actions and Cloudflare's own Git
integration ("Workers Builds") on the same Worker; they race each other.

### Option A: GitHub Actions (recommended)

1. Create an API token in Cloudflare: **My Profile → API Tokens → Create
   Token → "Edit Cloudflare Workers" template** → limit it to your account
   → Create. Copy the token (it is shown once).
2. In your fork on GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**, add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: from step 4.2.
   - `BROKER_URL` (optional): `https://agent-broker.<subdomain>.workers.dev`,
     no trailing slash. Enables the post-deploy smoke test.
3. **Actions** tab → enable workflows for your fork if GitHub asks.
4. Push any commit to `main` (the `wrangler.toml` change from 4.4 counts), or
   go to **Actions → Deploy → Run workflow**.
5. Wait for the green check. The first deploy creates the Worker, binds KV
   and sets the 5-minute cron.

### Option B: from your machine

```sh
npx wrangler@4 login     # opens a browser to authorize
npx wrangler@4 deploy
```

## 6. Set the Worker's secrets

The Worker needs three secrets. Set them in the dashboard (**Workers & Pages
→ agent-broker → Settings → Variables and Secrets → Add → type Secret**)
or from your machine, which prompts for the value so it never lands in your
shell history:

```sh
npx wrangler@4 secret put NOTION_TOKEN   # from step 3
npx wrangler@4 secret put QUEUE_DB       # from step 2
npx wrangler@4 secret put BROKER_KEY     # see below
```

For `BROKER_KEY`, generate a long random string (a password manager's
generator works, or `openssl rand -hex 32`) and save it in your password
manager. You'll hand the same key to each agent later.

Secrets survive future deploys; you only set them once.

## 7. Check it works

```sh
URL=https://agent-broker.<subdomain>.workers.dev
KEY=<your BROKER_KEY>

curl $URL/health                                   # {"ok":true,...}
curl -o /dev/null -w '%{http_code}\n' $URL/inbox/test   # 401: key is enforced
curl -X POST $URL/inbox/test -H "x-broker-key: $KEY" \
     -d '{"from":"me","type":"note","text":"hello"}'
curl $URL/inbox/test/peek                          # count: 1
```

Then test the watcher:

1. Add a queue row: `Task = Hello`, `Status = Queued`, `Owner = test`.
2. `curl -X POST $URL/watcher/run-now -H "x-broker-key: $KEY"`. The result
   should show `notified: [{owner: "test", count: 1}]`.
3. `curl $URL/inbox/test -H "x-broker-key: $KEY"` shows the "queued row(s)
   waiting" note.
4. Clean up: ack the messages (`POST /inbox/test/ack` with their ids) and
   delete the row.

If the watcher reports an error, see [Troubleshooting](#troubleshooting).

## 8. Connect your first agent

For each agent:

1. Add its name as an `Owner` option in the queue.
2. Give it the broker URL and the `BROKER_KEY`, stored in whatever secure
   credential mechanism it has. Not in a prompt, a Notion page or a repo.
3. Give it the rules from [protocol.md](protocol.md#2-the-rules).
4. Set up its detector: something that calls `GET /inbox/<name>/peek` every
   5 minutes or more and wakes the agent only when `count > 0`. The README's
   [Connecting an agent](../README.md#connecting-an-agent) section has the
   loop.
5. Test it with the "Say hello" row from
   [protocol.md](protocol.md#3-try-it).

Mind the free-tier KV budget: two agents at 5-minute intervals fit
comfortably; check the README's Limits section before adding a third.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` returns a Cloudflare error page | Not deployed yet, or the `workers.dev` route is disabled (Worker → Settings → Domains & Routes) |
| Every route returns 503 `KV binding INBOX is not configured` | Wrong or missing KV id in `wrangler.toml`; redeploy after fixing |
| `/inbox/test` returns 200 without a key | `BROKER_KEY` isn't set on the Worker |
| Watcher error `notion query failed: 401` | `NOTION_TOKEN` is wrong or revoked |
| Watcher error `notion query failed: 404` | Wrong `QUEUE_DB`, or the integration isn't connected to the database (step 3.3) |
| Watcher error `notion query failed: 400` | `Status` is Notion's *Status* type instead of a *Select* |
| Watcher runs but `checked: 0` | No rows have `Status` exactly `Queued` |
| Rows checked but nothing notified | Rows have no `Owner`, or were already announced (they're announced once per time they enter `Queued`) |
| An agent can't reach the Worker (Cloudflare error 1042) | Its network blocks `*.workers.dev`; use a custom domain or a forwarding proxy (README, Limits) |
| Actions deploy fails on auth | `CLOUDFLARE_API_TOKEN` lacks Workers permissions, or `CLOUDFLARE_ACCOUNT_ID` is wrong |
