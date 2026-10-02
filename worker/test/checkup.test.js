// The monthly check-up: when it's due, that it posts once a month, only with findings, and the
// SLACK_CHECKUP switch. Real editor over in-memory files; Slack faked.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createEditor } from "../../lib/edit/index.js";
import { runCheckup, checkupDue, checkupMessage, checkupOff, checkupKey } from "../src/checkup.js";
import { slackHandlers } from "../src/slack-flow.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function editorWith(files) {
  const store = {
    async read(names) {
      return { files: Object.fromEntries(names.map((n) => [n, files[n] === undefined ? null : structuredClone(files[n])])), head: "0" };
    },
    async write() {
      throw new Error("read-only");
    },
  };
  return createEditor({ store, specs });
}

function kv() {
  const map = new Map();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

const messy = () => ({
  frontPage: "p1",
  menu: [],
  pages: [
    { id: "p1", slug: "home", title: "Home", description: "Welcome." },
    { id: "p2", slug: "about", title: "About", description: "Us.", content: '<p>Hi <a href="https://dead.example/">x</a></p><img src="https://m.example/1.jpg"><img src="https://m.example/2.jpg">' },
    { id: "p3", slug: "team", title: "Team", content: "<p>Our team</p>" },
    { id: "p4", slug: "board", title: "Board", content: "<p>Our board</p>" },
    { id: "p5", slug: "staff", title: "Staff", content: "<p>Our staff</p>" },
    { id: "p6", slug: "jobs", title: "Jobs", content: "<p>Jobs</p>" },
  ],
  posts: [],
  events: [],
  redirects: [],
});
const tidy = () => ({ frontPage: "p1", menu: [], pages: [{ id: "p1", slug: "home", title: "Home", description: "Welcome." }], posts: [], events: [], redirects: [] });

const env = (extra = {}) => ({ CONTENT: kv(), SLACK_CHANNEL_IDS: "C1,C2", TIMEZONE: "America/Vancouver", SITE_URL: "https://site.example", SITE_NAME: "Acme", ...extra });
// Thu 1 Oct 2026, 10:05 in Vancouver (17:05 UTC).
const FIRST = Date.parse("2026-10-01T17:05:00Z");

test("due on the month's first weekday, 10:00 to 17:00 local time", () => {
  const w = (date, hour, weekday) => ({ year: date.slice(0, 4), month: date.slice(5, 7), day: date.slice(8, 10), hour, weekday });
  assert.equal(checkupDue(w("2026-10-01", "10", "Thu")), true);
  assert.equal(checkupDue(w("2026-10-01", "09", "Thu")), false, "too early");
  assert.equal(checkupDue(w("2026-10-01", "17", "Thu")), false, "too late");
  assert.equal(checkupDue(w("2026-10-02", "11", "Fri")), false, "not the first weekday");
  assert.equal(checkupDue(w("2026-11-01", "11", "Sun")), false, "a Sunday");
  assert.equal(checkupDue(w("2026-11-02", "11", "Mon")), true, "the 1st was a Sunday");
  assert.equal(checkupDue(w("2026-08-03", "11", "Mon")), true, "the 1st was a Saturday");
  assert.equal(checkupDue(w("2026-06-02", "11", "Tue")), false, "the 1st was a Monday");
  assert.equal(checkupOff({ SLACK_CHECKUP: "off" }), true);
  assert.equal(checkupOff({ SLACK_CHECKUP: "False" }), true);
  assert.equal(checkupOff({}), false, "on by default");
});

test("posts a short summary once a month, in the first channel, without checking outside links", async () => {
  const e = env();
  const posts = [];
  const post = async (_env, message) => void posts.push(message);
  globalThis.fetch = async () => assert.fail("no outside requests");
  const getEditor = () => editorWith({ "content.json": messy() });

  assert.deepEqual(await runCheckup(e, getEditor, { now: FIRST - 3600_000, post }), { skipped: "not due" }, "9:05 is too early");
  const first = await runCheckup(e, getEditor, { now: FIRST, post });
  assert.equal(first.posted, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C1");
  const text = posts[0].text;
  assert.match(text, /^🩺 \*Monthly website check-up\*: 5 things could use a look\.\n/);
  assert.match(text, /\n• \*Photo descriptions\* \(1\): <https:\/\/site\.example\/about\/\|About>\n/);
  assert.match(text, /\n• \*Search descriptions\* \(4\): <https:\/\/site\.example\/team\/\|Team>, <[^>]+\|Board>, <[^>]+\|Staff> and 1 more\n/);
  assert.match(text, /For the full list with links, post “is anything out of date\?” here\. Ask me: “describe the photos on About”$/);
  assert.doesNotMatch(text, /dead\.example|SEO|\bmeta\b|alt text/);
  assert.equal(e.CONTENT.map.get(checkupKey("2026-10")), "posted");

  assert.deepEqual(await runCheckup(e, getEditor, { now: FIRST + 600_000, post }), { skipped: "done" }, "the next tick");
  assert.equal(posts.length, 1);
  // Next month it's due again (Mon 2 Nov: the 1st is a Sunday; 10:30 PST = 18:30 UTC).
  assert.equal((await runCheckup(e, getEditor, { now: Date.parse("2026-11-02T18:30:00Z"), post })).posted, true);
  assert.equal(posts.length, 2);
});

test("a tidy site gets no post (but the month counts as done); SLACK_CHECKUP = off posts nothing", async () => {
  const posts = [];
  const post = async (_env, message) => void posts.push(message);
  const e = env();
  assert.deepEqual(await runCheckup(e, () => editorWith({ "content.json": tidy() }), { now: FIRST, post }), { posted: false, findings: 0 });
  assert.equal(e.CONTENT.map.get(checkupKey("2026-10")), "nothing to report");
  assert.equal(checkupMessage({ findings: [] }), null);
  const two = [{ kind: "alt", text: "No description", title: "A", path: "/a/" }, { kind: "alt", text: "No description", title: "B", path: "/b/" }];
  assert.equal(checkupMessage({ findings: two }), null, "two findings aren't worth a post");
  assert.match(checkupMessage({ findings: [...two, { kind: "alt", text: "No description", title: "C", path: "/c/" }] }), /3 things could use a look/);

  const off = env({ SLACK_CHECKUP: "off" });
  assert.deepEqual(await runCheckup(off, () => editorWith({ "content.json": messy() }), { now: FIRST, post }), { skipped: "off" });
  assert.deepEqual(await runCheckup(env({ SLACK_CHANNEL_IDS: "" }), () => editorWith({ "content.json": messy() }), { now: FIRST, post }), { skipped: "no channel" });
  assert.equal(posts.length, 0);
});

test("a failed check leaves no marker, so the next tick tries again", async () => {
  const e = env();
  const broken = () => ({ readAll: async () => { throw new Error("GitHub is down"); } });
  await assert.rejects(runCheckup(e, broken, { now: FIRST, post: async () => {} }), /GitHub is down/);
  assert.equal(e.CONTENT.map.size, 0);
});

test("the router's tick runs scheduled changes and then the check-up; a check-up failure is only logged", async () => {
  // Off: the tick still works as before.
  const handlers = slackHandlers(env({ SLACK_CHECKUP: "off" }), () => editorWith({ "content.json": messy() }));
  assert.equal(await handlers.onTick(), 0);
  // On, with a broken editor: logged, not thrown (whether or not it's due right now).
  const quiet = console.error;
  console.error = () => {};
  try {
    const broken = slackHandlers(env({ TIMEZONE: "UTC" }), () => ({ readAll: async () => { throw new Error("down"); } }));
    assert.equal(await broken.onTick(), 0);
  } finally {
    console.error = quiet;
  }
});
