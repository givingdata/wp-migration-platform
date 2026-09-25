// Slack end to end through the Worker, with Slack, Claude and GitHub faked: a staff message
// becomes a before/after in the thread, and only Approve commits content.json.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const SECRET = "slack-secret";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// One-file GitHub: enough of the git data API for the Edit module's store.
function fakeGitHub(files) {
  let n = 0;
  const objects = {};
  const put = (o) => ((objects[`sha${++n}`] = o), `sha${n}`);
  let head = put({ tree: put({ files: { ...files } }) });
  const commits = [];
  return {
    commits,
    files: () => objects[objects[head].tree].files,
    async handle(url, init) {
      const path = new URL(url).pathname.replace(/^\/repos\/o\/r/, "");
      const body = init.body ? JSON.parse(init.body) : null;
      const ok = (data) => new Response(JSON.stringify(data));
      if (path === "/git/ref/heads/main") return ok({ object: { sha: head } });
      if (path.startsWith("/git/commits/")) return ok({ tree: { sha: objects[path.split("/").pop()].tree } });
      if (path.startsWith("/contents/")) {
        const file = objects[objects[head].tree].files[path.slice("/contents/".length)];
        return file === undefined ? new Response("not found", { status: 404 }) : new Response(file);
      }
      if (path === "/git/blobs") return ok({ sha: put({ text: body.content }) });
      if (path === "/git/trees") {
        const next = { ...objects[body.base_tree].files };
        for (const t of body.tree) next[t.path] = objects[t.sha].text;
        return ok({ sha: put({ files: next }) });
      }
      if (path === "/git/commits") {
        commits.push(body.message);
        return ok({ sha: put({ tree: body.tree, parents: body.parents }), html_url: "https://github.test/c" });
      }
      if (path === "/git/refs/heads/main") {
        head = body.sha;
        return ok({});
      }
      return new Response(`unexpected ${path}`, { status: 500 });
    },
  };
}

const CONTACT = "<h2>Visit us</h2>\n<p>Opening hours: 10–4, Tuesday to Saturday.</p>\n<p>Parking is free.</p>";

function setup({ emails = { U1: "staff@example.org", U2: "stranger@gmail.com" } } = {}) {
  const gh = fakeGitHub({ "content.json": JSON.stringify({ pages: [{ id: "p2", slug: "contact", title: "Contact", content: CONTACT }], posts: [] }) });
  const kv = new Map();
  const env = {
    GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", CLAUDE_API_KEY: "a", SITE_NAME: "Test",
    SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_IDS: "C1", SLACK_STAFF_DOMAINS: "example.org",
    CONTENT: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
  };
  const slack = [];
  const reactions = [];
  const claude = [
    { action: "update", collection: "pages", id: "p2", typeKey: "page", reply: null, summary: "Change the opening hours" },
    { title: null, description: null, imageAlt: null, contentEdits: [{ find: "10–4, Tuesday to Saturday", replace: "9–5, weekdays" }], summary: "Opening hours now 9–5 weekdays" },
  ];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/")) return gh.handle(u, init);
    if (u.startsWith("https://api.anthropic.com/")) {
      const next = claude.shift();
      assert.ok(next, "unexpected Claude call");
      return new Response(JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(next) }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { "content-type": "application/json" } });
    }
    if (u.startsWith("https://slack.com/api/")) {
      const method = u.split("/").pop();
      if (method === "users.info") {
        const user = new URLSearchParams(init.body).get("user");
        return new Response(JSON.stringify({ ok: true, user: { profile: { email: emails[user] } } }));
      }
      const body = JSON.parse(init.body);
      (method.startsWith("reactions.") ? reactions : slack).push({ method, ...body });
      return new Response(JSON.stringify({ ok: true, ts: `t${slack.length}` }));
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { gh, env, slack, reactions, claude };
}

async function slackRequest(path, raw, contentType) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const sig = `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return new Request(`https://w.example${path}`, {
    method: "POST", body: raw, headers: { "Content-Type": contentType, "x-slack-request-timestamp": ts, "x-slack-signature": sig },
  });
}

