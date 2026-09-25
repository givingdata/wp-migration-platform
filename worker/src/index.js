// Content submission Worker.
//
//   POST /submit        multipart form → validate → R2 images → Claude → KV → GitHub commit
//   GET  /content/:id   submission record from KV (auth required)
//   GET  /content       recent submissions (auth required)
//   GET  /specs         public design specs (content types, image rules) for the form
//   GET  /health
//   /entries, /trash    staff editing: see edit-routes.js
//   /slack/*            staff ask for changes in Slack (off unless SLACK_SIGNING_SECRET): slack.js, slack-flow.js
//
// See worker/README.md for the full API contract.
import specs from "../../config/design-specs.json" with { type: "json" };
import { authenticate, AuthError, safeEqual } from "./auth.js";
import { structureContent, ClaudeError } from "./claude.js";
import { storeImage, saveSubmission, getSubmission, listSubmissions } from "./cloudflare.js";
import { editorFor, GitHubError } from "./content.js";
import { handleEditRoute } from "./edit-routes.js";
import { handleSlackRoute } from "./slack.js";
import { slackHandlers, onSiteDeployed } from "./slack-flow.js";
import { handleDeployNotify, DeployAuthError } from "./deploys.js";
import { contentTypes } from "../../lib/content-types.js";
import { EditError, StaleError } from "../../lib/edit/index.js";

const TYPES = contentTypes(specs);
const ENABLED = Object.keys(TYPES).filter((k) => TYPES[k].enabled);

const MAX_TEXT = { title: 200, description: 20000, other: 2000 };
const RESERVED_FIELDS = new Set(["type", "title", "description", "date", "image"]);

class HttpError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : allowed[0] || "";
  return {
    ...(allow ? { "Access-Control-Allow-Origin": allow } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Signature, X-Timestamp",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request, env) },
  });
}

/** Parse and validate the multipart body. Returns { submission, imageFile }. */
async function parseSubmission(request, rawBody) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("multipart/form-data")) throw new HttpError("Content-Type must be multipart/form-data", 415);

  let form;
  try {
    form = await new Request(request.url, { method: "POST", headers: { "Content-Type": contentType }, body: rawBody }).formData();
  } catch {
    throw new HttpError("Could not parse multipart form data");
  }

  const errors = {};
  const text = (name) => {
    const v = form.get(name);
    return typeof v === "string" ? v.trim() : "";
  };

  const type = text("type");
  const typeSpec = ENABLED.includes(type) ? TYPES[type] : null;
  if (!typeSpec) errors.type = `Must be one of: ${ENABLED.join(", ")}`;

  const title = text("title");
  if (!title) errors.title = "Required";
  else if (title.length > MAX_TEXT.title) errors.title = `Max ${MAX_TEXT.title} characters`;

  const description = text("description");
  if (!description) errors.description = "Required";
  else if (description.length > MAX_TEXT.description) errors.description = `Max ${MAX_TEXT.description} characters`;

  const date = text("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) errors.date = "Required, format YYYY-MM-DD";

  // Any other declared field for this type (endDate, time, location, author, linkUrl, …)
  const fields = {};
  for (const name of typeSpec?.fields || []) {
    if (RESERVED_FIELDS.has(name)) continue;
    const v = text(name);
    if (v.length > MAX_TEXT.other) errors[name] = `Max ${MAX_TEXT.other} characters`;
    else if (name === "linkUrl" && v && !/^(https?:\/\/|\/)\S*$/i.test(v)) errors[name] = "Must start with https:// (or / for a page on this site)";
    else if (name === "endDate" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[name] = "Format YYYY-MM-DD";
    else if (v) fields[name] = v;
  }

  let imageFile = form.get("image");
  if (!(imageFile instanceof File) || imageFile.size === 0) imageFile = null;
  if (imageFile) {
    const accepted = specs.image?.acceptedMimeTypes || [];
    if (accepted.length && !accepted.includes(imageFile.type)) errors.image = `Unsupported type ${imageFile.type || "unknown"}; use ${accepted.join(", ")}`;
    else if (imageFile.size > (specs.image?.maxUploadBytes ?? Infinity)) errors.image = `Image too large (max ${Math.round(specs.image.maxUploadBytes / 1048576)} MB)`;
  }

  if (Object.keys(errors).length) throw new HttpError("Validation failed", 400, errors);
  return { submission: { type, title, description, date, fields, hasImage: !!imageFile }, typeSpec, imageFile };
}

async function handleSubmit(request, env) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  const limit = (specs.image?.maxUploadBytes ?? 10 * 1048576) + 1048576;
  if (declared > limit) throw new HttpError("Request too large", 413);

  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > limit) throw new HttpError("Request too large", 413);
  await authenticate(request, rawBody, env);

  const { submission, typeSpec, imageFile } = await parseSubmission(request, rawBody);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record = { id, status: "received", submission, createdAt: now, updatedAt: now };

  // 1. Images → R2 (original + optimized variants)
  let media = null;
  if (imageFile) {
    try {
      media = await storeImage(env, specs, typeSpec, id, imageFile);
    } catch (e) {
      throw new HttpError(`Image processing failed: ${e.message}`, 422);
    }
  }

  // 2. Claude → structured entry
  const structured = await structureContent(env, submission, typeSpec);
  const entry = {
    id,
    slug: structured.slug || structured.title,
    title: structured.title || submission.title,
    description: structured.description,
    content: structured.content,
    image: media?.image ?? null,
    images: media?.images ?? [],
    imageVariants: media?.variants ?? {},
    imageAlt: media ? structured.imageAlt || structured.title : null,
    date: structured.date || submission.date,
    endDate: structured.endDate,
    time: structured.time,
    location: structured.location,
    author: structured.author,
    // Links are used exactly as typed, never rewritten by Claude.
    linkUrl: submission.fields.linkUrl ?? null,
    tags: structured.tags || [],
    source: "form",
    createdAt: now,
  };

  // 3. KV
  Object.assign(record, { status: "structured", entry, media, updatedAt: new Date().toISOString() });
  await saveSubmission(env, record);

  // 4. GitHub commit → triggers site rebuild
  try {
    const saved = await editorFor(env).create(submission.type, entry, { message: `content: ${typeSpec.label.toLowerCase()} "${entry.title}" via form\n\nSubmission ${id}` });
    Object.assign(entry, saved.entry);
    const commit = saved.commit;
    Object.assign(record, { status: "committed", entry, commit, updatedAt: new Date().toISOString() });
    await saveSubmission(env, record);
  } catch (e) {
    console.error("GitHub commit failed", id, e.message);
    Object.assign(record, { status: "commit_failed", error: e.message, updatedAt: new Date().toISOString() });
    await saveSubmission(env, record);
    return {
      status: 202,
      body: {
        success: true,
        published: false,
        contentId: id,
        url: entry.image,
        entry,
        message: "Content saved, but publishing to the site failed. It will not appear until an administrator republishes it.",
      },
    };
  }

  return {
    status: 201,
    body: {
      success: true,
      published: true,
      contentId: id,
      url: entry.image,
      slug: entry.slug,
      entry,
      commit: record.commit,
      message: "Content submitted and scheduled for rebuild",
    },
  };
}

