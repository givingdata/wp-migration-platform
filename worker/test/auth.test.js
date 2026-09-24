import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, sign, AuthError } from "../src/auth.js";
import { targetWidths, parseRatio } from "../src/cloudflare.js";

const env = { API_KEY: "test-key" };
const body = new TextEncoder().encode("--boundary\r\nhello\r\n--boundary--").buffer;
const now = 1_790_000_000_000;
const ts = String(Math.floor(now / 1000));

function req(headers) {
  return new Request("https://w.example/submit", { method: "POST", headers });
}

test("accepts a correctly signed request", async () => {
  const sig = await sign(env.API_KEY, ts, body);
  await authenticate(req({ Authorization: "Bearer test-key", "X-Timestamp": ts, "X-Signature": sig }), body, env, now);
});

test("rejects wrong API key, bad signature, tampered body and stale timestamp", async () => {
  const sig = await sign(env.API_KEY, ts, body);
  const cases = [
    [{ Authorization: "Bearer nope", "X-Timestamp": ts, "X-Signature": sig }, body, now],
    [{ Authorization: "Bearer test-key", "X-Timestamp": ts, "X-Signature": "00".repeat(32) }, body, now],
    [{ Authorization: "Bearer test-key", "X-Timestamp": ts, "X-Signature": sig }, new TextEncoder().encode("tampered").buffer, now],
    [{ Authorization: "Bearer test-key", "X-Timestamp": ts, "X-Signature": sig }, body, now + 600_000],
  ];
  for (const [headers, b, t] of cases) {
    await assert.rejects(authenticate(req(headers), b, env, t), AuthError);
  }
});

test("image widths respect breakpoints, type limits and source size", () => {
  const specs = { breakpoints: [300, 600, 800, 1200] };
  assert.deepEqual(targetWidths(specs, { minWidth: 300, maxWidth: 1200 }, 4000), [300, 600, 800, 1200]);
  assert.deepEqual(targetWidths(specs, { minWidth: 300, maxWidth: 1200 }, 700), [300, 600]);
  assert.deepEqual(targetWidths(specs, { minWidth: 300, maxWidth: 1200 }, 200), [200]);
  assert.equal(parseRatio("1.5:1"), 1.5);
  assert.equal(parseRatio("16:9"), 16 / 9);
});
