import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { firstLink, allLinks, readablePage, fetchLinkedPage, fetchImageLink, findLinkedImage } from "../src/linked-page.js";
import { MAX_FILE_BYTES } from "../src/slack.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("firstLink: Slack's <url|label>, bare links, trailing punctuation, nothing", () => {
  assert.equal(firstLink("Post this as news <https://paper.example/a?b=1|paper.example/a>"), "https://paper.example/a?b=1");
  assert.equal(firstLink("see https://paper.example/story)."), "https://paper.example/story");
  assert.equal(firstLink("<mailto:a@b.org|a@b.org> only"), null);
  assert.equal(firstLink("no link"), null);
});

test("readablePage: title, description and the article text, without navigation or scripts", () => {
  const page = readablePage(`<html><head><title>Ignored</title><meta property="og:title" content="Museum wins award"><meta name="description" content="A local museum was honoured."><script>x()</script></head>
    <body><nav>Home | News</nav><article><h1>Museum wins award</h1><p>The Test Museum won the &ldquo;Heritage Prize&rdquo; on May 3.</p><aside>Ads</aside></article><footer>©</footer></body></html>`);
  assert.equal(page.title, "Museum wins award");
  assert.equal(page.description, "A local museum was honoured.");
  assert.match(page.text, /won the “Heritage Prize” on May 3/);
  assert.ok(!/Home \| News|Ads|x\(\)/.test(page.text));
});

test("fetchLinkedPage: HTML only, never throws", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("pdf")) return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
    if (String(url).includes("down")) throw new Error("network");
    return new Response("<title>Hi</title><p>Text</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  assert.equal((await fetchLinkedPage("https://ok.example/")).title, "Hi");
  assert.equal(await fetchLinkedPage("https://x.example/file.pdf"), null);
  assert.equal(await fetchLinkedPage("https://down.example/"), null);
});

test("allLinks: every link in order, no repeats, at most three", () => {
  assert.deepEqual(allLinks("Use <https://img.example/a.jpg|a.jpg> for https://site.example/news/ and <https://img.example/a.jpg>"), ["https://img.example/a.jpg", "https://site.example/news/"]);
  assert.equal(allLinks("https://a.example/1 https://a.example/2 https://a.example/3 https://a.example/4").length, 3);
  assert.deepEqual(allLinks("<mailto:a@b.org|a@b.org>"), []);
});

const imageServer = (routes) => async (url) => {
  const route = routes[String(url)];
  if (!route) throw new Error("network");
  return route();
};

test("fetchImageLink: a JPEG, PNG or WebP link is a photo; web pages and dead links are not", async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  globalThis.fetch = imageServer({
    "https://img.example/bread%20loaf.jpg": () => new Response(jpg, { headers: { "content-type": "image/jpeg" } }),
    "https://site.example/article": () => new Response("<title>x</title>", { headers: { "content-type": "text/html" } }),
    "https://img.example/gone.jpg": () => new Response("no", { status: 404, headers: { "content-type": "image/jpeg" } }),
  });
  const photo = await fetchImageLink("https://img.example/bread%20loaf.jpg");
  assert.deepEqual([...photo.bytes], [...jpg]);
  assert.equal(photo.type, "image/jpeg");
  assert.equal(photo.name, "bread loaf.jpg");
  assert.equal(await fetchImageLink("https://site.example/article"), null);
  assert.equal(await fetchImageLink("https://img.example/gone.jpg"), null);
  assert.equal(await fetchImageLink("https://down.example/x.jpg"), null);
});

test("fetchImageLink: other image types and big images are refused, even without a content-length", async () => {
  const big = new Uint8Array(MAX_FILE_BYTES + 1);
  globalThis.fetch = imageServer({
    "https://img.example/a.gif": () => new Response("GIF89a", { headers: { "content-type": "image/gif" } }),
    "https://img.example/said-big.jpg": () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(MAX_FILE_BYTES + 1) } }),
    "https://img.example/is-big.jpg": () => new Response(new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), { headers: { "content-type": "image/jpeg" } }),
  });
  await assert.rejects(fetchImageLink("https://img.example/a.gif"), /unsupported_type/);
  await assert.rejects(fetchImageLink("https://img.example/said-big.jpg"), /too_large/);
  await assert.rejects(fetchImageLink("https://img.example/is-big.jpg"), /too_large/);
});

test("findLinkedImage: the first link that is an image, or null", async () => {
  globalThis.fetch = imageServer({
    "https://site.example/news": () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } }),
    "https://img.example/a.webp": () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } }),
  });
  assert.equal((await findLinkedImage("Add this https://site.example/news with <https://img.example/a.webp>")).url, "https://img.example/a.webp");
  assert.equal(await findLinkedImage("Add this https://site.example/news"), null);
  assert.equal(await findLinkedImage("no links"), null);
});
