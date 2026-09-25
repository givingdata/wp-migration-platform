// 1wp-slack end to end: Slack → router → client Worker's /slack/inbox (the real handleSlackRoute),
// and client → router /api → Slack. fetch is faked: slack.com answers from a table, the client and
// router hosts are dispatched to the real code.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import router, { clientKey } from "../src/index.js";
import { handleSlackRoute, postMessage, slackApi, userEmail, routerHeaders } from "../../worker/src/slack.js";
import { toHex } from "../../worker/src/auth.js";

const ROUTER = "https://router.example";
const CLIENT_URL = "https://acme.example";
const SIGNING = "slack-signing";
const enc = new TextEncoder();

function fakeKV() {
  const map = new Map();
  return {
    map,
    get: async (k, type) => (map.has(k) ? (type === "json" ? JSON.parse(map.get(k)) : map.get(k)) : null),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async ({ prefix }) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

function ctx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), flush: async () => { while (pending.length) await pending.shift(); } };
}

let env, clientEnv, slackCalls, slackAnswers, received, realFetch, clientCtx, routerCtx;

const people = [
  { id: "U1", profile: { email: "boss@acme.org" } },
  { id: "U2", profile: { email: "helper@acme.org" } },
  { id: "U3", profile: { email: "someone@other.org" } },
  { id: "U9", profile: { email: "hello@flomysite.com" } },
  { id: "B1", is_bot: true, profile: {} },
];

