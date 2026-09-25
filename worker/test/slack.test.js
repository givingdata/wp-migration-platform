// Slack transport: signatures, event routing/dedupe, interactions, and the Web API helpers.
// Requests are signed with the same v0 HMAC Slack uses; fetch is faked for the API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySlackSignature, handleSlackRoute, slackApi, postMessage, userEmail, SlackError } from "../src/slack.js";
import { toHex } from "../src/auth.js";

const SECRET = "shh";

async function slackSign(secret, ts, raw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v0=${toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${raw}`)))}`;
}

async function slackRequest(path, raw, { ts = Math.floor(Date.now() / 1000), secret = SECRET, headers = {}, method = "POST" } = {}) {
  return new Request(`https://w.example${path}`, {
    method,
    body: method === "POST" ? raw : undefined,
    headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": await slackSign(secret, ts, raw), ...headers },
  });
}

function fakeKV() {
  const map = new Map();
  const opts = new Map();
  return { map, opts, get: async (k) => map.get(k) ?? null, put: async (k, v, o) => void (map.set(k, v), opts.set(k, o)) };
}

function setup() {
  const kv = fakeKV();
  const pending = [];
  const calls = { messages: [], actions: [] };
  return {
    env: { SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "xoxb-test", CONTENT: kv },
    ctx: { waitUntil(p) { pending.push(p); } },
    handlers: { onMessage: async (m) => void calls.messages.push(m), onAction: async (a) => void calls.actions.push(a) },
    calls, pending, kv,
    flush: () => Promise.all(pending),
  };
}

const eventBody = (event, extra = {}) => JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1", event, ...extra });
const message = { type: "message", channel: "C1", user: "U1", text: "change the opening hours", ts: "1700000000.000100" };

test("verifySlackSignature: valid, wrong, expired, non-numeric", async () => {
  const now = 1_700_000_000;
  const raw = "a=b";
  const sig = await slackSign(SECRET, now, raw);
  assert.equal(await verifySlackSignature(SECRET, String(now), raw, sig, now), true);
  assert.equal(await verifySlackSignature(SECRET, String(now), raw + "x", sig, now), false);
  assert.equal(await verifySlackSignature("other", String(now), raw, sig, now), false);
  assert.equal(await verifySlackSignature(SECRET, String(now), raw, sig, now + 301), false);
  assert.equal(await verifySlackSignature(SECRET, "abc", raw, sig, now), false);
  assert.equal(await verifySlackSignature(SECRET, String(now), raw, null, now), false);
});

test("bad signature → 401, no work", async () => {
  const s = setup();
  const res = await handleSlackRoute(await slackRequest("/slack/events", eventBody(message), { secret: "wrong" }), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false });
  assert.equal(s.pending.length, 0);
});

test("expired timestamp → 401", async () => {
  const s = setup();
  const res = await handleSlackRoute(await slackRequest("/slack/events", eventBody(message), { ts: Math.floor(Date.now() / 1000) - 600 }), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 401);
});

test("url_verification echoes the challenge", async () => {
  const s = setup();
  const res = await handleSlackRoute(await slackRequest("/slack/events", JSON.stringify({ type: "url_verification", challenge: "xyz" })), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await res.json(), { challenge: "xyz" });
});

test("a staff message schedules onMessage once with the right fields", async () => {
  const s = setup();
  const res = await handleSlackRoute(await slackRequest("/slack/events", eventBody(message)), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 200);
  await s.flush();
  assert.deepEqual(s.calls.messages, [{ eventId: "Ev1", teamId: "T1", channel: "C1", user: "U1", text: "change the opening hours", ts: message.ts, threadTs: null }]);
  assert.equal(s.kv.map.get("slack:event:Ev1"), "1");
  assert.deepEqual(s.kv.opts.get("slack:event:Ev1"), { expirationTtl: 3600 });
});

