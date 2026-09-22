// Request authentication: Bearer API key + HMAC-SHA256 over the raw body.
//
// Signature scheme (form/form-handler.js implements the client side):
//   X-Timestamp: <unix seconds>
//   X-Signature: hex(HMAC-SHA256(key, `${timestamp}.` + rawBody))
// The key is HMAC_SECRET if set, otherwise API_KEY. Timestamps older than
// MAX_SKEW_SECONDS are rejected to limit replay.

export const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Constant-time comparison of two strings.
export function safeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function signedPayload(timestamp, body) {
  const prefix = encoder.encode(`${timestamp}.`);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const payload = new Uint8Array(prefix.length + bytes.length);
  payload.set(prefix, 0);
  payload.set(bytes, prefix.length);
  return payload;
}

export async function sign(secret, timestamp, body) {
  const key = await hmacKey(secret, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, signedPayload(timestamp, body)));
}

export async function verifySignature(secret, timestamp, body, signatureHex) {
  const signature = fromHex(signatureHex || "");
  if (!signature || signature.length !== 32) return false;
  const key = await hmacKey(secret, ["verify"]);
  // crypto.subtle.verify is constant-time.
  return crypto.subtle.verify("HMAC", key, signature, signedPayload(timestamp, body));
}

/**
 * Throws AuthError unless the request carries a valid API key and signature.
 * `rawBody` must be the exact bytes received (ArrayBuffer).
 */
export async function authenticate(request, rawBody, env, now = Date.now()) {
  if (!env.API_KEY) throw new AuthError("Server is missing API_KEY", 500);

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !safeEqual(token, env.API_KEY)) throw new AuthError("Invalid or missing API key");

  const timestamp = request.headers.get("X-Timestamp") || "";
  if (!/^\d{9,11}$/.test(timestamp)) throw new AuthError("Missing or malformed X-Timestamp");
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    throw new AuthError("Request timestamp outside allowed window; check the device clock");
  }

  const secret = env.HMAC_SECRET || env.API_KEY;
  const ok = await verifySignature(secret, timestamp, rawBody, request.headers.get("X-Signature"));
  if (!ok) throw new AuthError("Invalid signature");
}
