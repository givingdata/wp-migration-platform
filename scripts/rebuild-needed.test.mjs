import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildNeeded, datedCollections } from "./rebuild-needed.mjs";

const specs = JSON.parse(fs.readFileSync(new URL("../config/design-specs.json", import.meta.url), "utf8"));
const at = (iso) => new Date(`${iso}T06:00:00Z`); // the scheduled run's time
const WED = "2026-10-07"; // a Wednesday, not in January

test("dated collections come from the content types: events and announcements, not news", () => {
  assert.deepEqual(datedCollections(specs).sort(), ["announcements", "events"]);
  const custom = { contentTypes: { ...specs.contentTypes, exhibition: { collection: "exhibitions", fields: ["date", "endDate"] }, event: { ...specs.contentTypes.event, enabled: false } } };
  assert.deepEqual(datedCollections(custom).sort(), ["announcements", "exhibitions"]);
});

test("a quiet night skips; an event that ended yesterday or the day before builds", () => {
  const content = { events: [{ title: "Gala", date: "2026-10-20" }], posts: [{ title: "News", date: WED }] };
  assert.deepEqual(rebuildNeeded(content, specs, at(WED)), { build: false, reason: "nothing changes by date" }, "a news date doesn't matter");
  assert.equal(rebuildNeeded({ events: [{ title: "Gala", date: "2026-10-06" }] }, specs, at(WED)).build, true, "ended yesterday → now past");
  assert.equal(rebuildNeeded({ events: [{ title: "Gala", date: "2026-10-05" }] }, specs, at(WED)).build, true, "the day before: one missed run is caught up");
  assert.equal(rebuildNeeded({ events: [{ title: "Gala", date: "2026-10-04" }] }, specs, at(WED)).build, false, "older: already built");
  assert.equal(rebuildNeeded({ events: [{ title: "Fair", date: "2026-10-01", endDate: "2026-10-06" }] }, specs, at(WED)).build, true, "multi-day: by its end date");
  assert.equal(rebuildNeeded({ events: [{ title: "Fair", date: "2026-10-01", endDate: "2026-10-09" }] }, specs, at(WED)).build, false, "still on");
});

test("announcements build the day they start and the day after they end", () => {
  assert.equal(rebuildNeeded({ announcements: [{ title: "Closed", date: WED, endDate: "2026-10-12" }] }, specs, at(WED)).build, true);
  assert.equal(rebuildNeeded({ announcements: [{ title: "Closed", date: "2026-09-01", endDate: "2026-10-06" }] }, specs, at(WED)).build, true);
  assert.match(rebuildNeeded({ announcements: [{ title: "Closed", date: WED }] }, specs, at(WED)).reason, /“Closed” \(announcements\)/);
});

test("Mondays and the first days of January always build", () => {
  assert.deepEqual(rebuildNeeded({}, specs, at("2026-10-05")), { build: true, reason: "weekly rebuild" });
  assert.equal(rebuildNeeded({}, specs, at("2027-01-01")).build, true);
  assert.equal(rebuildNeeded({}, specs, at("2027-01-02")).build, true);
  assert.equal(rebuildNeeded({}, specs, at("2027-01-06")).build, false);
});

test("the command: pushes and manual runs build; a broken content.json builds; output goes to GITHUB_OUTPUT", () => {
  const script = fileURLToPath(new URL("./rebuild-needed.mjs", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.copyFileSync(new URL("../config/design-specs.json", import.meta.url), path.join(dir, "config/design-specs.json"));
  const run = (event) => execFileSync(process.execPath, [script], { cwd: dir, env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: path.join(dir, "out") } }).toString();
  assert.match(run("push"), /^build=true\nreason=push\n$/);
  fs.writeFileSync(path.join(dir, "content.json"), "{not json");
  assert.match(run("schedule"), /^build=true\nreason=check failed/);
  assert.match(fs.readFileSync(path.join(dir, "out"), "utf8"), /build=true\nreason=push\nbuild=true\nreason=check failed/);
  fs.rmSync(dir, { recursive: true });
});
