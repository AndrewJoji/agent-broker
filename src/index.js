// agent-broker: shared inbox + queue watcher for the agent team.
// Runs as a Cloudflare Worker.
//
// KV binding: INBOX  (namespace `agent-inbox`)
// Secrets:    NOTION_TOKEN (Notion token with access to the Agent Queue database)
//             BROKER_KEY   (shared key; when set, gated routes must send header x-broker-key)
// Vars:       QUEUE_DB     (Agent Queue database id)
//
// Routes (all JSON):
//   GET  /health                         -> {ok, ts}                        open
//   GET  /inbox/:agent/peek              -> {ok, agent, count}              open (count only, no bodies)
//   GET  /inbox/:agent[?limit=N]         -> {ok, agent, count, messages[]}  key
//   POST /inbox/:agent  {from,type,text} -> store a message, {ok, id}       key
//   POST /inbox/:agent/ack {ids:[...]}   -> delete messages, {ok, acked}    key
//   GET  /watcher                        -> last watcher run summary        key
//   POST /watcher/run-now                -> trigger a watcher pass now      key
//
// Auth model (Andrew, 2026-10-02): every route requires x-broker-key except
// /health and /inbox/:agent/peek. Secret-less hook detectors poll /peek; the
// full agent session, which holds the key, reads and acks the mail.
//
// Cron (declared in wrangler.toml, every 5 min): queries the Notion Agent Queue
// for Status=Queued rows and drops a "work waiting" note into each owner's inbox.
// Agents poll their own inbox (one tiny KV read) instead of waking a full
// session to scan the queue.

