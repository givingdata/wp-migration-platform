#!/usr/bin/env node
// Prints the "create Slack app from manifest" link for this client's Worker.
//
//   node scripts/slack-app-link.mjs [--worker-url https://…] [--open]
//
// Without --worker-url it reads the repo's WORKER_URL variable with `gh`.
// --open opens the link in the browser and copies it to the clipboard (macOS).
// See docs/SLACK.md.
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function value(name) {
  const i = args.indexOf(name);
  if (i !== -1) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

if (flag("--help") || flag("-h")) {
  console.log("Usage: node scripts/slack-app-link.mjs [--worker-url https://…] [--open]");
  process.exit(0);
}

let workerUrl = value("--worker-url");
if (!workerUrl) {
  try {
    workerUrl = execFileSync("gh", ["variable", "get", "WORKER_URL"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // gh missing, not logged in, or the variable isn't set.
  }
}
if (!workerUrl) {
  console.error("No Worker URL. Pass --worker-url https://<worker>.workers.dev (or set the repo's WORKER_URL variable).");
  process.exit(1);
}
workerUrl = workerUrl.replace(/\/+$/, "");
if (!/^https:\/\/[^/\s]+$/.test(workerUrl)) {
  console.error(`Worker URL must look like https://<name>.workers.dev (got ${workerUrl}).`);
  process.exit(1);
}

const manifestPath = fileURLToPath(new URL("../slack/manifest.json", import.meta.url));
const manifest = readFileSync(manifestPath, "utf8").replaceAll("https://WORKER_URL", workerUrl);
const compact = JSON.stringify(JSON.parse(manifest));
const link = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(compact)}`;

console.log(`Slack app for ${workerUrl}`);
console.log("Open this link, pick the workspace, then Create → Install to Workspace (docs/SLACK.md):\n");
console.log(link);

if (flag("--open")) {
  const copied = spawnSync("pbcopy", { input: link }).status === 0;
  const opened = spawnSync("open", [link]).status === 0;
  console.log(`\n${opened ? "Opened in your browser." : "Couldn't open the browser; use the link above."}${copied ? " Link copied to the clipboard." : ""}`);
}
