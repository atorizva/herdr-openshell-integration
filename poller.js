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
// sandbox id -> {paneId, ...}: the pane we detected (never one we created), persisted so a
// restarted poller keeps reporting to the same pane.
const TRACKED_PATH = path.join(STATE_DIR, "tracked.json");
// Herdr's CLI honours HERDR_SOCKET_PATH from the inherited plugin environment; only the
// binary is ours to choose.
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const OPEN_SHELL = "openshell";
// The agent identity every report carries (contract §2, spec decision 8).
const IDENTITY = ["--source", "openshell", "--agent", "opencode"];
// The in-sandbox emitter ships next to this file; the poller uploads it into each sandbox
// (contract §4 - `--upload` cannot be combined with a main-process command, so it is a
// separate `sandbox upload`).
const PLUGIN_FILE = path.join(__dirname, "herdr-state-plugin.js");
const SANDBOX_PLUGIN_DIR = "/sandbox/.config/opencode/plugins/";
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

// ticket 05: the in-sandbox plugin cannot reach Herdr's socket, so it appends cognitive
// state markers to a file inside the sandbox and the host reads that file each tick.
// (docs/contracts/state-markers.md)
const MARKER_PATH = "/sandbox/.herdr-state";
const MARKER_RE = /HERDR-STATE state=(idle|working|blocked) seq=([0-9]+)/g;
// The agent is only alive in these phases; everywhere else its markers are stale.
const RUNNING_PHASES = new Set(["Provisioning", "Starting", "Ready"]);

// One `cat` of the marker file; null when the file or the sandbox is unreachable. A missing
// file, a failed `exec` and a detached sandbox are all "no news", never an error.
async function readMarkerFile(exec, name) {
  try {
    const read = await exec(OPEN_SHELL, ["sandbox", "exec", name, "--", "cat", MARKER_PATH]);
    return read?.code === 0 ? String(read.stdout ?? "") : null;
  } catch {
    return null;
  }
}

const markersIn = (text) => [...String(text ?? "").matchAll(MARKER_RE)];

// Latest marker newer than `afterSeq`, or null for "no news". Re-attach replays the file, so
// order by seq, not by position in the read.
function latestMarker(text, afterSeq) {
  let latest = null;
  for (const [, state, seq] of markersIn(text)) {
    if (Number(seq) > afterSeq && (!latest || Number(seq) > latest.seq)) {
      latest = { state, seq: Number(seq) };
    }
  }
  return latest;
}

// The file is append-only and survives stop -> start, so a freshly seen sandbox already
// holds the previous run's markers: adopt the highest seq as the baseline, report none.
const baselineSeq = (text) =>
  markersIn(text).reduce((max, [, , seq]) => Math.max(max, Number(seq)), 0);

// Deliverable 2: the in-sandbox emitter has to be *inside* the sandbox to emit anything.
// Best effort - a sandbox that is still provisioning refuses the upload, so the caller
// retries on a later tick.
async function uploadPlugin(exec, name) {
  try {
    const upload = await exec(OPEN_SHELL, [
      "sandbox",
      "upload",
      name,
      PLUGIN_FILE,
      SANDBOX_PLUGIN_DIR,
    ]);
    return upload?.code === 0;
  } catch {
    return false;
  }
}

