// 1wp-slack: the one Slack app for every client (see ../README.md).
//
//   POST /slack/events          Slack-signed. message → its channel's client; team_join → add the
//                               new member to their client's channel (matched on staff email/domain)
//   POST /slack/interactions    Slack-signed. Approve/Cancel click → its channel's client
//   POST /api/<method>          client-signed. The client Worker's only way to call Slack: a few
//                               methods, in its own channel only
//   GET  /admin/clients         ADMIN_KEY. List clients
//   POST /admin/clients         ADMIN_KEY. Add or update a client (creates its private channel)
//   POST /admin/clients/remove  ADMIN_KEY. Remove a client and archive its channel
//
// Router → client: POST <client url>/slack/inbox, signed with the client's key. Clients are KV
// records, so adding, pausing or removing one never redeploys this Worker. This Worker holds the
// only Slack secrets. Never logs message text, emails or tokens.
import {
  verifySlackSignature, isStaffMessage, messageFromEvent, actionFromPayload,
  routerHeaders, verifyRouterRequest, slackDirect, slackApi, SlackError,
} from "../../worker/src/slack.js";
import { isStaff } from "../../worker/src/slack-access.js";
import { toHex, safeEqual } from "../../worker/src/auth.js";

const MAX_BODY = 256 * 1024;
const EVENT_TTL = 3600;
const SEEN_USER_TTL = 30 * 86400;

