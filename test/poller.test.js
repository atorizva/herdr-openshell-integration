"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mapPhase, pollOnce } = require("../poller.js");

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
// Stub openshell/herdr on PATH so a spawned loop never touches the real gateway or Herdr.
const pollerEnv = (stateDir) => {
  const bin = path.join(stateDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "openshell"), '#!/bin/sh\necho \'{"sandboxes":[]}\'\n');
  fs.writeFileSync(path.join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
  for (const file of ["openshell", "herdr"]) fs.chmodSync(path.join(bin, file), 0o755);
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HERDR_BIN_PATH: path.join(bin, "herdr"),
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_OPENSHELL_POLL_MS: "50",
  };
};
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

test("maps every sandbox phase onto a Herdr agent state", () => {
  const ready = { phase: "Ready", exit_code: null };
  for (const phase of ["Provisioning", "Starting", "Ready"]) {
    assert.deepEqual(mapPhase({ ...ready, phase }), { state: "working" }, phase);
  }
  assert.deepEqual(mapPhase({ phase: "Completed", exit_code: 0 }), { state: "idle" });
  assert.deepEqual(mapPhase({ phase: "Error", exit_code: 7, conditions: [] }), {
    state: "blocked",
    message: "exit code 7",
  });
  assert.deepEqual(
    mapPhase({
      phase: "Error",
      exit_code: null,
      conditions: [{ reason: "ProvisioningTimedOut" }],
    }),
    { state: "blocked", message: "ProvisioningTimedOut" },
  );
  // Phase wins over exit code: a stopped sandbox keeps its 143 without going blocked.
  for (const phase of ["Stopping", "Stopped", "Suspending", "Suspended"]) {
    assert.deepEqual(mapPhase({ phase, exit_code: 143 }), {
      state: "idle",
      message: `paused: sandbox ${phase}`,
    });
  }
  assert.equal(mapPhase({ phase: "Deleting", exit_code: null }), null);
  for (const phase of ["Unspecified", "Unknown"]) {
    assert.deepEqual(mapPhase({ phase, exit_code: null }), { state: "unknown" });
  }
});

// Fake subprocesses: a scripted `openshell`/`herdr`, recording every argv line.
const fakeExec = ({ sandboxes, panes = [{ pane_id: "w1:p1", focused: true }] }) => {
  const calls = [];
  let splits = 0;
  const ok = (payload) => ({
    code: 0,
    stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
    stderr: "",
  });
  const exec = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (line === "openshell sandbox list -o json") return ok({ sandboxes: sandboxes() });
    if (line === "herdr pane list") return ok({ result: { panes } });
    if (args[0] === "pane" && args[1] === "split") {
      splits += 1;
      return ok({ result: { pane: { pane_id: `w1:p${splits + 2}` } } });
    }
    return ok();
  };
  exec.calls = calls;
  return exec;
};
const count = (calls, needle) => calls.filter((call) => call.includes(needle)).length;

test("a new sandbox becomes one pane running connect, reported as working", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  const exec = fakeExec({
    sandboxes: () => [{ id: "sb1", name: "agent-one", phase: "Ready", exit_code: null }],
  });
  await pollOnce({ exec, trackedPath });

  assert.equal(count(exec.calls, "pane split"), 1, "one split per sandbox");
  assert.ok(exec.calls.includes("herdr pane run w1:p3 openshell sandbox connect agent-one"));
  const reports = exec.calls.filter((call) => call.includes("report-agent"));
  assert.deepEqual(reports, [
    `herdr pane report-agent w1:p3 --source openshell --agent opencode --state working --seq 1`,
  ]);
  const tracked = JSON.parse(fs.readFileSync(trackedPath, "utf8"));
  assert.equal(tracked.sb1.paneId, "w1:p3");
});

test("re-polling never duplicates a pane, even after a restart", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  const sandboxes = () => [{ id: "sb1", name: "agent-one", phase: "Ready", exit_code: null }];
  await pollOnce({ exec: fakeExec({ sandboxes }), trackedPath });
  // A fresh exec stands in for a poller restart: state comes off disk, not memory.
  const exec = fakeExec({ sandboxes });
  await pollOnce({ exec, trackedPath });
  await pollOnce({ exec, trackedPath });
  assert.equal(count(exec.calls, "pane split"), 0, "tracked pane must not be split again");
  assert.equal(count(exec.calls, "report-agent"), 0, "unchanged state is not re-reported");
});

test("a vanished sandbox releases its pane once and is forgotten", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  let listed = [{ id: "sb1", name: "agent-one", phase: "Ready", exit_code: null }];
  const exec = fakeExec({ sandboxes: () => listed });
  await pollOnce({ exec, trackedPath });

  exec.calls.length = 0;
  listed = [];
  await pollOnce({ exec, trackedPath });
  assert.deepEqual(exec.calls.slice(1), [
    "herdr pane release-agent w1:p3 --source openshell --agent opencode",
    "herdr pane close w1:p3",
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedPath, "utf8")), {});

  exec.calls.length = 0;
  await pollOnce({ exec, trackedPath });
  assert.equal(count(exec.calls, "pane close"), 0, "a closed pane must not be closed twice");
});

test("a Deleting sandbox closes its pane", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  let listed = [{ id: "sb1", name: "agent-one", phase: "Ready", exit_code: null }];
  const exec = fakeExec({ sandboxes: () => listed });
  await pollOnce({ exec, trackedPath });

  exec.calls.length = 0;
  listed = [{ id: "sb1", name: "agent-one", phase: "Deleting", exit_code: null }];
  await pollOnce({ exec, trackedPath });
  assert.equal(count(exec.calls, "pane close w1:p3"), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedPath, "utf8")), {});
});

test("stop's transient Error flashes are debounced into paused", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  let sandbox = { id: "sb1", name: "agent-one", phase: "Ready", exit_code: null };
  const exec = fakeExec({ sandboxes: () => [sandbox] });
  await pollOnce({ exec, trackedPath });

  exec.calls.length = 0;
  sandbox = { ...sandbox, phase: "Error", exit_code: 143 };
  await pollOnce({ exec, trackedPath });
  assert.equal(count(exec.calls, "report-agent"), 0, "one Error tick is not yet blocked");

  await pollOnce({ exec, trackedPath });
  assert.deepEqual(exec.calls.filter((call) => call.includes("report-agent")), [
    `herdr pane report-agent w1:p3 --source openshell --agent opencode --state blocked --seq 2 --message exit code 143`,
  ]);

  exec.calls.length = 0;
  sandbox = { ...sandbox, phase: "Stopped" };
  await pollOnce({ exec, trackedPath });
  assert.deepEqual(exec.calls.filter((call) => call.includes("report-agent")), [
    `herdr pane report-agent w1:p3 --source openshell --agent opencode --state idle --seq 3 --message paused: sandbox Stopped`,
  ]);
});

test("a sandbox first seen finished gets no pane and no retry", async () => {
  const trackedPath = path.join(tmpDir(), "tracked.json");
  const exec = fakeExec({
    sandboxes: () => [{ id: "sb1", name: "agent-one", phase: "Completed", exit_code: 0 }],
  });
  await pollOnce({ exec, trackedPath });
  assert.equal(count(exec.calls, "pane split") + count(exec.calls, "report-agent"), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(trackedPath, "utf8")), {});
});

test("a failed sandbox list surfaces as a failed tick", async () => {
  const exec = async () => ({ code: 1, stdout: "", stderr: "connection refused" });
  await assert.rejects(pollOnce({ exec, trackedPath: path.join(tmpDir(), "t.json") }), {
    message: /connection refused/,
  });
});
