// Request signing shared by the form (browser) and tests (Node 18+).
// Must match worker/src/auth.js:
//   X-Signature = hex(HMAC-SHA256(secret, `${timestamp}.` + rawBody))

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, timestamp, bodyBuffer) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode(`${timestamp}.`);
  const body = new Uint8Array(bodyBuffer);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix, 0);
  payload.set(body, prefix.length);
  return toHex(await crypto.subtle.sign("HMAC", key, payload));
}

/**
 * Serialize FormData to the exact multipart bytes that will be sent, and sign them.
 * Returns { body, headers } ready for fetch().
 */
export async function signedMultipart(formData, { apiKey, hmacSecret }, now = Date.now()) {
  // Let the platform encode the multipart body once, then send those same bytes.
  const draft = new Request("https://sign.invalid/", { method: "POST", body: formData });
  const body = await draft.arrayBuffer();
  const timestamp = String(Math.floor(now / 1000));
  const signature = await hmacHex(hmacSecret || apiKey, timestamp, body);
  return {
    body,
    headers: {
      "Content-Type": draft.headers.get("Content-Type"),
      Authorization: `Bearer ${apiKey}`,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
  };
}
