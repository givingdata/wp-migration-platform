// Site deploys → "Live" in Slack. When a Slack change is approved, its commit is remembered with
// the Slack message (KV `deploy:pending:<sha>`, 2 days). The site workflow (_site.yml) calls
//
//   POST /deploy/notify  { sha, status: "success" | "failure" }
//   Authorization: Bearer <GitHub Actions OIDC token, audience DEPLOY_AUDIENCE>
//
// after each Pages deploy. The token proves the call comes from this client's repo (no shared
// secret to set up). Every remembered commit the deployed build includes is marked live (or
// failed): a quick second approval can supersede the first build, so it's "included in", not "equal
// to", checked with GitHub's compare API.
import { safeEqual } from "./auth.js";

export const DEPLOY_AUDIENCE = "1wp-deploy";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const PENDING = "deploy:pending:";
const PENDING_TTL = 2 * 86_400;
const SHA = /^[0-9a-f]{40}$/;

export class DeployAuthError extends Error {
  status = 401;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodePart = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

let jwksCache = null; // { keys, at }
async function signingKey(kid) {
  for (const fresh of [false, true]) {
    if (fresh || !jwksCache || Date.now() - jwksCache.at > 3_600_000) {
      const res = await fetch(JWKS_URL);
      if (!res.ok) throw new Error(`GitHub JWKS: HTTP ${res.status}`);
      jwksCache = { keys: (await res.json()).keys ?? [], at: Date.now() };
    }
    const jwk = jwksCache.keys.find((k) => k.kid === kid);
    if (jwk) return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (fresh) break;
  }
  throw new DeployAuthError("Unknown signing key");
}

/** Checks a GitHub Actions OIDC token: GitHub's signature, audience, expiry, and this Worker's repo. Returns its claims. */
export async function verifyDeployToken(token, env, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new DeployAuthError("Missing or malformed token");
  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw new DeployAuthError("Malformed token");
  }
  if (header.alg !== "RS256") throw new DeployAuthError("Unexpected token algorithm");
  const key = await signingKey(header.kid);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed))) throw new DeployAuthError("Bad signature");

  const secs = now / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !aud.includes(DEPLOY_AUDIENCE)) throw new DeployAuthError("Wrong issuer or audience");
  if (!(claims.exp > secs - 60) || (claims.nbf && claims.nbf > secs + 60)) throw new DeployAuthError("Token expired");
  const repo = String(env.GITHUB_REPO || "").toLowerCase();
  if (!repo || !safeEqual(String(claims.repository || "").toLowerCase(), repo)) throw new DeployAuthError("Token is for another repo");
  return claims;
}

/** Remember an approved commit and its Slack message until the site deploy reports back. */
export async function rememberDeploy(env, { sha, channel, messageTs, proposalId }) {
  if (!env.CONTENT || !SHA.test(String(sha))) return;
  await env.CONTENT.put(`${PENDING}${sha}`, JSON.stringify({ sha, channel, messageTs, proposalId, at: new Date().toISOString() }), { expirationTtl: PENDING_TTL });
}

// True when `commit` is part of `deployed` (the same commit or an ancestor of it).
async function included(env, commit, deployed) {
  if (commit === deployed) return true;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/compare/${commit}...${deployed}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "wp-migration-platform-worker" },
  });
  if (!res.ok) return false;
  const { status } = await res.json();
  return status === "ahead" || status === "identical";
}

/**
 * POST /deploy/notify. onDeployed(record, "live" | "failed") updates the Slack message; a live
 * record is forgotten, a failed one kept so a later successful build can still mark it live.
 * Returns { status, body }.
 */
export async function handleDeployNotify(request, env, onDeployed) {
  const header = request.headers.get("Authorization") || "";
  await verifyDeployToken(header.startsWith("Bearer ") ? header.slice(7).trim() : "", env);
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { ok: false, error: "Body must be JSON" } };
  }
  const { sha, status } = body ?? {};
  if (!SHA.test(String(sha)) || !["success", "failure"].includes(status)) return { status: 400, body: { ok: false, error: "Needs sha and status" } };
  if (!env.CONTENT) return { status: 200, body: { ok: true, updated: 0 } };

  let updated = 0;
  const { keys } = await env.CONTENT.list({ prefix: PENDING });
  for (const { name } of keys) {
    const record = JSON.parse((await env.CONTENT.get(name)) || "null");
    if (!record || !(await included(env, record.sha, sha))) continue;
    try {
      await onDeployed(record, status === "success" ? "live" : "failed");
      updated++;
    } catch (e) {
      console.error("deploy notify: couldn't update", record.sha, e.message);
    }
    if (status === "success") await env.CONTENT.delete(name);
  }
  return { status: 200, body: { ok: true, updated } };
}
