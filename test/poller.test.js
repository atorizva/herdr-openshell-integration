"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const POLLER = path.join(REPO, "poller.js");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "herdr-openshell-test-"));
const beatFile = (stateDir) => path.join(stateDir, "poller.json");
const beat = (stateDir) => {
  try {
    return JSON.parse(fs.readFileSync(beatFile(stateDir), "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pollerEnv = (stateDir) => ({
  ...process.env,
  HERDR_PLUGIN_STATE_DIR: stateDir,
  HERDR_OPENSHELL_POLL_MS: "50",
});
const startPoller = (stateDir, args = []) =>
  spawn(process.execPath, [POLLER, ...args], { env: pollerEnv(stateDir), stdio: "ignore" });
const waitFor = async (fn, ms = 10000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const stopPoller = async (pid) => {
  if (alive(pid)) process.kill(pid, "SIGTERM");
  await waitFor(() => !alive(pid));
};

test("poller runs a repeating loop", async () => {
  const dir = tmpDir();
  const child = startPoller(dir);
  try {
    const first = await waitFor(() => beat(dir));
    assert.equal(first.pid, child.pid);
    const later = await waitFor(() => {
      const b = beat(dir);
      return b && b.ticks > first.ticks ? b : null;
    });
    assert.ok(later.ticks >= 2, `expected repeat ticks, got ${later.ticks}`);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("--detach returns at once and leaves one detached poller behind", async () => {
  const dir = tmpDir();
  const startedAt = Date.now();
  const hook = spawnSync(process.execPath, [POLLER, "--detach"], { env: pollerEnv(dir) });
  assert.equal(hook.status, 0);
  assert.ok(Date.now() - startedAt < 5000, "startup hook must not block on the poller");

  const b = await waitFor(() => beat(dir));
  assert.notEqual(b.pid, process.pid);
  assert.ok(alive(b.pid), "detached poller must outlive the hook");
  await stopPoller(b.pid);
});

test("a second poller on the same state dir stands down", async () => {
  const dir = tmpDir();
  const first = startPoller(dir);
  const [firstBeat] = await Promise.all([waitFor(() => beat(dir)), once(first, "spawn")]);
  const second = startPoller(dir);
  try {
    const [code] = await once(second, "exit");
    assert.equal(code, 0, "duplicate poller must exit cleanly");
    assert.ok(alive(firstBeat.pid), "surviving poller keeps running");
    assert.equal(beat(dir).pid, firstBeat.pid);
  } finally {
    await stopPoller(firstBeat.pid);
  }
});

test("manifest parses as a Herdr plugin", (t) => {
  const herdr = spawnSync("herdr", ["--version"], { stdio: "ignore" });
  if (herdr.error || herdr.status !== 0) {
    t.skip("herdr not installed");
    return;
  }
  // Isolated config/state so the check never touches the user's plugin registry.
  const sandbox = tmpDir();
  const pluginDir = path.join(sandbox, "plugin");
  fs.mkdirSync(pluginDir);
  fs.copyFileSync(
    path.join(REPO, "herdr-plugin.toml"),
    path.join(pluginDir, "herdr-plugin.toml"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  execFileSync("herdr", ["plugin", "link", pluginDir], {
    env: {
      ...env,
      XDG_CONFIG_HOME: path.join(sandbox, "config"),
      XDG_STATE_HOME: path.join(sandbox, "state"),
    },
    stdio: "pipe",
  });
  const registry = JSON.parse(
    fs.readFileSync(path.join(sandbox, "config", "herdr", "plugins.json"), "utf8"),
  );
  const entry = registry.find((p) => p.plugin_id === "herdr-openshell");
  assert.ok(entry, "plugin registered");
  assert.deepEqual(entry.startup, [{ command: ["node", "poller.js", "--detach"] }]);
});
