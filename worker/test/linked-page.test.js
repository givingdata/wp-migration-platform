import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { firstLink, readablePage, fetchLinkedPage } from "../src/linked-page.js";

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