async function requireApiKey(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!env.API_KEY || !token || !safeEqual(token, env.API_KEY)) throw new AuthError("Invalid or missing API key");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Slack signs its requests and isn't a browser, so these skip the API key and CORS.
    if (pathname.startsWith("/slack")) {
      const slack = await handleSlackRoute(request, env, ctx, slackHandlers(env, () => editorFor(env))).catch((e) => {
        console.error("slack route failed:", e.message);
        return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "Content-Type": "application/json" } });
      });
      if (slack) return slack;
    }

    // The site workflow reports each deploy (GitHub OIDC token, not the API key): Slack shows "Live".
    if (pathname === "/deploy/notify" && request.method === "POST") {
      const res = await handleDeployNotify(request, env, (record, status) => onSiteDeployed(env, record, status)).catch((e) => {
        if (!(e instanceof DeployAuthError)) console.error("deploy notify failed:", e.message);
        return { status: e.status || 500, body: { ok: false, error: e instanceof DeployAuthError ? e.message : "Server error" } };
      });
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    try {
      if (pathname === "/health" && request.method === "GET") {
        return json({ ok: true, images: !!env.IMAGES }, 200, request, env);
      }
      if (pathname === "/specs" && request.method === "GET") {
        return json(specs, 200, request, env);
      }
      if (pathname === "/submit" && request.method === "POST") {
        const { status, body } = await handleSubmit(request, env);
        return json(body, status, request, env);
      }
      const edit = await handleEditRoute(request, env, () => editorFor(env));
      if (edit) return json(edit.body, edit.status, request, env);
      if (pathname === "/content" && request.method === "GET") {
        await requireApiKey(request, env);
        return json({ success: true, items: await listSubmissions(env) }, 200, request, env);
      }
      const match = pathname.match(/^\/content\/([0-9a-f-]{36})$/);
      if (match && request.method === "GET") {
        await requireApiKey(request, env);
        const record = await getSubmission(env, match[1]);
        if (!record) throw new HttpError("Not found", 404);
        return json({ success: true, ...record }, 200, request, env);
      }
      throw new HttpError("Not found", 404);
    } catch (e) {
      const known = [HttpError, AuthError, ClaudeError, EditError, StaleError].some((k) => e instanceof k);
      const status = known ? e.status : e instanceof GitHubError ? 502 : 500;
      if (status >= 500) console.error(e.stack || e.message);
      const message = e instanceof GitHubError ? "Couldn't reach the site's content on GitHub; try again in a minute" : status >= 500 && !(e instanceof ClaudeError) ? "Internal error" : e.message;
      return json({ success: false, error: message, ...(e.details ? { fields: e.details } : {}) }, status, request, env);
    }
  },
};
