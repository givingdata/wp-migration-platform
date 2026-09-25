import { test } from "node:test";
import assert from "node:assert/strict";
import { channelAllowed, isStaff, takeRateLimit } from "../src/slack-access.js";

function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key).value : null; },
    async put(key, value, opts) { map.set(key, { value, opts }); },
  };
}

test("channel list: spaces trimmed, exact IDs only, empty denies", () => {
  const env = { SLACK_CHANNEL_IDS: " C0123ABC , G0456DEF,," };
  assert.equal(channelAllowed(env, "C0123ABC"), true);
  assert.equal(channelAllowed(env, "G0456DEF"), true);
  assert.equal(channelAllowed(env, "C0123AB"), false);
  assert.equal(channelAllowed(env, ""), false);
  assert.equal(channelAllowed(env, undefined), false);
  assert.equal(channelAllowed({}, "C0123ABC"), false);
  assert.equal(channelAllowed({ SLACK_CHANNEL_IDS: "" }, "C0123ABC"), false);
  assert.equal(channelAllowed({ SLACK_CHANNEL_IDS: " , " }, ""), false);
});

test("staff: exact emails, case-insensitive", () => {
  const env = { SLACK_STAFF_EMAILS: "Jane@Example.org, bob@other.net" };
  assert.equal(isStaff(env, "jane@example.org"), true);
  assert.equal(isStaff(env, "JANE@EXAMPLE.ORG"), true);
  assert.equal(isStaff(env, "bob@other.net"), true);
  assert.equal(isStaff(env, "ann@example.org"), false);
  assert.equal(isStaff(env, "xjane@example.org"), false);
  assert.equal(isStaff(env, null), false);
  assert.equal(isStaff(env, ""), false);
});

test("staff: domains match exactly, no subdomain or @ tricks", () => {
  const env = { SLACK_STAFF_DOMAINS: "thecinderellaproject.com, @Example.org" };
  assert.equal(isStaff(env, "amy@thecinderellaproject.com"), true);
  assert.equal(isStaff(env, "Amy@TheCinderellaProject.COM"), true);
  assert.equal(isStaff(env, "amy@example.org"), true);
  assert.equal(isStaff(env, "x@sub.thecinderellaproject.com"), false);
  assert.equal(isStaff(env, "x@thecinderellaproject.com.evil.com"), false);
  assert.equal(isStaff(env, "x@evilthecinderellaproject.com"), false);
  assert.equal(isStaff(env, "thecinderellaproject.com@evil.com"), false);
  assert.equal(isStaff(env, "evil.com@thecinderellaproject.com@x"), false);
  assert.equal(isStaff(env, "@thecinderellaproject.com"), false);
});

test("staff: nothing configured means nobody", () => {
  assert.equal(isStaff({}, "amy@thecinderellaproject.com"), false);
  assert.equal(isStaff({ SLACK_STAFF_EMAILS: "", SLACK_STAFF_DOMAINS: " " }, "a@b.com"), false);
});

test("rate limit counts per user and resets the next hour", async () => {
  const kv = fakeKV();
  const env = { CONTENT: kv, SLACK_HOURLY_LIMIT: "3" };
  const t = new Date("2026-09-24T14:05:00Z");

  assert.deepEqual(await takeRateLimit(env, "U1", t), { ok: true, remaining: 2, limit: 3 });
  assert.deepEqual(await takeRateLimit(env, "U1", t), { ok: true, remaining: 1, limit: 3 });
  assert.deepEqual(await takeRateLimit(env, "U1", t), { ok: true, remaining: 0, limit: 3 });
  assert.deepEqual(await takeRateLimit(env, "U1", t), { ok: false, remaining: 0, limit: 3 });
  // Another user has their own count.
  assert.equal((await takeRateLimit(env, "U2", t)).ok, true);

  const entry = kv.map.get("slack:rate:U1:2026092414");
  assert.equal(entry.value, "3");
  assert.equal(entry.opts.expirationTtl, 7200);

  // The next UTC hour starts fresh.
  const later = new Date("2026-09-24T15:00:00Z");
  assert.deepEqual(await takeRateLimit(env, "U1", later), { ok: true, remaining: 2, limit: 3 });
});

test("rate limit defaults to 20 and allows when KV is missing", async () => {
  assert.deepEqual(await takeRateLimit({ CONTENT: fakeKV() }, "U1"), { ok: true, remaining: 19, limit: 20 });
  assert.deepEqual(await takeRateLimit({ SLACK_HOURLY_LIMIT: "5" }, "U1"), { ok: true, remaining: 5, limit: 5 });
});