const NOTION_VERSION = "2022-06-28";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorized(req, env) {
  if (!env.BROKER_KEY) return true; // no key configured: open (dev mode)
  const got = req.headers.get("x-broker-key") || "";
  const want = env.BROKER_KEY;
  if (got.length !== want.length) return false;
  // Constant-time compare: no early exit on the first mismatching character.
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function requireKv(env) {
  if (!env.INBOX) throw new Error("KV binding INBOX is not configured");
}

const inboxKey = (agent, id) => `inbox:${agent}:${id}`;
const newId = () => `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanAgent = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "unknown";

// ---------------- inbox routes ----------------

async function postMessage(req, env, agent) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const id = newId();
  const msg = {
    id,
    from: String(body.from || "unknown").slice(0, 64),
    type: String(body.type || "note").slice(0, 32),
    text: String(body.text || "").slice(0, 4000),
    ts: Date.now(),
  };
  await env.INBOX.put(inboxKey(agent, id), JSON.stringify(msg), {
    expirationTtl: 7 * 24 * 3600, // inbox messages expire after 7 days
  });
  return json({ ok: true, id });
}

// Count only, no message bodies. Open on purpose: this is what secret-less
// hook detectors poll, and a count leaks nothing beyond "there is mail".
// Costs one KV list operation per call; the KV free tier caps list operations
// per day (1,000/day at the time of writing), so keep each agent's poll
// interval at 5 minutes or more.
async function peekInbox(env, agent) {
  const list = await env.INBOX.list({ prefix: `inbox:${agent}:`, limit: 1000 });
  return json({ ok: true, agent, count: list.keys.length });
}

async function getInbox(env, agent, url) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  const list = await env.INBOX.list({ prefix: `inbox:${agent}:`, limit });
  const msgs = [];
  for (const k of list.keys) {
    const v = await env.INBOX.get(k.name);
    if (v) {
      try {
        msgs.push(JSON.parse(v));
      } catch {
        /* skip corrupt entries */
      }
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  return json({ ok: true, agent, count: msgs.length, messages: msgs });
}

async function ackMessages(req, env, agent) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  let acked = 0;
  for (const raw of ids.slice(0, 200)) {
    const id = String(raw).replace(/[^0-9a-zA-Z-]/g, "").slice(0, 64);
    if (!id) continue;
    if (await env.INBOX.get(inboxKey(agent, id))) {
      await env.INBOX.delete(inboxKey(agent, id));
      acked++;
    }
  }
  return json({ ok: true, acked });
}

// ---------------- watcher ----------------

function plainText(rich) {
  return (rich || []).map((b) => b.plain_text || "").join("");
}

function selectName(prop) {
  return prop && prop.select ? prop.select.name : null;
}

async function notionQuery(env, filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${env.QUEUE_DB}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filter, page_size: 100 }),
  });
  if (!res.ok) throw new Error(`notion query failed: ${res.status}`);
  return res.json();
}

async function runWatcher(env) {
  const summary = { ok: true, started: Date.now(), checked: 0, notified: [], errors: [] };
  try {
    const data = await notionQuery(env, { property: "Status", select: { equals: "Queued" } });
    const results = data.results || [];
    summary.checked = results.length;

    let notified = {};
    try {
      notified = JSON.parse((await env.INBOX.get("watcher:notified")) || "{}");
    } catch {
      notified = {};
    }

    const stillQueued = new Set();
    const byOwner = {};
    for (const page of results) {
      const p = page.properties || {};
      stillQueued.add(page.id);
      const owner = selectName(p.Owner);
      if (!owner || notified[page.id]) continue;
      const priority = selectName(p.Priority);
      const title = p.Task && p.Task.title ? plainText(p.Task.title) : "(untitled)";
      (byOwner[owner] = byOwner[owner] || []).push({ id: page.id, title, priority });
    }

    for (const [owner, rows] of Object.entries(byOwner)) {
      const agent = cleanAgent(owner);
      const lines = rows.map((r) => `- [${r.priority || "?"}] ${r.title}`.slice(0, 200));
      const id = newId();
      await env.INBOX.put(
        inboxKey(agent, id),
        JSON.stringify({
          id,
          from: "watcher",
          type: "queue",
          text: `${rows.length} queued row(s) waiting:\n${lines.join("\n")}`.slice(0, 4000),
          ts: Date.now(),
        }),
        { expirationTtl: 7 * 24 * 3600 }
      );
      for (const r of rows) notified[r.id] = Date.now();
      summary.notified.push({ owner, count: rows.length });
    }

    for (const id of Object.keys(notified)) {
      if (!stillQueued.has(id)) delete notified[id];
    }
    await env.INBOX.put("watcher:notified", JSON.stringify(notified));
  } catch (e) {
    summary.ok = false;
    summary.errors.push(String((e && e.message) || e).slice(0, 300));
  }
  summary.finished = Date.now();
  await env.INBOX.put("watcher:last-run", JSON.stringify(summary));
  return summary;
}

// ---------------- entrypoints ----------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      requireKv(env);
    } catch (e) {
      return json({ ok: false, error: e.message }, 503);
    }

    const isHealth = parts.length === 1 && parts[0] === "health";
    const isPeek =
      req.method === "GET" && parts.length === 3 && parts[0] === "inbox" && parts[2] === "peek";

    // Auth: every route needs x-broker-key except /health and /peek.
    if (!isHealth && !isPeek && !authorized(req, env)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (isHealth) {
      return json({ ok: true, ts: Date.now() });
    }
    if (parts[0] === "inbox" && parts[1]) {
      const agent = cleanAgent(parts[1]);
      if (isPeek) return peekInbox(env, agent);
      if (req.method === "POST" && parts.length === 2) return postMessage(req, env, agent);
      if (req.method === "GET" && parts.length === 2) return getInbox(env, agent, url);
      if (req.method === "POST" && parts.length === 3 && parts[2] === "ack") {
        return ackMessages(req, env, agent);
      }
    }
    if (parts.length === 1 && parts[0] === "watcher" && req.method === "GET") {
      const raw = await env.INBOX.get("watcher:last-run");
      return json({ ok: true, lastRun: raw ? JSON.parse(raw) : null });
    }
    if (parts.length === 2 && parts[0] === "watcher" && parts[1] === "run-now" && req.method === "POST") {
      if (!env.NOTION_TOKEN || !env.QUEUE_DB) {
        return json({ ok: false, error: "NOTION_TOKEN/QUEUE_DB not configured" }, 500);
      }
      return json(await runWatcher(env));
    }
    return json({ ok: false, error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    if (!env.NOTION_TOKEN || !env.QUEUE_DB || !env.INBOX) return;
    ctx.waitUntil(runWatcher(env).catch(() => {}));
  },
};