async function send(env, path, raw, contentType) {
  const pending = [];
  const res = await worker.fetch(await slackRequest(path, raw, contentType), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res;
}

const message = (env, { user = "U1", channel = "C1", id = "Ev1" } = {}) =>
  send(env, "/slack/events", JSON.stringify({ type: "event_callback", event_id: id, team_id: "T1", event: { type: "message", channel, user, text: "Change the contact page hours to 9–5 weekdays", ts: "100.1" } }), "application/json");

const click = (env, actionId, value, user = "U1") =>
  send(env, "/slack/interactions", new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", user: { id: user }, channel: { id: "C1" }, container: { message_ts: "t1" }, message: { ts: "t1", thread_ts: "100.1" }, response_url: "https://hooks.slack.test/r",
    actions: [{ action_id: actionId, value }],
  }) }).toString(), "application/x-www-form-urlencoded");

const buttons = (msg) => msg.blocks.flatMap((b) => b.elements || []).filter((e) => e.type === "button");

test("a staff message becomes a before/after, and Approve publishes it", async () => {
  const { gh, env, slack, reactions } = setup();
  assert.equal((await message(env)).status, 200);

  assert.equal(slack[0].method, "chat.postMessage");
  assert.equal(slack[0].thread_ts, "100.1");
  assert.match(slack[0].text, /^Working on it…/);
  assert.equal(slack[1].method, "chat.update", "progress between the Claude steps");
  assert.match(slack[1].text, /Found “Contact”/);
  assert.deepEqual(reactions.map((r) => r.method), ["reactions.add", "reactions.remove"], "👀 while drafting");
  const draft = slack[2];
  assert.equal(draft.method, "chat.update");
  const [approve, cancel] = buttons(draft);
  assert.equal(approve.action_id, "1wp_approve");
  assert.equal(cancel.action_id, "1wp_cancel");
  assert.equal(gh.commits.length, 0, "nothing is published before Approve");

  await click(env, "1wp_approve", approve.value);
  assert.ok(slack.some((m) => m.method === "chat.postEphemeral" && /^Publishing/.test(m.text)));
  const page = JSON.parse(gh.files()["content.json"]).pages[0];
  assert.equal(page.content, CONTACT.replace("10–4, Tuesday to Saturday", "9–5, weekdays"));
  assert.equal(gh.commits.length, 1);
  assert.match(gh.commits[0], /\(by staff@example.org\)/);
  const done = slack.at(-1);
  assert.equal(done.method, "chat.update");
  assert.equal(buttons(done).length, 0, "buttons are replaced by the result");

  // A second click (or a second person) doesn't publish again.
  await click(env, "1wp_approve", approve.value);
  assert.equal(gh.commits.length, 1);
  assert.equal(slack.at(-1).method, "chat.postEphemeral");
});

test("Cancel publishes nothing", async () => {
  const { gh, env, slack } = setup();
  await message(env);
  const [, cancel] = buttons(slack[2]);
  await click(env, "1wp_cancel", cancel.value);
  assert.equal(gh.commits.length, 0);
  assert.equal(buttons(slack.at(-1)).length, 0);
});

test("non-staff, other channels and repeats get no draft", async () => {
  const { gh, env, slack, claude } = setup();
  await message(env, { user: "U2" });
  assert.equal(slack.length, 1);
  assert.match(slack[0].text, /Only staff/);

  await message(env, { channel: "C9", id: "Ev2" });
  assert.equal(slack.length, 1, "channels not listed are ignored");

  await message(env, { id: "Ev3" });
  await message(env, { id: "Ev3" });
  assert.equal(claude.length, 0, "the draft ran once");
  assert.equal(slack.length, 4, "the repeat was ignored");

  // A stranger can't approve a staff member's draft.
  const [approve] = buttons(slack[3]);
  await click(env, "1wp_approve", approve.value, "U2");
  assert.equal(gh.commits.length, 0);
  assert.match(slack.at(-1).text, /Only staff/);
});

