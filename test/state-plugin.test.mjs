import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

const REPO = path.join(import.meta.dirname, "..");
const PLUGIN = path.join(REPO, "herdr-state-plugin.js");
const { stateForEvent, markerFor, createStateEmitter, default: plugin } = await import(
  pathToFileURL(PLUGIN).href
);

const MARKER = /^HERDR-STATE state=(idle|working|blocked) seq=([0-9]+)$/;

const statesFor = (events) => {
  const lines = [];
  const emit = createStateEmitter((line) => lines.push(line));
  for (const event of events) emit(event);
  return lines;
};

test("M2 event map: blocked", () => {
  for (const type of ["permission.asked", "question.asked", "session.error"]) {
    assert.equal(stateForEvent(type, {}), "blocked", type);
  }
});

test("M2 event map: working", () => {
  for (const type of ["tool.execute.before", "tool.execute.after"]) {
    assert.equal(stateForEvent(type, {}), "working", type);
  }
  for (const status of ["active", "busy", "running"]) {
    assert.equal(stateForEvent("session.status", { status }), "working", status);
    assert.equal(stateForEvent("session.status", { status: { type: status } }), "working", status);
  }
});

test("M2 event map: idle", () => {
  assert.equal(stateForEvent("session.idle", {}), "idle");
  assert.equal(stateForEvent("session.status", { status: "idle" }), "idle");
});

test("unmapped events emit nothing", () => {
  for (const type of ["session.created", "session.updated", "session.deleted", "file.edited"]) {
    assert.equal(stateForEvent(type, {}), undefined, type);
  }
  assert.equal(stateForEvent("session.status", { status: "mystery" }), undefined);
  assert.equal(stateForEvent("session.status", {}), undefined);
});

test("marker line is one greppable line", () => {
  const line = markerFor("blocked", 42);
  assert.equal(line, "HERDR-STATE state=blocked seq=42");
  assert.match(line, MARKER);
});

test("one line per state change, monotonic seq, no escapes", () => {
  const lines = statesFor([
    { type: "session.status", properties: { status: "busy" } },
    { type: "tool.execute.before", properties: {} },
    { type: "permission.asked", properties: {} },
    { type: "question.asked", properties: {} },
    { type: "permission.replied", properties: {} },
    { type: "session.idle", properties: {} },
  ]);
  assert.deepEqual(
    lines.map((line) => MARKER.exec(line.trimEnd())[1]),
    ["working", "blocked", "working", "idle"]
  );
  const seqs = lines.map((line) => Number(MARKER.exec(line.trimEnd())[2]));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  for (const line of lines) {
    assert.match(line, /^HERDR-STATE [\x20-\x7e]*\n$/);
  }
});

test("subagent sessions cannot clobber the root state", () => {
  const lines = statesFor([
    { type: "session.created", properties: { info: { id: "child", parentID: "root" } } },
    { type: "session.status", properties: { sessionID: "child", status: "busy" } },
    { type: "session.idle", properties: { sessionID: "child" } },
    { type: "permission.asked", properties: { sessionID: "child" } },
  ]);
  assert.deepEqual(lines.map((line) => MARKER.exec(line.trimEnd())[1]), ["blocked"]);
});

test("plugin module never touches the Herdr socket", () => {
  const source = fs.readFileSync(PLUGIN, "utf8");
  for (const forbidden of ["node:net", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_ENV"]) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

test("plugin default export exposes the event hook", async () => {
  assert.equal(plugin.id, "herdr.openshell-state");
  const hooks = await plugin.server();
  assert.equal(typeof hooks.event, "function");
});

test("plugin writes markers to $HOME/.herdr-state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-state-test-"));
  const script = `
    const { default: plugin } = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
    const hooks = await plugin.server();
    for (const event of [
      { type: "permission.asked", properties: {} },
      { type: "session.status", properties: { status: "busy" } },
      { type: "session.idle", properties: {} },
    ]) await hooks.event({ event });
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const markers = fs
    .readFileSync(path.join(home, ".herdr-state"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => MARKER.exec(line));
  assert.deepEqual(markers.map((m) => m[1]), ["blocked", "working", "idle"]);
  const seqs = markers.map((m) => Number(m[2]));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});
