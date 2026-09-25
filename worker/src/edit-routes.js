// Staff editing routes (the form's "Edit existing" mode), on top of the Edit module.
//
//   GET    /entries                          everything on the site, by collection
//   GET    /entries/:collection/:id          one entry + its version
//   PUT    /entries/:collection/:id          { changes, version, by }    → commit
//   DELETE /entries/:collection/:id          { version, reason, removeFromMenu, by } → moved to trash.json
//   POST   /pages                            { fields, by }              → new page (text as written)
//   GET    /menu                             the main menu + pages it can link to
//   PUT    /menu                             { menu, version, by }       → commit
//   GET    /trash                            deleted entries
//   POST   /trash/:trashId/restore           { by }                      → back on the site (and in the menu)
//   POST   /images                           multipart "image"           → { url } for a designed page's image slot
//
// Designed pages (sections.json) use the same /entries routes with the collection "designed";
// their changes are { slot: text } (see lib/edit/sections.js).
//
// Reads need the API key; changes also need the HMAC signature (like /submit).
// Returns null for paths it doesn't handle.
import { authenticate, AuthError, safeEqual } from "./auth.js";
import { EditError } from "../../lib/edit/index.js";
import { storeImage } from "./cloudflare.js";
import specs from "../../config/design-specs.json" with { type: "json" };

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
      const result = await getEditor().remove(collection, id, { version: body.version, reason: body.reason, removeFromMenu: body.removeFromMenu === true, by: who(body) });
      return { status: 200, body: { success: true, trashId: result.trashId, removedFromMenu: result.removedFromMenu, commit: result.commit } };
    }
  }
  if (pathname === "/pages" && method === "POST") {
    const body = await signedJson(request, env);
    const result = await getEditor().createPage(body.fields || {}, { by: who(body) });
    return { status: 201, body: { success: true, collection: result.collection, entry: result.entry, path: result.path, commit: result.commit } };
  }
  if (pathname === "/menu" && method === "GET") {
    requireApiKey(request, env);
    return { status: 200, body: { success: true, ...(await getEditor().getMenu()) } };
  }
  if (pathname === "/menu" && method === "PUT") {
    const body = await signedJson(request, env);
    const result = await getEditor().saveMenu(body.menu, { version: body.version, by: who(body) });
    return { status: 200, body: { success: true, version: result.version, commit: result.commit } };
  }
  if (pathname === "/trash" && method === "GET") {
    requireApiKey(request, env);
    return { status: 200, body: { success: true, items: await getEditor().trash() } };
  }
  if (pathname === "/images" && method === "POST") return uploadImage(request, env);
  if ((m = pathname.match(/^\/trash\/([0-9a-f-]{36})\/restore$/)) && method === "POST") {
    const body = await signedJson(request, env);
    const result = await getEditor().restore(m[1], { by: who(body) });
    return { status: 200, body: { success: true, collection: result.collection, entry: result.entry, slugChanged: result.slugChanged, menuRestored: result.menuRestored, commit: result.commit } };
  }
  return null;
}

// An image for a designed page: stored in R2 like form uploads, resized but not cropped
// (sections decide their own shape). Nothing on the site changes until the page is saved.
async function uploadImage(request, env) {
  const limit = (specs.image?.maxUploadBytes ?? 10 * 1048576) + 65536;
  if (Number(request.headers.get("Content-Length") || 0) > limit) throw new EditError("Image too large", 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > limit) throw new EditError("Image too large", 413);
  await authenticate(request, raw, env);
  let file;
  try {
    const form = await new Request(request.url, { method: "POST", headers: { "Content-Type": request.headers.get("Content-Type") || "" }, body: raw }).formData();
    file = form.get("image");
  } catch {
    throw new EditError("Send the image as multipart form data");
  }
  if (!(file instanceof File) || !file.size) throw new EditError("Choose an image to upload");
  const accepted = specs.image?.acceptedMimeTypes || [];
  if (accepted.length && !accepted.includes(file.type)) throw new EditError(`Use a ${accepted.map((t) => t.split("/")[1].toUpperCase()).join(", ")} image`, 415);
  const media = await storeImage(env, specs, { aspectRatio: null, minWidth: 300, maxWidth: 1600 }, crypto.randomUUID(), file);
  return { status: 201, body: { success: true, url: media.image, original: media.original } };
}
