// End-to-end through the Worker with GitHub and Claude faked: a form submission and an edit
// both end up as commits to content.json via the Edit module's GitHub store.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { sign } from "../src/auth.js";

// Minimal in-memory GitHub: one branch, blobs/trees/commits by counter.
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
      const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
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
        if (objects[body.sha].parents[0] !== head) return new Response("not a fast forward", { status: 422 });
        head = body.sha;
        return ok({});
      }
      return new Response(`unexpected ${path}`, { status: 500 });
    },
  };
}

const claudeReply = {
  title: "Office Closed Monday", slug: "office-closed-monday", description: "We're closed Monday.",
  content: "<p>We're closed Monday.</p>", date: "2026-10-05", endDate: "2026-10-06", time: null,
  location: null, author: null, imageAlt: null, tags: [],
};

function setup(content) {
  const gh = fakeGitHub({ "content.json": JSON.stringify(content) });
  const kv = new Map();
  const env = {
    API_KEY: "k", ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", ALLOWED_ORIGINS: "*",
    CONTENT: { put: async (k, v) => kv.set(k, v), get: async (k) => kv.get(k) ?? null, list: async () => ({ keys: [] }) },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/")) return gh.handle(u, init);
    if (u.startsWith("https://api.anthropic.com/")) {
      return new Response(JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(claudeReply) }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { gh, env };
}

async function signed(url, method, body) {
  // Encode once and sign exactly those bytes (FormData gets a new boundary per Request).
  const encoded = body instanceof FormData ? new Request("https://x/", { method: "POST", body }) : null;
  const bytes = encoded ? await encoded.arrayBuffer() : new TextEncoder().encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`https://w.example${url}`, {
    method,
    body: bytes,
    headers: {
      Authorization: "Bearer k", "X-Timestamp": ts, "X-Signature": await sign("k", ts, bytes),
      "Content-Type": encoded ? encoded.headers.get("Content-Type") : "application/json",
    },
  });
}

test("a form submission is committed through the Edit module", async () => {
  const { gh, env } = setup({ pages: [], posts: [{ id: "p", slug: "office-closed-monday", title: "Old" }] });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ type: "announcement", title: "office closed", description: "closed monday", date: "2026-10-05", endDate: "2026-10-06", linkUrl: "https://example.org/hours" })) fd.append(k, v);
  const res = await worker.fetch(await signed("/submit", "POST", fd), env);
  const out = await res.json();
  assert.equal(res.status, 201, JSON.stringify(out));
  const content = JSON.parse(gh.files()["content.json"]);
  const a = content.announcements[0];
  assert.equal(a.title, "Office Closed Monday");
  assert.equal(a.linkUrl, "https://example.org/hours", "link kept exactly as typed");
  assert.equal(a.slug, "office-closed-monday-2", "slug stays unique across collections");
  assert.equal(out.slug, "office-closed-monday-2");
  assert.match(gh.commits[0], /^content: announcement "Office Closed Monday" via form/);
});

test("types that aren't enabled are refused", async () => {
  const { env } = setup({ pages: [] });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ type: "exhibition", title: "t", description: "d", date: "2026-10-05" })) fd.append(k, v);
  const res = await worker.fetch(await signed("/submit", "POST", fd), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).fields.type, /post, event, announcement/);
});

test("edit and delete through the Worker commit to GitHub", async () => {
  const { gh, env } = setup({ pages: [{ id: "1", slug: "about", title: "About", content: "<p>a</p>" }], posts: [] });
  const got = await (await worker.fetch(new Request("https://w.example/entries/pages/1", { headers: { Authorization: "Bearer k" } }), env)).json();
  const put = await worker.fetch(await signed("/entries/pages/1", "PUT", { changes: { title: "About us" }, version: got.version, by: "staff@example.org" }), env);
  assert.equal(put.status, 200);
  assert.equal(JSON.parse(gh.files()["content.json"]).pages[0].title, "About us");
  assert.match(gh.commits.at(-1), /edit page "About us" \(by staff@example.org\)/);

  const stale = await worker.fetch(await signed("/entries/pages/1", "PUT", { changes: { title: "X" }, version: got.version }), env);
  assert.equal(stale.status, 409);

  const del = await worker.fetch(await signed("/entries/pages/1", "DELETE", { reason: "old" }), env);
  assert.equal(del.status, 200);
  assert.equal(JSON.parse(gh.files()["content.json"]).pages.length, 0);
  assert.equal(JSON.parse(gh.files()["trash.json"]).deleted[0].entry.title, "About us");
});
