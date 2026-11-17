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

// The hook itself must not linger: re-spawn detached (own session, no stdio) and return.
if (process.argv.includes("--detach")) {
  spawn(process.execPath, [__filename], { detached: true, stdio: "ignore" }).unref();
  process.exit(0);
}

fs.mkdirSync(STATE_DIR, { recursive: true });

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

// ticket 03: `openshell sandbox list -o json` -> diff against tracked sandboxes ->
// pane split/run per new sandbox, close per vanished one, report_agent per state change.
async function pollOnce() {}

main();
