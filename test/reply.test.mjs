// Run with: node --test 'test/**/*.test.mjs'
// Exercises the reply watch: owner routing, dedupe and message shape, against
// an in-memory KV and a stubbed Notion API.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { replyInbox, replyFingerprint } from "../src/index.js";

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
      return { keys: keys.map((name) => ({ name })) };
    },
  };
}

// A queue row as the Notion API returns it, with only the properties the
// watcher reads.
function row({ id, title, owner, status = "Needs approval", reply = null, note = "" }) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: new Date().toISOString(),
    properties: {
      Task: { title: [{ plain_text: title }] },
      Status: { select: { name: status } },
      Owner: { select: owner ? { name: owner } : null },
      Priority: { select: { name: "Normal" } },
      Reply: { select: reply ? { name: reply } : null },
      "Reply note": { rich_text: note ? [{ plain_text: note }] : [] },
    },
  };
}

// Stub the Notion query endpoint. `state.queued` and `state.replies` are the
// rows each filter returns; `state.failQueued` makes the Queued query 500.
const state = { queued: [], replies: [], failQueued: false, calls: [] };
const realFetch = globalThis.fetch;

beforeEach(() => {
  state.queued = [];
  state.replies = [];
  state.failQueued = false;
  state.calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push(body.filter);
    const isReply = Boolean(body.filter && body.filter.and);
    if (!isReply && state.failQueued) return new Response("boom", { status: 500 });
    const results = isReply ? state.replies : state.queued;
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const baseEnv = (kv, extra = {}) => ({
  INBOX: kv,
  BROKER_KEY: "k",
  NOTION_TOKEN: "t",
  QUEUE_DB: "db",
  REPLY_HUMAN_OWNERS: "Andrew",
  REPLY_HUMAN_INBOX: "claude",
  ...extra,
});

const runNow = (env) =>
  worker
    .fetch(
      new Request("https://broker.test/watcher/run-now", {
        method: "POST",
        headers: { "x-broker-key": "k" },
      }),
      env
    )
    .then((r) => r.json());

const inbox = (env, agent) =>
  worker
    .fetch(
      new Request(`https://broker.test/inbox/${agent}`, {
        method: "GET",
        headers: { "x-broker-key": "k" },
      }),
      env
    )
    .then((r) => r.json())
    .then((r) => r.messages);

test("replyInbox routes agents to themselves and human owners to the fallback inbox", () => {
  const env = { REPLY_HUMAN_OWNERS: "Andrew, Someone Else", REPLY_HUMAN_INBOX: "claude" };
  assert.equal(replyInbox("Claude", env), "claude");
  assert.equal(replyInbox("Muse", env), "muse");
  assert.equal(replyInbox("Andrew", env), "claude");
  assert.equal(replyInbox("someone else", env), "claude");
  assert.equal(replyInbox(null, env), null);
  // No human mapping configured: a human-owned row is not routable.
  assert.equal(replyInbox("Andrew", {}), "andrew");
  assert.equal(replyInbox("Andrew", { REPLY_HUMAN_OWNERS: "Andrew" }), null);
});

test("replyFingerprint changes with the value or the note, not otherwise", () => {
  assert.equal(replyFingerprint("✅ Yes", ""), replyFingerprint("✅ Yes", ""));
  assert.notEqual(replyFingerprint("✅ Yes", ""), replyFingerprint("❌ No", ""));
  assert.notEqual(replyFingerprint("💬 See note", "a"), replyFingerprint("💬 See note", "b"));
});

test("the reply query excludes closed rows and asks for a set Reply", async () => {
  const kv = fakeKv();
  await runNow(baseEnv(kv));
  const replyFilter = state.calls.find((f) => f && f.and);
  assert.ok(replyFilter, "reply query ran");
  assert.deepEqual(replyFilter.and[0], { property: "Reply", select: { is_not_empty: true } });
  const excluded = replyFilter.and.slice(1).map((f) => f.select.does_not_equal).sort();
  assert.deepEqual(excluded, ["Cancelled", "Done", "Failed"]);
});

test("one message per new reply, routed by Owner, data only", async () => {
  const kv = fakeKv();
  const env = baseEnv(kv);
  state.replies = [
    row({ id: "r1", title: "Claude task", owner: "Claude", reply: "✅ Yes" }),
    row({ id: "r2", title: "Muse task", owner: "Muse", reply: "❌ No", note: "secret note text" }),
    row({ id: "r3", title: "Andrew row", owner: "Andrew", reply: "✅ Yes" }),
  ];
  const summary = await runNow(env);
  assert.equal(summary.ok, true, JSON.stringify(summary.errors));
  assert.equal(summary.repliesChecked, 3);
  assert.deepEqual(
    summary.replies.sort((a, b) => a.agent.localeCompare(b.agent)),
    [
      { agent: "claude", count: 2 },
      { agent: "muse", count: 1 },
    ]
  );

  const claude = await inbox(env, "claude");
  const muse = await inbox(env, "muse");
  assert.equal(claude.length, 2);
  assert.equal(muse.length, 1);
  assert.equal(muse[0].type, "reply");
  assert.equal(muse[0].from, "watcher");
  assert.deepEqual(JSON.parse(muse[0].text), {
    type: "reply",
    row: "https://www.notion.so/r2",
    task: "Muse task",
    reply: "❌ No",
  });
  // The Reply note never travels in the message.
  for (const m of [...claude, ...muse]) assert.ok(!m.text.includes("secret note text"));
  assert.equal((await kv.get("pending:claude")) !== null, true);
  assert.equal((await kv.get("pending:muse")) !== null, true);
});

test("the same reply is not re-notified; a changed reply is; a cleared then re-set reply is", async () => {
  const kv = fakeKv();
  const env = baseEnv(kv);
  const r = (reply, note = "") => row({ id: "r1", title: "T", owner: "Muse", reply, note });

  state.replies = [r("💬 See note", "first")];
  await runNow(env);
  assert.equal((await inbox(env, "muse")).length, 1);

  // Same reply on later cycles (the Owner edited Result meanwhile): silent.
  await runNow(env);
  await runNow(env);
  assert.equal((await inbox(env, "muse")).length, 1);

  // The note changed: that is a new reply.
  state.replies = [r("💬 See note", "second")];
  await runNow(env);
  assert.equal((await inbox(env, "muse")).length, 2);

  // The value changed: new again.
  state.replies = [r("✅ Yes", "second")];
  await runNow(env);
  assert.equal((await inbox(env, "muse")).length, 3);

  // The Owner cleared Reply (row leaves the result set): marker dropped...
  state.replies = [];
  await runNow(env);
  assert.deepEqual(JSON.parse(await kv.get("watcher:replies")), {});
  // ...so the same value set again later is a new reply.
  state.replies = [r("✅ Yes", "second")];
  await runNow(env);
  assert.equal((await inbox(env, "muse")).length, 4);
});

test("a human-owned row with no fallback inbox is reported once, not every cycle", async () => {
  const kv = fakeKv();
  const env = baseEnv(kv, { REPLY_HUMAN_INBOX: "" });
  state.replies = [row({ id: "r9", title: "Andrew row", owner: "Andrew", reply: "✅ Yes" })];
  const first = await runNow(env);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /no routable Owner/);
  assert.equal((await inbox(env, "claude")).length, 0);
  const second = await runNow(env);
  assert.equal(second.errors.length, 0);
});

test("a failing Queued query does not stop the reply pass", async () => {
  const kv = fakeKv();
  const env = baseEnv(kv);
  state.failQueued = true;
  state.replies = [row({ id: "r1", title: "T", owner: "Claude", reply: "✅ Yes" })];
  const summary = await runNow(env);
  assert.equal(summary.ok, false);
  assert.match(summary.errors[0], /^queued: /);
  assert.deepEqual(summary.replies, [{ agent: "claude", count: 1 }]);
  assert.equal((await inbox(env, "claude")).length, 1);
});

test("queued-row notes still work alongside replies", async () => {
  const kv = fakeKv();
  const env = baseEnv(kv);
  state.queued = [row({ id: "q1", title: "Queued task", owner: "Muse", status: "Queued" })];
  const summary = await runNow(env);
  assert.deepEqual(summary.notified, [{ owner: "Muse", count: 1 }]);
  const muse = await inbox(env, "muse");
  assert.equal(muse.length, 1);
  assert.equal(muse[0].type, "queue");
});
