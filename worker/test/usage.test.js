import test from "node:test";
import assert from "node:assert/strict";
import { costOf, recordUsage, usageSummary } from "../src/usage.js";

// KV with put metadata and paged list(), like Cloudflare's.
function fakeKV(pageSize = 2) {
  const map = new Map();
  return {
    map,
    async put(key, value, opts = {}) {
      map.set(key, { value, metadata: opts.metadata });
    },
    async list({ prefix, cursor }) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(cursor || 0);
      const page = keys.slice(start, start + pageSize).map((name) => ({ name, metadata: map.get(name).metadata }));
      const done = start + pageSize >= keys.length;
      return { keys: page, list_complete: done, cursor: done ? undefined : String(start + pageSize) };
    },
  };
}

const quiet = (fn) => async () => {
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
  }
};

test("costOf prices input, output and cache tokens per model", () => {
  // Opus 5.5: $4 in / $20 out per million
  assert.equal(costOf("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
  assert.equal(costOf("claude-opus-5", { input_tokens: 4000, output_tokens: 1000 }), 0.045);
  assert.ok(Math.abs(costOf("claude-opus-5-5", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }) - 5.4) < 1e-9);
  assert.equal(costOf("some-new-model", { input_tokens: 10 }), null);
});

test("recordUsage saves one key per call and usageSummary totals the month", quiet(async () => {
  const kv = fakeKV();
  const env = { CONTENT: kv };
  const now = new Date("2026-10-01T12:00:00Z");
  await recordUsage(env, "slack", { model: "claude-opus-5-5", usage: { input_tokens: 4000, output_tokens: 1000 } }, now);
  await recordUsage(env, "slack", { model: "claude-opus-5-5", usage: { input_tokens: 2000, output_tokens: 500 } }, now);
  await recordUsage(env, "form", { model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 1000 } }, now);
  await recordUsage(env, "slack", { model: "mystery", usage: { input_tokens: 5 } }, now);
  await recordUsage(env, "slack", { model: "claude-opus-5-5", usage: { input_tokens: 9 } }, new Date("2026-09-30T23:00:00Z"));
  assert.equal(kv.map.size, 5);

  const [oct, sep] = await usageSummary(env, 2, now);
  assert.equal(oct.month, "2026-10");
  assert.equal(oct.calls, 4);
  assert.equal(oct.inputTokens, 7005);
  assert.equal(oct.outputTokens, 2500);
  assert.equal(oct.unpriced, 1);
  // (7000 × 4 + 2500 × 20) / 1e6 = 0.078
  assert.equal(oct.cost, 0.08);
  assert.equal(oct.byFeature.slack.calls, 3);
  assert.equal(oct.byFeature.form.calls, 1);
  assert.equal(oct.byModel["claude-opus-5-5"], 3);
  assert.equal(sep.month, "2026-09");
  assert.equal(sep.calls, 1);
}));

test("recordUsage never throws, even when KV fails", quiet(async () => {
  const errors = [];
  const error = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await recordUsage({ CONTENT: { put: async () => { throw new Error("KV down"); } } }, "slack", { model: "claude-opus-5-5", usage: {} });
    await recordUsage({}, "form", null);
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 1);
}));
