// Run with: node --test 'test/**/*.test.mjs'
// Exercises the pending-flag behaviour of /peek against an in-memory KV.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeKv() {
  const store = new Map();
  const kv = {
    lists: 0,
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
      kv.lists++;
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
      return { keys: keys.map((name) => ({ name })) };
    },
  };
  return kv;
}

const call = (env, method, path, body) =>
  worker
    .fetch(
      new Request(`https://broker.test${path}`, {
        method,
        headers: { "x-broker-key": "k" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env
    )
    .then((r) => r.json());

test("peek reflects post and ack without ever listing", async () => {
  const kv = fakeKv();
  const env = { INBOX: kv, BROKER_KEY: "k" };

  assert.equal((await call(env, "GET", "/inbox/a/peek")).count, 0);

  const first = await call(env, "POST", "/inbox/a", { from: "t", text: "one" });
  const second = await call(env, "POST", "/inbox/a", { from: "t", text: "two" });
  assert.equal((await call(env, "GET", "/inbox/a/peek")).count, 1);
  assert.equal((await call(env, "GET", "/inbox/b/peek")).count, 0);

  // Ack one of two: mail still pending.
  await call(env, "POST", "/inbox/a/ack", { ids: [first.id] });
  assert.equal((await call(env, "GET", "/inbox/a/peek")).count, 1);

  // Ack the last one: flag cleared.
  await call(env, "POST", "/inbox/a/ack", { ids: [second.id] });
  assert.equal((await call(env, "GET", "/inbox/a/peek")).count, 0);

  // Lists happened only inside the two acks.
  const before = kv.lists;
  await call(env, "GET", "/inbox/a/peek");
  await call(env, "GET", "/inbox/a/peek");
  assert.equal(kv.lists, before);
  assert.equal(before, 2);
});
