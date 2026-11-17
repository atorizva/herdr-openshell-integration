# herdr-openshell

Mirror [OpenShell](https://github.com/NVIDIA/openshell) sandboxes into [Herdr](https://github.com/sst/herdr)'s agent panel and report each agent's state.

One OpenShell sandbox = one opencode agent, surfaced in whatever Herdr pane you connect to it from. Connect to a sandbox (`openshell sandbox connect <name>`) and the plugin detects that pane and keeps its agent status (`working` / `idle` / `blocked`) in sync with the sandbox lifecycle — plus a "needs input" signal from the agent's cognitive state. It never opens a pane of its own.

## What it does

| Signal | Source | Result |
|---|---|---|
| Sandbox lifecycle (provisioning → ready → done / error / stopped) | `openshell sandbox list` each poll | `herdr pane report-agent --state …` |
| Agent needs input (permission / question / error / idle) | in-sandbox marker file | `herdr pane report-agent --state blocked --message "needs input"` |

Lifecycle mirroring (M1) and the needs-input bridge (M2) are documented in `docs/contracts/`. The design rationale is in `docs/adr/0001-herdr-openshell-bridge.md`.

## How it works

Three artifacts, two sides of the bridge:

- **`herdr-plugin.toml`** — a Herdr plugin whose `[[startup]]` hook spawns a detached Node poller.
- **`poller.js`** — a host-side poller (~5s loop) that lists sandboxes, detects the pane each one is connected to, reports agent state, and reads the in-sandbox marker file.
- **`herdr-state-plugin.js`** — an in-sandbox opencode plugin that appends state-marker lines to `/sandbox/.herdr-state` as the agent works.

The poller uploads the in-sandbox plugin into each sandbox on first sight (best effort, retried), so there's no manual per-sandbox setup.

## Requirements

- **Herdr** ≥ 0.9.5
- **OpenShell** ≥ 0.1.8, connected to a live gateway
- **Node.js** (v24 tested) on the Herdr server's `PATH`

## Install

Link this repository as a local Herdr plugin (the manifest `herdr-plugin.toml` is at the repo root):

```bash
herdr plugin link /path/to/herdr-openshell-integration
herdr plugin list   # confirm it shows herdr-openshell
```

Herdr runs the `[[startup]]` hook on every server start; the poller self-heals via a unix-socket lock, so at most one poller runs.

## Use

A sandbox appears in the agent panel once you connect to it. To run an opencode **agent** as a sandbox's main process, create it from an image that contains opencode:

```bash
openshell sandbox create --name my-agent \
  --from ghcr.io/anomalyco/opencode@sha256:… \
  --provider opencode-go \
  --tty --detach \
  -- opencode
```

Notes:

- The sandbox **template** cannot set the main process — use `create --from <image> -- <command>` (see contract §4).
- The default `nvcr.io/nvidia/base/ubuntu:24.04` image has no opencode.
- `--tty` is required for the opencode TUI to attach correctly.
- The in-sandbox plugin is uploaded after create (OpenShell can't combine `--upload` with a trailing command). Bake `herdr-state-plugin.js` into the image at `/sandbox/.config/opencode/plugins/` if you need it loaded before the agent starts.

From here, connect to the sandbox in whichever pane you like (`openshell sandbox connect my-agent`) and the plugin reports its status there.

## State mapping

Lifecycle (M1):

| Sandbox phase / exit code | Reported state |
|---|---|
| `Provisioning`, `Starting`, `Ready` | `working` |
| `Completed`, exit 0 | `idle` (Herdr shows **done**) |
| `Error`, exit ≠ 0 | `blocked` — "exit code N" |
| `Error`, no exit code | `blocked` — condition reason |
| `Stopped`, `Stopping`, `Suspending`, `Suspended` | `idle` — "paused: sandbox <phase>" |
| `Deleting` / absent | agent row released (your pane is left alone) |
| `Unspecified`, `Unknown` | `unknown` |

Cognitive (M2): `permission.asked` / `form.created` / `session.execution.failed` → `blocked` ("needs input"); `session.execution.started` / `session.step.*` / `session.tool.called` / `session.retry.scheduled` / `permission.replied` / `form.replied` / `form.cancelled` → `working`; `session.execution.succeeded` / `session.execution.interrupted` → `idle`. Cognitive state only overrides the lifecycle while the sandbox is still running; terminal phases always win.

## Configuration

The poller reads these environment variables (provided by Herdr's plugin environment in production):

| Variable | Default | Purpose |
|---|---|---|
| `HERDR_BIN_PATH` | `herdr` | Path to the `herdr` CLI |
| `HERDR_SOCKET_PATH` | (inherited) | Herdr control socket |
| `HERDR_PLUGIN_STATE_DIR` | `/tmp/herdr-openshell` | Lock + persistence (`poller.lock`, `tracked.json`) |
| `HERDR_OPENSHELL_POLL_MS` | `5000` | Poll interval in milliseconds |

## Development

```bash
node --test          # runs test/poller.test.js + test/state-plugin.test.mjs
```

No dependencies — both scripts are plain CommonJS/ESM and call `herdr`/`openshell` over the CLI.

## Limitations

- One `sandbox exec` per running sandbox per tick (plus one `pane process-info` per pane) adds load — fine at small scale, revisit at dozens of sandboxes.
- The prompt → marker → report cycle is verified live on opencode 2.3.0 (a real turn emitted `working` → `idle` markers); the blocked / "needs input" path is unit-tested but not yet exercised in a live prompt.
- The poller only (re)spawns on server start — a poller that dies mid-session isn't revived until the next start.
- A sandbox you haven't connected to has no pane and therefore no agent row — it appears the moment you connect.
- Linux and macOS only (the singleton lock uses a unix socket).