// Web API methods a client may call. Value: the body field holding the channel (null = none).
const ALLOWED = {
  "chat.postMessage": "channel",
  "chat.update": "channel",
  "chat.postEphemeral": "channel",
  "reactions.add": "channel",
  "reactions.remove": "channel",
  "users.info": null,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const list = (value) => String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Run after the response; errors logged, never thrown.
function later(ctx, label, fn) {
  ctx.waitUntil(Promise.resolve().then(fn).catch((e) => console.error(`router ${label} failed:`, e?.message || e)));
}

// ---- clients (KV) -------------------------------------------------------------------------------
// client:<name> = { client, url, channel, staffEmails[], staffDomains[], paused, keyVersion }
// channel:<id>  = <name>

const getClient = async (env, name) => JSON.parse((await env.ROUTER.get(`client:${name}`)) || "null");

async function clientForChannel(env, channel) {
  const name = channel && (await env.ROUTER.get(`channel:${channel}`));
  const client = name && (await getClient(env, name));
  return client && !client.paused ? client : null;
}

async function allClients(env) {
  const { keys } = await env.ROUTER.list({ prefix: "client:" });
  return (await Promise.all(keys.map((k) => getClient(env, k.name.slice("client:".length))))).filter(Boolean);
}

/** The client's rule, same as its Worker's isStaff (slack-access.js). */
const staffOf = (client, email) =>
  isStaff({ SLACK_STAFF_EMAILS: (client.staffEmails || []).join(","), SLACK_STAFF_DOMAINS: (client.staffDomains || []).join(",") }, email);

/** SLACK_ROUTER_KEY for a client: hex HMAC-SHA256(ROUTER_SECRET, "<name>:<keyVersion>"). */
export async function clientKey(env, name, version = 1) {
  if (!env.ROUTER_SECRET) throw new SlackError("Server is missing ROUTER_SECRET", 500);
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.ROUTER_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${name}:${version}`)));
}

// This user acted in (or was added to) this client's channel, so the client may look up their email.
const markSeen = (env, name, user) =>
  user ? env.ROUTER.put(`seen:${name}:${user}`, "1", { expirationTtl: SEEN_USER_TTL }) : null;

// ---- router → client ----------------------------------------------------------------------------

// The client answers at once and does the work in its own waitUntil.
async function forward(env, client, kind, data) {
  const bytes = encoder.encode(JSON.stringify({ kind, data }));
  const res = await fetch(`${client.url}/slack/inbox`, {
    method: "POST",
    headers: await routerHeaders(await clientKey(env, client.client, client.keyVersion), client.client, bytes),
    body: bytes,
  });
  if (!res.ok) throw new Error(`${client.client} inbox: HTTP ${res.status}`);
}

// ---- Slack → router -----------------------------------------------------------------------------

async function firstSighting(env, eventId) {
  if (!eventId) return true;
  const key = `event:${eventId}`;
  if (await env.ROUTER.get(key)) return false;
  await env.ROUTER.put(key, "1", { expirationTtl: EVENT_TTL });
  return true;
}

// A new workspace member on a client's staff list goes into that client's channel.
async function onTeamJoin(env, user) {
  if (!user?.id || user.is_bot || user.deleted) return;
  let email = user.profile?.email;
  if (!email) email = (await slackApi(env, "users.info", { user: user.id })).user?.profile?.email;
  if (!email) return;
  for (const client of await allClients(env)) {
    if (client.paused || !staffOf(client, email)) continue;
    await slackApi(env, "conversations.invite", { channel: client.channel, users: user.id });
    await markSeen(env, client.client, user.id);
  }
}

async function events(raw, env, ctx) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false }, 400);
  }
  if (body?.type === "url_verification") return json({ challenge: body.challenge });
  if (body?.type !== "event_callback" || !(await firstSighting(env, body.event_id))) return json({ ok: true });

  const event = body.event;
  if (event?.type === "team_join") {
    later(ctx, "team_join", () => onTeamJoin(env, event.user));
  } else if (isStaffMessage(event)) {
    later(ctx, "message", async () => {
      const client = await clientForChannel(env, event.channel);
      if (!client) return; // not a client channel, or paused
      await markSeen(env, client.client, event.user);
      await forward(env, client, "message", messageFromEvent(body));
    });
  }
  return json({ ok: true });
}

function interactions(raw, env, ctx) {
  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") || "");
  } catch {
    return json({ ok: false }, 400);
  }
  const act = actionFromPayload(payload);
  if (act) {
    later(ctx, "action", async () => {
      const client = await clientForChannel(env, act.channel);
      if (!client) return;
      await markSeen(env, client.client, act.user);
      await forward(env, client, "action", act);
    });
  }
  return new Response(null, { status: 200 });
}

// ---- client → Slack (POST /api/<method>) --------------------------------------------------------

async function clientApi(request, bytes, env, method) {
  const name = request.headers.get("x-1wp-client") || "";
  const client = /^[a-z0-9-]{1,40}$/.test(name) ? await getClient(env, name) : null;
  if (!client || client.paused) return json({ ok: false, error: "unknown_client" }, 401);
  if (!(await verifyRouterRequest(await clientKey(env, name, client.keyVersion), request, bytes))) return json({ ok: false, error: "bad_signature" }, 401);

  if (!Object.hasOwn(ALLOWED, method)) return json({ ok: false, error: "method_not_allowed" }, 403);
  let body;
  try {
    body = JSON.parse(decoder.decode(bytes) || "{}");
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  if (ALLOWED[method] && body?.[ALLOWED[method]] !== client.channel) return json({ ok: false, error: "not_your_channel" }, 403);
  if (method === "users.info" && !(await env.ROUTER.get(`seen:${name}:${body?.user}`))) return json({ ok: false, error: "unknown_user" }, 403);

  return json(await slackDirect(env, method, body));
}

// ---- setup (/admin/*, ADMIN_KEY) ----------------------------------------------------------------

async function pages(env, method, body, field) {
  const out = [];
  let cursor = "";
  do {
    const data = await slackApi(env, method, { ...body, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(data[field] || []));
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return out;
}

// Invite workspace members who are this client's staff (or SUPPORT_EMAILS) and aren't in the
// channel yet. With prune, also remove channel members who are neither (never bots).
async function syncMembers(env, client, { prune = false } = {}) {
  const support = list(env.SUPPORT_EMAILS);
  const people = (await pages(env, "users.list", {}, "members")).filter((u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT");
  const belongs = (u) => {
    const email = String(u.profile?.email || "").toLowerCase();
    return !!email && (support.includes(email) || staffOf(client, email));
  };
  const members = new Set(await pages(env, "conversations.members", { channel: client.channel }, "members"));

  const invited = [];
  for (const u of people.filter(belongs)) {
    await markSeen(env, client.client, u.id);
    if (!members.has(u.id)) invited.push(u.id);
  }
  if (invited.length) await slackApi(env, "conversations.invite", { channel: client.channel, users: invited.join(",") });

  const removed = [];
  if (prune) {
    const humans = new Map(people.map((u) => [u.id, u]));
    for (const id of members) {
      const u = humans.get(id);
      if (u && !belongs(u)) {
        await slackApi(env, "conversations.kick", { channel: client.channel, user: id });
        removed.push(id);
      }
    }
  }
  return { invited: invited.length, removed: removed.length };
}

// Body: { client, url, channelName?, existingChannel?, staffEmails?, staffDomains?, paused?,
// rotateKey?, prune? }. Returns { channel, key, invited, removed } for the client Worker's settings.
async function upsertClient(input, env) {
  const name = String(input?.client || "").toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(name)) return json({ ok: false, error: "client must be lowercase letters, digits or -" }, 400);
  const existing = await getClient(env, name);
  const url = String(input.url || existing?.url || "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(url)) return json({ ok: false, error: "url must be the Worker's https:// origin" }, 400);

  let channel = existing?.channel;
  if (input.existingChannel && input.existingChannel !== channel) {
    const info = await slackDirect(env, "conversations.info", { channel: input.existingChannel });
    if (!info.ok || !info.channel?.is_member) return json({ ok: false, error: `The bot can't see ${input.existingChannel}. Type /invite @1WP in that channel first.` }, 400);
    channel = input.existingChannel;
  }
  if (!channel) {
    const made = await slackDirect(env, "conversations.create", { name: input.channelName || name, is_private: true });
    if (!made.ok) return json({ ok: false, error: `Couldn't create the channel: ${made.error}${made.error === "name_taken" ? " (pass existingChannel, or another channelName)" : ""}` }, 502);
    channel = made.channel.id;
  }
  const other = await env.ROUTER.get(`channel:${channel}`);
  if (other && other !== name) return json({ ok: false, error: `${channel} already belongs to ${other}` }, 409);

  const clean = (value, fallback) => (value === undefined ? fallback || [] : [].concat(value).map((s) => String(s).trim().toLowerCase().replace(/^@/, "")).filter(Boolean));
  const record = {
    client: name,
    url,
    channel,
    staffEmails: clean(input.staffEmails, existing?.staffEmails),
    staffDomains: clean(input.staffDomains, existing?.staffDomains),
    paused: input.paused === undefined ? !!existing?.paused : !!input.paused,
    keyVersion: (existing?.keyVersion || 1) + (input.rotateKey && existing ? 1 : 0),
  };
  if (existing?.channel && existing.channel !== channel) await env.ROUTER.delete(`channel:${existing.channel}`);
  await env.ROUTER.put(`client:${name}`, JSON.stringify(record));
  await env.ROUTER.put(`channel:${channel}`, name);

  const sync = record.paused ? { invited: 0, removed: 0 } : await syncMembers(env, record, { prune: !!input.prune });
  return json({ ok: true, created: !existing, ...record, key: await clientKey(env, name, record.keyVersion), ...sync });
}