// A failed report means either "the pane is gone" or "Herdr hiccupped"; only the former may
// drop tracking. Dropping on a hiccup splits a duplicate pane for the same sandbox next tick.
async function paneGone(exec, paneId) {
  try {
    const got = await exec(HERDR, ["pane", "get", paneId]);
    return got?.code !== 0 && String(got.stdout ?? "").includes("pane_not_found");
  } catch {
    return false;
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

// The connect/exec session's foreground argv is the only thing that links a pane to a
// sandbox. `openshell sandbox connect <name>` becomes an `ssh` to the sandbox's canonical
// main process whose ProxyCommand is `openshell ssh-proxy … --sandbox <name> …`; the older
// `sandbox exec -n <name> --tty …` shows the exec argv directly. Recover the name from either.
// (Never log/store the argv - the ssh ProxyCommand carries a --token credential.)
function sandboxNameOf(proc) {
  const argv = proc.argv ?? [];
  if (argv[0] === OPEN_SHELL && argv[1] === "sandbox") {
    if (argv[2] === "connect") return argv[3] ?? null;
    if (argv[2] === "exec") {
      const nameIndex = argv.indexOf("-n");
      if (nameIndex >= 0) return argv[nameIndex + 1] ?? null;
      const nameFlag = argv.indexOf("--name");
      if (nameFlag >= 0) return argv[nameFlag + 1] ?? null;
      return argv[3] && !argv[3].startsWith("-") ? argv[3] : null;
    }
  }
  const sandboxFlag = argv.indexOf("--sandbox");
  if (sandboxFlag >= 0) return argv[sandboxFlag + 1] ?? null;
  const proxy = argv.find((arg) => typeof arg === "string" && arg.includes("ssh-proxy"));
  if (proxy) {
    const match = proxy.match(/--sandbox\s+(\S+)/);
    if (match) return match[1];
  }
  return null;
}

// Map sandbox name -> pane id from the panes whose foreground process is a live connect or
// exec session. One scan per tick serves every sandbox; a pane not yet connected simply
// contributes nothing, so the sandbox gets no row until the user connects.
async function detectPanes(exec) {
  const listed = await exec(HERDR, ["pane", "list"]);
  if (listed.code !== 0) return new Map();
  const panes = JSON.parse(listed.stdout).result?.panes ?? [];
  const byName = new Map();
  for (const pane of panes) {
    const info = await exec(HERDR, ["pane", "process-info", "--pane", pane.pane_id]);
    if (info.code !== 0) continue;
    const procs = JSON.parse(info.stdout).result?.process_info?.foreground_processes ?? [];
    for (const proc of procs) {
      const name = sandboxNameOf(proc);
      if (name && !byName.has(name)) byName.set(name, pane.pane_id);
    }
  }
  return byName;
}

// The pane is the user's own (we never split one), so releasing the agent row is all we ever
// do - closing it would destroy the user's terminal.
async function releasePane(exec, paneId) {
  await exec(HERDR, ["pane", "release-agent", paneId, ...IDENTITY]);
}

// ticket 03: `openshell sandbox list -o json` -> diff against tracked sandboxes ->
// detect the pane the user connected to per sandbox, release per vanished one, report_agent
// per state change.
async function pollOnce({ exec = run, trackedPath = TRACKED_PATH } = {}) {
  const listed = await exec(OPEN_SHELL, ["sandbox", "list", "-o", "json"]);
  if (listed.code !== 0) {
    throw new Error(`openshell sandbox list failed: ${listed.stderr.trim() || listed.code}`);
  }
  const sandboxes = JSON.parse(listed.stdout).sandboxes ?? [];
  const tracked = readTracked(trackedPath);
  const live = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
  const connectPanes = await detectPanes(exec);

  for (const [id, entry] of Object.entries(tracked)) {
    const sandbox = live.get(id);
    if (sandbox && sandbox.phase !== "Deleting") continue;
    // Deleting, or gone from `list` entirely: the sandbox is being removed.
    await releasePane(exec, entry.paneId);
    delete tracked[id];
  }

  for (const sandbox of sandboxes) {
    let entry = tracked[sandbox.id];
    // A sandbox this poller has never tracked: its marker file may still hold the previous
    // run's state, so this tick adopts it as a baseline and reports no marker.
    const firstSight = !entry;
    if (!entry) {
      // `connect` fails immediately on a finished main process, so a finished sandbox can
      // never be connected to. Only a running sandbox the user has connected to gets a row.
      if (["Completed", "Error", "Deleting"].includes(sandbox.phase)) continue;
      const paneId = connectPanes.get(sandbox.name);
      if (!paneId) continue; // running but not yet connected: no pane to report to
      entry = tracked[sandbox.id] = {
        name: sandbox.name,
        paneId,
        seq: 0,
        state: null,
        message: null,
        errorTicks: 0,
        // seq of the last marker consumed, and the cognitive state it carried.
        markerSeq: 0,
        cognitive: null,
        // plugin upload acknowledged by the sandbox.
        installed: false,
      };
    } else if (connectPanes.get(sandbox.name) && connectPanes.get(sandbox.name) !== entry.paneId) {
      // The user reconnected in a different pane: move the row there.
      await releasePane(exec, entry.paneId);
      entry.paneId = connectPanes.get(sandbox.name);
      entry.state = null; // force a fresh report on the new pane
      entry.message = null;
    }
    if (!entry.installed && RUNNING_PHASES.has(sandbox.phase)) {
      entry.installed = await uploadPlugin(exec, sandbox.name);
    }
    entry.errorTicks = sandbox.phase === "Error" ? entry.errorTicks + 1 : 0;
    let target = mapPhase(sandbox);
    if (!target) continue;
    if (sandbox.phase === "Error" && entry.errorTicks < ERROR_CONFIRM_TICKS) continue;
    if (RUNNING_PHASES.has(sandbox.phase)) {
      const file = await readMarkerFile(exec, sandbox.name);
      if (firstSight) {
        entry.markerSeq = baselineSeq(file);
      } else {
        const marker = latestMarker(file, entry.markerSeq ?? 0);
        if (marker) {
          entry.markerSeq = marker.seq;
          entry.cognitive = marker.state;
        }
      }
      // The marker carries no text: a question/permission prompt is just "needs input".
      if (entry.cognitive) {
        target =
          entry.cognitive === "blocked"
            ? { state: "blocked", message: "needs input" }
            : { state: entry.cognitive };
      }
    } else {
      // Finished/paused agent: its markers are stale, M1 lifecycle state stands.
      entry.cognitive = null;
    }
    const message = target.message ?? null;
    if (entry.state === target.state && entry.message === message) continue;
    entry.seq += 1;
    const args = [
      "pane",
      "report-agent",
      entry.paneId,
      ...IDENTITY,
      "--state",
      target.state,
      "--seq",
      String(entry.seq),
    ];
    if (message) args.push("--message", message);
    const reported = await exec(HERDR, args);
    if (reported.code === 0) {
      entry.state = target.state;
      entry.message = message;
    } else if (await paneGone(exec, entry.paneId)) {
      // Pane closed under us: forget it, a still-live sandbox is re-detected next tick.
      delete tracked[sandbox.id];
    }
    // Otherwise Herdr hiccupped: keep the entry so the next tick retries this report rather
    // than re-detecting (and possibly reporting twice) for the same sandbox.
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

module.exports = { mapPhase, pollOnce, sandboxNameOf };

if (require.main === module) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  main();
}
