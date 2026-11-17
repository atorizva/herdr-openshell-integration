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
  for (const type of ["permission.asked", "form.created", "session.execution.failed"]) {
    assert.equal(stateForEvent(type), "blocked", type);
  }
});

test("M2 event map: working", () => {
  for (const type of [
    "session.execution.started",
    "session.step.started",
    "session.step.ended",
    "session.tool.called",
    "session.retry.scheduled",
    "permission.replied",
    "form.replied",
    "form.cancelled",
  ]) {
    assert.equal(stateForEvent(type), "working", type);
  }
});

test("M2 event map: idle", () => {
  for (const type of ["session.execution.succeeded", "session.execution.interrupted"]) {
    assert.equal(stateForEvent(type), "idle", type);
  }
});

test("unmapped events emit nothing", () => {
  for (const type of [
    "session.created",
    "session.text.delta",
    "session.tool.success",
    "filesystem.changed",
  ]) {
    assert.equal(stateForEvent(type), undefined, type);
  }
});

test("marker line is one greppable line", () => {
  const line = markerFor("blocked", 42);
  assert.equal(line, "HERDR-STATE state=blocked seq=42");
  assert.match(line, MARKER);
});

test("one line per state change, monotonic seq, no escapes", () => {
  const lines = statesFor([
    { type: "session.execution.started", data: { sessionID: "root" } },
    { type: "session.tool.called", data: { sessionID: "root" } },
    { type: "permission.asked", data: { sessionID: "root" } },
    { type: "permission.replied", data: { sessionID: "root" } },
    { type: "session.execution.succeeded", data: { sessionID: "root" } },
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
    { type: "session.created", data: { sessionID: "child", parentID: "root" } },
    { type: "session.execution.started", data: { sessionID: "child" } },
    { type: "session.execution.succeeded", data: { sessionID: "child" } },
    { type: "permission.asked", data: { sessionID: "child" } },
  ]);
  assert.deepEqual(lines.map((line) => MARKER.exec(line.trimEnd())[1]), ["blocked"]);
});

test("plugin module never touches the Herdr socket", () => {
  const source = fs.readFileSync(PLUGIN, "utf8");
  for (const forbidden of ["node:net", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_ENV"]) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

test("plugin default export exposes the v2 setup hook", () => {
  assert.equal(plugin.id, "herdr.openshell-state");
  assert.equal(typeof plugin.setup, "function");
});

test("plugin writes markers to $HOME/.herdr-state via setup", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-state-test-"));
  const script = `
    const { default: plugin } = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
    const events = [
      { type: "permission.asked", data: { sessionID: "root" } },
      { type: "session.execution.started", data: { sessionID: "root" } },
      { type: "session.execution.succeeded", data: { sessionID: "root" } },
    ];
    const ctx = {
      event: {
        subscribe() {
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    };
    const cleanup = plugin.setup(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (typeof cleanup !== "function") throw new Error("setup must return a cleanup fn");
    cleanup();
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
