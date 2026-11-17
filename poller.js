#!/usr/bin/env node
// Herdr [[startup]] target. Herdr neither supervises nor reaps plugin children, so
// this process owns its own lifecycle: one instance per state dir, re-spawned by the
// startup hook on every server start, and left running across server restarts.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const POLL_INTERVAL_MS = Number(process.env.HERDR_OPENSHELL_POLL_MS) || 5000;
const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.tmpdir(), "herdr-openshell");
const LOCK_PATH = path.join(STATE_DIR, "poller.lock");
const BEAT_PATH = path.join(STATE_DIR, "poller.json");
// sandbox id -> {paneId, ...}: persisted so a restarted poller never re-splits a pane.
const TRACKED_PATH = path.join(STATE_DIR, "tracked.json");
// Herdr's CLI honours HERDR_SOCKET_PATH from the inherited plugin environment; only the
// binary is ours to choose.
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
// `sandbox stop` flashes Error/exit 143 before Stopping, so an Error must survive a tick.
const ERROR_CONFIRM_TICKS = 2;

// The hook itself must not linger: re-spawn detached (own session, no stdio) and return.
if (process.argv.includes("--detach")) {
  spawn(process.execPath, [__filename], { detached: true, stdio: "ignore" }).unref();
  process.exit(0);
}

// A unix socket as the singleton lock: the kernel releases it when we die, so a
// second startup after a crash (or after a server restart that left us alive) is a
// connect away from knowing whether we are already running.
function lockHeld() {
  return new Promise((resolve) => {
    const probe = net.connect(LOCK_PATH);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function release() {
  fs.rmSync(LOCK_PATH, { force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The contract's M1 table: phase is the only lifecycle signal; exit_code only refines
// Completed/Error. `done` is never reported - Herdr derives it from `idle`. (Bridge
// contract docs/contracts/lock-bridge-contract.md §2.)
function mapPhase({ phase, exit_code: exitCode, conditions = [] }) {
  switch (phase) {
    case "Provisioning":
    case "Starting":
    case "Ready":
      return { state: "working" };
    case "Completed":
      return exitCode
        ? { state: "blocked", message: `exit code ${exitCode}` }
        : { state: "idle" };
    case "Error":
      return exitCode == null
        ? {
            state: "blocked",
            message: conditions.find((condition) => condition.reason)?.reason ?? "error",
          }
        : { state: "blocked", message: `exit code ${exitCode}` };
    case "Stopping":
    case "Stopped":
    case "Suspending":
    case "Suspended":
      return { state: "idle", message: `paused: sandbox ${phase}` };
    case "Deleting":
      return null; // the pane dies with the sandbox
    default:
      return { state: "unknown" };
  }
}

const readTracked = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
const writeTracked = (file, tracked) =>
  fs.writeFileSync(file, JSON.stringify(tracked, null, 2));

// Split off the focused pane (or any pane, on a headless/unfocused server) and attach
// the sandbox's canonical main process in it.
async function openPane(exec, name) {
  const listed = await exec(HERDR, ["pane", "list"]);
  if (listed.code !== 0) return null;
  const panes = JSON.parse(listed.stdout).result?.panes ?? [];
  const target = (panes.find((pane) => pane.focused) ?? panes[0])?.pane_id;
  if (!target) return null;
  const split = await exec(HERDR, ["pane", "split", target, "--direction", "down", "--no-focus"]);
  const paneId = split.code === 0 ? JSON.parse(split.stdout).result?.pane?.pane_id : null;
  if (!paneId) return null;
  const attached = await exec(HERDR, ["pane", "run", paneId, `openshell sandbox connect ${name}`]);
  if (attached.code === 0) return paneId;
  await exec(HERDR, ["pane", "close", paneId]);
  return null;
}

// Best effort: the pane may already be gone, which is the outcome we want anyway.
async function closePane(exec, paneId) {
  await exec(HERDR, [
    "pane",
    "release-agent",
    paneId,
    "--source",
    "openshell",
    "--agent",
    "opencode",
  ]);
  await exec(HERDR, ["pane", "close", paneId]);
}

// ticket 03: `openshell sandbox list -o json` -> diff against tracked sandboxes ->
// pane split/run per new sandbox, close per vanished one, report_agent per state change.
async function pollOnce({ exec = run, trackedPath = TRACKED_PATH } = {}) {
  const listed = await exec("openshell", ["sandbox", "list", "-o", "json"]);
  if (listed.code !== 0) {
    throw new Error(`openshell sandbox list failed: ${listed.stderr.trim() || listed.code}`);
  }
  const sandboxes = JSON.parse(listed.stdout).sandboxes ?? [];
  const tracked = readTracked(trackedPath);
  const live = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));

  for (const [id, entry] of Object.entries(tracked)) {
    const sandbox = live.get(id);
    if (sandbox && sandbox.phase !== "Deleting") continue;
    // Deleting, or gone from `list` entirely: the sandbox is being removed.
    await closePane(exec, entry.paneId);
    delete tracked[id];
  }

  for (const sandbox of sandboxes) {
    let entry = tracked[sandbox.id];
    if (!entry) {
      // `connect` fails immediately on a finished main process - never open a pane for one.
      if (["Completed", "Error", "Deleting"].includes(sandbox.phase)) continue;
      const paneId = await openPane(exec, sandbox.name);
      if (!paneId) continue;
      entry = tracked[sandbox.id] = {
        name: sandbox.name,
        paneId,
        seq: 0,
        state: null,
        message: null,
        errorTicks: 0,
      };
    }
    entry.errorTicks = sandbox.phase === "Error" ? entry.errorTicks + 1 : 0;
    const target = mapPhase(sandbox);
    if (!target) continue;
    if (sandbox.phase === "Error" && entry.errorTicks < ERROR_CONFIRM_TICKS) continue;
    const message = target.message ?? null;
    if (entry.state === target.state && entry.message === message) continue;
    const args = [
      "pane",
      "report-agent",
      entry.paneId,
      "--source",
      "openshell",
      "--agent",
      "opencode",
      "--state",
      target.state,
      "--seq",
      String((entry.seq += 1)),
    ];
    if (message) args.push("--message", message);
    const reported = await exec(HERDR, args);
    if (reported.code === 0) {
      entry.state = target.state;
      entry.message = message;
    } else {
      // Pane closed under us: forget it, a still-live sandbox gets a fresh pane next tick.
      delete tracked[sandbox.id];
    }
  }

  writeTracked(trackedPath, tracked);
}

async function main() {
  if (await lockHeld()) return; // an earlier poller is still alive
  release(); // stale socket from a dead poller
  const lock = net.createServer();
  lock.once("error", () => process.exit(0)); // lost a race for the lock
  lock.listen(LOCK_PATH);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }

  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    try {
      await pollOnce();
    } catch (err) {
      // One bad tick must never end the loop.
      process.stderr.write(`herdr-openshell poll failed: ${err?.message ?? err}\n`);
    } finally {
      fs.writeFileSync(
        BEAT_PATH,
        JSON.stringify({
          pid: process.pid,
          ticks,
          lastTickAt: new Date().toISOString(),
          herdrSocketPath: process.env.HERDR_SOCKET_PATH ?? null,
        }),
      );
    }
    setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
}

module.exports = { mapPhase, pollOnce };

if (require.main === module) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  main();
}