test("duplicate event_id (and retries) are acked without work", async () => {
  const s = setup();
  await handleSlackRoute(await slackRequest("/slack/events", eventBody(message)), s.env, s.ctx, s.handlers);
  const again = await handleSlackRoute(await slackRequest("/slack/events", eventBody(message)), s.env, s.ctx, s.handlers);
  const retry = await handleSlackRoute(await slackRequest("/slack/events", eventBody(message), { headers: { "x-slack-retry-num": "1" } }), s.env, s.ctx, s.handlers);
  assert.equal(again.status, 200);
  assert.equal(retry.status, 200);
  await s.flush();
  assert.equal(s.calls.messages.length, 1);
});

test("without KV there is no dedupe but messages still flow", async () => {
  const s = setup();
  delete s.env.CONTENT;
  await handleSlackRoute(await slackRequest("/slack/events", eventBody(message)), s.env, s.ctx, s.handlers);
  await s.flush();
  assert.equal(s.calls.messages.length, 1);
});

test("bot, subtype, empty and non-message events are ignored", async () => {
  const cases = [
    { ...message, bot_id: "B1" },
    { ...message, subtype: "message_changed" },
    { ...message, text: "  " },
    { ...message, user: undefined },
    { ...message, type: "reaction_added" },
  ];
  for (const [i, event] of cases.entries()) {
    const s = setup();
    const res = await handleSlackRoute(await slackRequest("/slack/events", eventBody(event, { event_id: `Ev${i}` })), s.env, s.ctx, s.handlers);
    assert.equal(res.status, 200);
    await s.flush();
    assert.equal(s.calls.messages.length, 0, `case ${i}`);
  }
  // A thread parent (thread_ts === ts) is top level; a reply carries its thread for onMessage to judge.
  const s = setup();
  await handleSlackRoute(await slackRequest("/slack/events", eventBody({ ...message, thread_ts: message.ts })), s.env, s.ctx, s.handlers);
  await handleSlackRoute(await slackRequest("/slack/events", eventBody({ ...message, ts: "1700000009.000100", thread_ts: message.ts }, { event_id: "EvR" })), s.env, s.ctx, s.handlers);
  await s.flush();
  assert.deepEqual(s.calls.messages.map((m) => m.threadTs), [null, message.ts]);
});

test("handler errors are caught and logged, not thrown", async () => {
  const s = setup();
  s.handlers.onMessage = async () => { throw new Error("boom"); };
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await handleSlackRoute(await slackRequest("/slack/events", eventBody(message)), s.env, s.ctx, s.handlers);
    await s.flush();
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(message.text));
});

