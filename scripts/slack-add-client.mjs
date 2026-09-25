#!/usr/bin/env node
// Connects this client to the shared 1WP Slack app (the 1wp-slack router, slack-router/README.md).
// Run in the client folder on the setup machine. Safe to re-run: it updates the client.
//
//   node ../../platform/scripts/slack-add-client.mjs <client> [options]
//     --domain acme.org[,…]      staff = anyone with an email at these domains
//     --emails a@x.org[,…]       and/or these exact emails
//     --existing-channel C…      use this channel (the bot must be in it) instead of creating #<client>
//     --channel-name <name>      name for the new private channel (default: <client>)
//     --worker-url https://…     default: the repo's WORKER_URL variable
//     --pause / --resume         stop / start answering in the channel (nothing is deleted)
//     --prune                    also remove channel members who aren't staff (never SUPPORT_EMAILS)
//     --rotate-key               new SLACK_ROUTER_KEY (the old one stops working)
//     --push                     commit and push worker/wrangler.toml (redeploys the Worker)
//   node …/slack-add-client.mjs --list
//   node …/slack-add-client.mjs <client> --remove     archive the channel, forget the client
//
// Needs SLACK_ROUTER_URL and SLACK_ROUTER_ADMIN_KEY: from the environment, or from
// ~/Documents/1WP/ops/.env.operator (setup machine only). Uses `gh` for the repo secret.
//
// What it does:
//   1. <router>/admin/clients → the router creates the private channel (first time), saves the
//      client and adds staff who are already in the workspace. Returns the channel and key.
//   2. GitHub secret SLACK_ROUTER_KEY on the client repo (the deploy workflow uploads it).
//   3. worker/wrangler.toml [vars]: SLACK_CLIENT, SLACK_ROUTER_URL, SLACK_CHANNEL_IDS, staff.
//   4. Tells you what's left: inviting new staff to the workspace (no invite API on Slack's free
//      plan). When they join, the router adds them to the channel.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function value(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const csv = (s) => (s === undefined ? undefined : s.split(",").map((x) => x.trim()).filter(Boolean));
const client = args[0] && !args[0].startsWith("--") ? args[0].toLowerCase() : undefined;

if (flag("--help") || flag("-h") || (!client && !flag("--list"))) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(client || flag("--list") ? 0 : 1);
}

function operatorEnv() {
  const file = join(homedir(), "Documents/1WP/ops/.env.operator");
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const op = operatorEnv();
const ROUTER_URL = (process.env.SLACK_ROUTER_URL || op.SLACK_ROUTER_URL || "").replace(/\/+$/, "");
const ADMIN_KEY = process.env.SLACK_ROUTER_ADMIN_KEY || op.SLACK_ROUTER_ADMIN_KEY;
if (!ROUTER_URL || !ADMIN_KEY) {
  console.error("Missing SLACK_ROUTER_URL / SLACK_ROUTER_ADMIN_KEY (environment or ~/Documents/1WP/ops/.env.operator).");
  process.exit(1);
}

async function admin(path, body) {
  const res = await fetch(`${ROUTER_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!out.ok) {
    console.error(`Router: ${out.error || `HTTP ${res.status}`}`);
    process.exit(1);
  }
  return out;
}

if (flag("--list")) {
  const { clients } = await admin("/admin/clients");
  for (const c of clients) {
    console.log(`${c.client}${c.paused ? " (paused)" : ""}  ${c.channel}  ${c.url}  staff: ${[...c.staffEmails, ...c.staffDomains.map((d) => `@${d}`)].join(", ") || "nobody"}`);
  }
  if (!clients.length) console.log("No clients yet.");
  process.exit(0);
}

if (flag("--remove")) {
  const out = await admin("/admin/clients/remove", { client });
  console.log(`Removed ${client}. Channel ${out.archived ? "archived" : "NOT archived (archive it in Slack)"}.`);
  console.log("The client Worker still has its Slack settings; they no longer do anything.");
  process.exit(0);
}

// The client repo (origin; client repos also have an `upstream` remote).
function repo() {
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  return origin.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}

let workerUrl = value("--worker-url");
if (!workerUrl) {
  try {
    workerUrl = execFileSync("gh", ["variable", "get", "WORKER_URL", "-R", repo()], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Not set, or gh unavailable. The router keeps the saved URL on a re-run.
  }
}

const out = await admin("/admin/clients", {
  client,
  url: workerUrl || undefined,
  channelName: value("--channel-name"),
  existingChannel: value("--existing-channel"),
  staffDomains: csv(value("--domain")),
  staffEmails: csv(value("--emails")),
  paused: flag("--pause") ? true : flag("--resume") ? false : undefined,
  prune: flag("--prune"),
  rotateKey: flag("--rotate-key"),
});

// 2. The key goes straight from the router's answer into the GitHub secret; it's never printed.
execFileSync("gh", ["secret", "set", "SLACK_ROUTER_KEY", "-R", repo()], { input: out.key, stdio: ["pipe", "ignore", "inherit"] });

// 3. Worker settings.
const tomlPath = "worker/wrangler.toml";
const before = readFileSync(tomlPath, "utf8");
function setVar(toml, name, val) {
  const line = `${name} = ${JSON.stringify(val)}`;
  const re = new RegExp(`^#?\\s*${name}\\s*=.*$`, "m");
  if (re.test(toml)) return toml.replace(re, line);
  return toml.replace(/^(\[vars\]\n)/m, `$1${line}\n`);
}
let toml = before;
toml = setVar(toml, "SLACK_CLIENT", client);
toml = setVar(toml, "SLACK_ROUTER_URL", ROUTER_URL);
toml = setVar(toml, "SLACK_CHANNEL_IDS", out.channel);
toml = setVar(toml, "SLACK_STAFF_EMAILS", out.staffEmails.join(","));
toml = setVar(toml, "SLACK_STAFF_DOMAINS", out.staffDomains.join(","));
if (toml !== before) writeFileSync(tomlPath, toml);

console.log(`${out.created ? "Added" : "Updated"} ${client}: channel ${out.channel}${out.paused ? " (paused)" : ""}.`);
console.log(`Staff: ${[...out.staffEmails, ...out.staffDomains.map((d) => `anyone @${d}`)].join(", ") || "nobody yet"}.`);
console.log(`Added to the channel now: ${out.invited}${out.removed ? `, removed: ${out.removed}` : ""}.`);
console.log("GitHub secret SLACK_ROUTER_KEY set.");

if (toml !== before || flag("--rotate-key")) {
  if (flag("--push")) {
    if (toml !== before) {
      execFileSync("git", ["add", tomlPath]);
      execFileSync("git", ["commit", "-m", `Slack: connect ${client} to the shared 1WP app`], { stdio: "inherit" });
      execFileSync("git", ["push"], { stdio: "inherit" });
    } else {
      execFileSync("gh", ["workflow", "run", "deploy-worker.yml", "-R", repo()], { stdio: "inherit" });
    }
    console.log("The Worker redeploys in a minute or two.");
  } else {
    console.log(`Next: commit and push ${tomlPath} (or re-run with --push) so the Worker picks this up.`);
  }
}
console.log("");
console.log("Left for you: invite staff who aren't in the FloMySite.com workspace yet.");
console.log("  https://app.slack.com/client → workspace name → Invite people. The bot adds them to the channel when they join.");
