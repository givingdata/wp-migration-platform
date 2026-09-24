// Staff editing routes (the form's "Edit existing" mode), on top of the Edit module.
//
//   GET    /entries                          everything on the site, by collection
//   GET    /entries/:collection/:id          one entry + its version
//   PUT    /entries/:collection/:id          { changes, version, by }    → commit
//   DELETE /entries/:collection/:id          { version, reason, by }     → moved to trash.json
//   GET    /trash                            deleted entries
//   POST   /trash/:trashId/restore           { by }                      → back on the site
//
// Reads need the API key; changes also need the HMAC signature (like /submit).
// Returns null for paths it doesn't handle.
import { authenticate, AuthError, safeEqual } from "./auth.js";
import { EditError } from "../../lib/edit/index.js";

const MAX_BODY = 512 * 1024;

function requireApiKey(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!env.API_KEY || !token || !safeEqual(token, env.API_KEY)) throw new AuthError("Invalid or missing API key");
}

async function signedJson(request, env) {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) throw new EditError("Request too large", 413);
  await authenticate(request, raw, env);
  if (!raw.byteLength) return {};
  try {
    const body = JSON.parse(new TextDecoder().decode(raw));
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new EditError("Body must be JSON");
  }
}

// Who made the change, as the form reports it (Cloudflare Access login when available).
const who = (body) => (typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 200) : null);

/** @returns {Promise<{status: number, body: object} | null>} */
export async function handleEditRoute(request, env, getEditor) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  let m;

  if (pathname === "/entries" && method === "GET") {
    requireApiKey(request, env);
    return { status: 200, body: { success: true, ...(await getEditor().list()) } };
  }
  if ((m = pathname.match(/^\/entries\/([a-z0-9_-]+)\/([^/]+)$/))) {
    const [, collection, rawId] = m;
    const id = decodeURIComponent(rawId);
    if (method === "GET") {
      requireApiKey(request, env);
      return { status: 200, body: { success: true, ...(await getEditor().get(collection, id)) } };
    }
    if (method === "PUT") {
      const body = await signedJson(request, env);
      const result = await getEditor().update(collection, id, body.changes, { version: body.version, by: who(body) });
      return { status: 200, body: { success: true, entry: result.entry, version: result.version, commit: result.commit } };
    }
    if (method === "DELETE") {
      const body = await signedJson(request, env);
      const result = await getEditor().remove(collection, id, { version: body.version, reason: body.reason, by: who(body) });
      return { status: 200, body: { success: true, trashId: result.trashId, commit: result.commit } };
    }
  }
  if (pathname === "/trash" && method === "GET") {
    requireApiKey(request, env);
    return { status: 200, body: { success: true, items: await getEditor().trash() } };
  }
  if ((m = pathname.match(/^\/trash\/([0-9a-f-]{36})\/restore$/)) && method === "POST") {
    const body = await signedJson(request, env);
    const result = await getEditor().restore(m[1], { by: who(body) });
    return { status: 200, body: { success: true, collection: result.collection, entry: result.entry, slugChanged: result.slugChanged, commit: result.commit } };
  }
  return null;
}