beforeEach(() => {
  env = { SLACK_SIGNING_SECRET: SIGNING, SLACK_BOT_TOKEN: "xoxb-router", ROUTER_SECRET: "router-secret", ADMIN_KEY: "admin", SUPPORT_EMAILS: "hello@flomysite.com", ROUTER: fakeKV() };
  received = { messages: [], actions: [] };
  slackCalls = [];
  slackAnswers = {
    "conversations.create": () => ({ ok: true, channel: { id: "C100" } }),
    "conversations.info": () => ({ ok: true, channel: { is_member: true } }),
    "conversations.members": () => ({ ok: true, members: ["B1", "U3"] }),
    "users.list": () => ({ ok: true, members: people }),
    "users.info": (b) => ({ ok: true, user: people.find((p) => p.id === b.user) }),
  };
  clientCtx = ctx();
  routerCtx = ctx();
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "slack.com") {
      const method = u.pathname.slice("/api/".length);
      const body = init.headers["Content-Type"].startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(init.body))
        : JSON.parse(init.body);
      slackCalls.push({ method, body, token: init.headers.Authorization });
      return Response.json((slackAnswers[method] || (() => ({ ok: true, ts: "999.1" })))(body));
    }
    const request = new Request(url, init);
    if (u.origin === CLIENT_URL) {
      const handlers = { onMessage: async (m) => void received.messages.push(m), onAction: async (a) => void received.actions.push(a) };
      return (await handleSlackRoute(request, clientEnv, clientCtx, handlers)) || new Response("no", { status: 404 });
    }
    if (u.origin === ROUTER) return router.fetch(request, env, routerCtx);
    throw new Error(`unexpected fetch ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const adminCall = (path, body, key = "admin", method = "POST") =>
  router.fetch(new Request(`${ROUTER}${path}`, { method, headers: { Authorization: `Bearer ${key}` }, body: method === "POST" ? JSON.stringify(body) : undefined }), env, routerCtx);

async function addAcme(extra = {}) {
  const res = await adminCall("/admin/clients", { client: "acme", url: CLIENT_URL, staffDomains: ["acme.org"], ...extra });
  const out = await res.json();
  clientEnv = { SLACK_CLIENT: "acme", SLACK_ROUTER_URL: ROUTER, SLACK_ROUTER_KEY: out.key, CONTENT: fakeKV() };
  return out;
}

async function slackRequest(path, raw) {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", enc.encode(SIGNING), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = `v0=${toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${raw}`)))}`;
  return router.fetch(new Request(`${ROUTER}${path}`, { method: "POST", body: raw, headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": sig } }), env, routerCtx);
}

const settle = async () => {
  await routerCtx.flush();
  await clientCtx.flush();
};

const messageEvent = (channel, extra = {}) =>
  JSON.stringify({ type: "event_callback", team_id: "T1", event_id: `Ev-${channel}-${Math.random()}`, event: { type: "message", channel, user: "U1", text: "fix the hours", ts: "1.1" }, ...extra });

test("admin: needs ADMIN_KEY", async () => {
  assert.equal((await adminCall("/admin/clients", { client: "acme", url: CLIENT_URL }, "wrong")).status, 401);
  assert.equal((await adminCall("/admin/clients", null, "admin", "GET")).status, 200);
});

test("admin: add creates a private channel, invites staff + support, returns the key", async () => {
  const out = await addAcme();
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(out.channel, "C100");
  assert.equal(out.key, await clientKey(env, "acme", 1));
  assert.deepEqual(slackCalls.find((c) => c.method === "conversations.create").body, { name: "acme", is_private: true });
  assert.equal(slackCalls.find((c) => c.method === "conversations.invite").body.users, "U1,U2,U9");
  assert.equal(out.invited, 3);
  assert.equal(out.removed, 0);
  assert.equal(slackCalls.some((c) => c.method === "conversations.kick"), false);
});

test("admin: re-run updates, adopts an existing channel, prune kicks non-staff, rotateKey changes the key", async () => {
  const first = await addAcme();
  const res = await adminCall("/admin/clients", { client: "acme", existingChannel: "C200", prune: true, rotateKey: true });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.created, false);
  assert.equal(out.channel, "C200");
  assert.notEqual(out.key, first.key);
  assert.equal(await env.ROUTER.get("channel:C100"), null);
  assert.equal(await env.ROUTER.get("channel:C200"), "acme");
  assert.deepEqual(slackCalls.filter((c) => c.method === "conversations.kick").map((c) => c.body.user), ["U3"]);
});

test("admin: a channel can't belong to two clients; bad names and urls refused", async () => {
  await addAcme();
  const other = await adminCall("/admin/clients", { client: "other", url: "https://other.example", existingChannel: "C100" });
  assert.equal(other.status, 409);
  assert.equal((await adminCall("/admin/clients", { client: "Bad Name", url: CLIENT_URL })).status, 400);
  assert.equal((await adminCall("/admin/clients", { client: "x", url: "http://insecure.example" })).status, 400);
});

test("message in a client channel reaches that client's handlers, signed with its key", async () => {
  await addAcme();
  const res = await slackRequest("/slack/events", messageEvent("C100"));
  assert.equal(res.status, 200);
  await settle();
  assert.equal(received.messages.length, 1);
  assert.equal(received.messages[0].text, "fix the hours");
  assert.equal(received.messages[0].channel, "C100");
});

test("unknown channel, paused client, bad Slack signature → nothing forwarded", async () => {
  await addAcme();
  await slackRequest("/slack/events", messageEvent("C999"));
  await settle();
  await adminCall("/admin/clients", { client: "acme", paused: true });
  await slackRequest("/slack/events", messageEvent("C100"));
  await settle();
  assert.equal(received.messages.length, 0);

  const bad = await router.fetch(new Request(`${ROUTER}/slack/events`, { method: "POST", body: messageEvent("C100"), headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=00" } }), env, routerCtx);
  assert.equal(bad.status, 401);
});

test("Slack retries (same event_id) are forwarded once", async () => {
  await addAcme();
  const raw = messageEvent("C100");
  await slackRequest("/slack/events", raw);
  await slackRequest("/slack/events", raw);
  await settle();
  assert.equal(received.messages.length, 1);
});

test("button click reaches the client as the same act shape", async () => {
  await addAcme();
  const payload = { type: "block_actions", user: { id: "U1" }, channel: { id: "C100" }, container: { message_ts: "5.5" }, actions: [{ action_id: "approve", value: "p1" }] };
  await slackRequest("/slack/interactions", `payload=${encodeURIComponent(JSON.stringify(payload))}`);
  await settle();
  assert.deepEqual(received.actions, [{ actionId: "approve", value: "p1", user: "U1", channel: "C100", messageTs: "5.5", threadTs: null }]);
});

test("client's Slack calls go through the router with the router's token, in its own channel", async () => {
  await addAcme();
  slackCalls.length = 0;
  const ts = await postMessage(clientEnv, { channel: "C100", threadTs: "1.1", text: "hi" });
  assert.equal(ts, "999.1");
  assert.equal(slackCalls[0].method, "chat.postMessage");
  assert.equal(slackCalls[0].token, "Bearer xoxb-router");
  await assert.rejects(postMessage(clientEnv, { channel: "C999", text: "sneaky" }), /not_your_channel/);
  await assert.rejects(slackApi(clientEnv, "conversations.kick", { channel: "C100", user: "U1" }), /method_not_allowed/);
});

test("users.info only for people seen in the client's channel", async () => {
  await addAcme(); // U1, U2, U9 were added, so they're seen
  assert.equal(await userEmail(clientEnv, "U1"), "boss@acme.org");
  await assert.rejects(userEmail(clientEnv, "U3"), /unknown_user/);
});

test("client calls with a wrong key, old key or unknown client are refused", async () => {
  const first = await addAcme();
  await assert.rejects(postMessage({ ...clientEnv, SLACK_ROUTER_KEY: "nope" }, { channel: "C100", text: "x" }), /bad_signature/);
  await assert.rejects(postMessage({ ...clientEnv, SLACK_CLIENT: "ghost" }, { channel: "C100", text: "x" }), /unknown_client/);
  await adminCall("/admin/clients", { client: "acme", rotateKey: true });
  await assert.rejects(postMessage({ ...clientEnv, SLACK_ROUTER_KEY: first.key }, { channel: "C100", text: "x" }), /bad_signature/);
});

test("client inbox refuses requests not signed by the router", async () => {
  await addAcme();
  const bytes = enc.encode(JSON.stringify({ kind: "message", data: { channel: "C100", text: "x" } }));
  const res = await fetch(`${CLIENT_URL}/slack/inbox`, { method: "POST", headers: await routerHeaders("wrong-key", "acme", bytes), body: bytes });
  assert.equal(res.status, 401);
  await clientCtx.flush();
  assert.equal(received.messages.length, 0);
});

test("team_join: a new member on the staff list is added to their client's channel", async () => {
  await addAcme();
  slackCalls.length = 0;
  const join = (id, email) => JSON.stringify({ type: "event_callback", event_id: `Ej-${id}`, event: { type: "team_join", user: { id, profile: { email } } } });
  await slackRequest("/slack/events", join("U5", "new@acme.org"));
  await slackRequest("/slack/events", join("U6", "stranger@nowhere.org"));
  await settle();
  const invites = slackCalls.filter((c) => c.method === "conversations.invite");
  assert.deepEqual(invites.map((c) => c.body), [{ channel: "C100", users: "U5" }]);
  assert.equal(await env.ROUTER.get("seen:acme:U5"), "1");
});

test("remove: deletes the client and archives its channel", async () => {
  await addAcme();
  const out = await (await adminCall("/admin/clients/remove", { client: "acme" })).json();
  assert.equal(out.ok, true);
  assert.equal(out.archived, true);
  assert.equal(await env.ROUTER.get("client:acme"), null);
  assert.equal(await env.ROUTER.get("channel:C100"), null);
});