test("the change goes through when progress messages fail", async () => {
  const { env, slack } = setup();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    /reactions\.|chat\.update/.test(String(url)) && !JSON.parse(init.body).blocks
      ? new Response(JSON.stringify({ ok: false, error: "missing_scope" }))
      : fetch(url, init);
  await message(env);
  const draft = slack.find((m) => m.method === "chat.update" && m.blocks);
  assert.equal(buttons(draft).length, 2);
});

// A message with any text, ts and thread (thread replies carry thread_ts).
const say = (env, text, { ts, threadTs, user = "U1", id = `Ev-${ts}` } = {}) =>
  send(env, "/slack/events", JSON.stringify({ type: "event_callback", event_id: id, team_id: "T1",
    event: { type: "message", channel: "C1", user, text, ts, ...(threadTs ? { thread_ts: threadTs } : {}) } }), "application/json");

// Records what each Claude call was asked, so tests can see the request text.
function recordClaude() {
  const asked = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.anthropic.com/")) asked.push(init.body);
    return fetch(url, init);
  };
  return asked;
}

const QUESTION = { action: "reply", collection: null, id: null, typeKey: null, reply: "Which page: Home or About?", summary: null };

test("the bot remembers its question: an answer in the thread drafts the change", async () => {
  const { env, slack, claude } = setup();
  claude.unshift(QUESTION);
  const asked = recordClaude();
  await say(env, "Change the opening hours to 9–5 weekdays", { ts: "200.1" });
  assert.equal(slack.at(-1).text, "Which page: Home or About?");

  await say(env, "The contact page", { ts: "200.5", threadTs: "200.1" });
  assert.equal(claude.length, 0, "the answer went to Claude");
  assert.match(asked[1], /Change the opening hours to 9–5 weekdays/, "with the original request");
  assert.match(asked[1], /Which page: Home or About\?/, "and the question");
  assert.match(asked[1], /The contact page/);
  assert.equal(buttons(slack.at(-1)).length, 2, "a before/after with Approve / Cancel");
  assert.ok(slack.filter((m) => m.method === "chat.postMessage").every((m) => m.thread_ts === "200.1"), "all in the one thread");
});

test("other thread replies are ignored, and a question is answered once", async () => {
  const { env, slack, claude } = setup();
  await say(env, "Looks good to me", { ts: "300.5", threadTs: "300.1" });
  assert.equal(slack.length, 0, "no question in that thread: nothing happens");

  claude.unshift(QUESTION);
  await say(env, "Change the hours", { ts: "301.1" });
  await say(env, "The contact page", { ts: "301.5", threadTs: "301.1" });
  const after = slack.length;
  await say(env, "Thanks!", { ts: "301.9", threadTs: "301.1" });
  assert.equal(slack.length, after, "the question was already answered");
});

test("the same person's next channel message also answers the question", async () => {
  const { env, slack, claude } = setup();
  claude.unshift(QUESTION);
  const asked = recordClaude();
  await say(env, "Change the opening hours to 9–5 weekdays", { ts: "400.1" });
  await say(env, "The contact page", { ts: "400.9" });
  assert.match(asked[1], /Change the opening hours[\s\S]*The contact page/);
  assert.equal(buttons(slack.at(-1)).length, 2);
  assert.equal(slack.filter((m) => m.method === "chat.postMessage").at(-1).thread_ts, "400.9", "reply under the new message");
});

test("Slack routes are off without a signing secret, and reject bad signatures", async () => {
  const { env } = setup();
  const bad = new Request("https://w.example/slack/events", { method: "POST", body: "{}", headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=00" } });
  assert.equal((await worker.fetch(bad, env, { waitUntil() {} })).status, 401);
  const off = { ...env, SLACK_SIGNING_SECRET: undefined };
  assert.equal((await worker.fetch(new Request("https://w.example/slack/events", { method: "POST", body: "{}" }), off, { waitUntil() {} })).status, 404);
});