test("block_actions → onAction with the right fields, empty 200", async () => {
  const s = setup();
  const payload = {
    type: "block_actions",
    user: { id: "U2" },
    channel: { id: "C1" },
    container: { type: "message", message_ts: "1700000001.000200", channel_id: "C1" },
    message: { ts: "1700000001.000200", thread_ts: "1700000000.000100" },
    response_url: "https://hooks.slack.test/r",
    actions: [{ action_id: "approve", value: "draft-123" }, { action_id: "cancel", value: "x" }],
  };
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const res = await handleSlackRoute(await slackRequest("/slack/interactions", raw), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
  await s.flush();
  assert.deepEqual(s.calls.actions, [{
    actionId: "approve", value: "draft-123", user: "U2", channel: "C1",
    messageTs: "1700000001.000200", threadTs: "1700000000.000100", responseUrl: "https://hooks.slack.test/r",
  }]);
});

test("non-block_actions interactions do nothing", async () => {
  const s = setup();
  const raw = new URLSearchParams({ payload: JSON.stringify({ type: "view_submission" }) }).toString();
  const res = await handleSlackRoute(await slackRequest("/slack/interactions", raw), s.env, s.ctx, s.handlers);
  assert.equal(res.status, 200);
  assert.equal(s.pending.length, 0);
});

test("feature off → 404; other paths → null; GET → 405; oversize → 413", async () => {
  const off = setup();
  delete off.env.SLACK_SIGNING_SECRET;
  assert.equal((await handleSlackRoute(await slackRequest("/slack/events", "{}"), off.env, off.ctx, off.handlers)).status, 404);
  const s = setup();
  assert.equal(await handleSlackRoute(new Request("https://w.example/health"), s.env, s.ctx, s.handlers), null);
  assert.equal(await handleSlackRoute(new Request("https://w.example/slackers"), s.env, s.ctx, s.handlers), null);
  assert.equal((await handleSlackRoute(await slackRequest("/slack/events", "", { method: "GET" }), s.env, s.ctx, s.handlers)).status, 405);
  const big = "x".repeat(256 * 1024 + 1);
  assert.equal((await handleSlackRoute(await slackRequest("/slack/events", big), s.env, s.ctx, s.handlers)).status, 413);
});

test("slackApi sends the bot token and throws SlackError on ok:false", async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }));
  };
  try {
    await assert.rejects(slackApi({ SLACK_BOT_TOKEN: "xoxb-1" }, "chat.postMessage", { channel: "C" }), (e) => {
      assert.ok(e instanceof SlackError);
      assert.equal(e.status, 502);
      assert.match(e.message, /channel_not_found/);
      return true;
    });
    assert.equal(seen[0].url, "https://slack.com/api/chat.postMessage");
    assert.equal(seen[0].init.headers.Authorization, "Bearer xoxb-1");
  } finally {
    globalThis.fetch = orig;
  }
});

test("postMessage threads and returns ts; userEmail lowercases and caches", async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith("chat.postMessage")) return new Response(JSON.stringify({ ok: true, ts: "1.2" }));
    return new Response(JSON.stringify({ ok: true, user: { profile: { email: "Staff@Example.ORG" } } }));
  };
  try {
    const kv = fakeKV();
    const env = { SLACK_BOT_TOKEN: "xoxb-1", CONTENT: kv };
    assert.equal(await postMessage(env, { channel: "C1", threadTs: "1.1", text: "hi" }), "1.2");
    assert.deepEqual(JSON.parse(seen[0].init.body), { channel: "C1", text: "hi", thread_ts: "1.1", unfurl_links: false });
    assert.equal(await userEmail(env, "U1"), "staff@example.org");
    assert.equal(await userEmail(env, "U1"), "staff@example.org");
    assert.equal(seen.length, 2);
    assert.equal(kv.map.get("slack:user:U1"), "staff@example.org");
    assert.deepEqual(kv.opts.get("slack:user:U1"), { expirationTtl: 86400 });
    assert.equal(seen[1].init.body, "user=U1");
    assert.equal(await userEmail({ SLACK_BOT_TOKEN: "xoxb-1" }, "U2"), "staff@example.org");
  } finally {
    globalThis.fetch = orig;
  }
});

test("userEmail returns null when the profile has no email", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, user: { profile: {} } }));
  try {
    assert.equal(await userEmail({ SLACK_BOT_TOKEN: "x" }, "U1"), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("router mode: /slack/inbox is off without SLACK_ROUTER_KEY; direct routes off without SLACK_SIGNING_SECRET", async () => {
  const s = setup();
  const inbox = new Request("https://w.example/slack/inbox", { method: "POST", body: "{}" });
  assert.equal((await handleSlackRoute(inbox, s.env, s.ctx, s.handlers)).status, 404);

  const routerOnly = { SLACK_ROUTER_KEY: "k", SLACK_ROUTER_URL: "https://r.example", SLACK_CLIENT: "acme", CONTENT: s.kv };
  const events = await slackRequest("/slack/events", eventBody(message));
  assert.equal((await handleSlackRoute(events, routerOnly, s.ctx, s.handlers)).status, 404);
  const unsigned = new Request("https://w.example/slack/inbox", { method: "POST", body: "{}" });
  assert.equal((await handleSlackRoute(unsigned, routerOnly, s.ctx, s.handlers)).status, 401);
});