async function removeClient(input, env) {
  const client = await getClient(env, String(input?.client || "").toLowerCase());
  if (!client) return json({ ok: false, error: "no such client" }, 404);
  await env.ROUTER.delete(`channel:${client.channel}`);
  await env.ROUTER.delete(`client:${client.client}`);
  // Archived, not deleted: a workspace admin can unarchive it.
  const archived = await slackDirect(env, "conversations.archive", { channel: client.channel });
  return json({ ok: true, archived: archived.ok || archived.error === "already_archived" });
}

async function admin(request, bytes, env, pathname) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_KEY || !safeEqual(auth, `Bearer ${env.ADMIN_KEY}`)) return json({ ok: false }, 401);
  if (request.method === "GET" && pathname === "/admin/clients") return json({ ok: true, clients: await allClients(env) });
  if (request.method !== "POST") return json({ ok: false }, 405);
  let input;
  try {
    input = JSON.parse(decoder.decode(bytes));
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }
  if (pathname === "/admin/clients") return upsertClient(input, env);
  if (pathname === "/admin/clients/remove") return removeClient(input, env);
  return json({ ok: false }, 404);
}

// ---- entry --------------------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname.startsWith("/admin/")) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_BODY) return json({ ok: false }, 413);
        return await admin(request, bytes, env, pathname);
      }
      if (request.method === "GET" && pathname === "/health") return json({ ok: true });
      if (request.method !== "POST") return json({ ok: false }, 405);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > MAX_BODY) return json({ ok: false }, 413);

      if (pathname === "/slack/events" || pathname === "/slack/interactions") {
        const raw = decoder.decode(bytes);
        const ok = await verifySlackSignature(env.SLACK_SIGNING_SECRET, request.headers.get("x-slack-request-timestamp"), raw, request.headers.get("x-slack-signature"));
        if (!ok) return json({ ok: false }, 401);
        return pathname === "/slack/events" ? await events(raw, env, ctx) : interactions(raw, env, ctx);
      }
      if (pathname.startsWith("/api/")) return await clientApi(request, bytes, env, pathname.slice("/api/".length));
      return json({ ok: false }, 404);
    } catch (e) {
      console.error("router failed:", e?.message || e);
      return json({ ok: false, error: e instanceof SlackError ? e.message : "server error" }, e?.status || 500);
    }
  },
};
