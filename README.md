# herdr-openshell

Mirror [OpenShell](https://github.com/NVIDIA/openshell) sandboxes into [Herdr](https://github.com/sst/herdr) panes and report each agent's state.

One OpenShell sandbox = one opencode agent = one Herdr pane. When a sandbox is created, Herdr opens a pane named after it, attached to the sandbox's main process, and keeps the pane's agent status (`working` / `idle` / `blocked`) in sync with the sandbox lifecycle — plus a "needs input" signal from the agent's cognitive state.

## What it does

| Signal | Source | Result |
|---|---|---|
| Sandbox lifecycle (provisioning → ready → done / error / stopped) | `openshell sandbox list` each poll | `herdr pane report-agent --state …` |
| Agent needs input (permission / question / error / idle) | in-sandbox marker file | `herdr pane report-agent --state blocked --message "needs input"` |

Lifecycle mirroring (M1) and the needs-input bridge (M2) are documented in `docs/contracts/`. The design rationale is in `docs/adr/0001-herdr-openshell-bridge.md`.

## How it works

Three artifacts, two sides of the bridge:

- **`herdr-plugin.toml`** — a Herdr plugin whose `[[startup]]` hook spawns a detached Node poller.
- **`poller.js`** — a host-side poller (~5s loop) that lists sandboxes, opens/renames/closes panes, reports agent state, and reads the in-sandbox marker file.
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

A sandbox becomes a pane automatically when it's created. To run an opencode **agent** as a sandbox's main process, create it from an image that contains opencode:

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

From here, Herdr opens a pane named after the sandbox and keeps its status in sync.

## State mapping

Lifecycle (M1):

| Sandbox phase / exit code | Reported state |
|---|---|
| `Provisioning`, `Starting`, `Ready` | `working` |
| `Completed`, exit 0 | `idle` (Herdr shows **done**) |
| `Error`, exit ≠ 0 | `blocked` — "exit code N" |
| `Error`, no exit code | `blocked` — condition reason |
| `Stopped`, `Stopping`, `Suspending`, `Suspended` | `idle` — "paused: sandbox <phase>" |
| `Deleting` / absent | pane released and closed |
| `Unspecified`, `Unknown` | `unknown` |

Cognitive (M2): `permission.asked` / `question.asked` / `session.error` → `blocked` ("needs input"); active session or `tool.execute` → `working`; `session.idle` → `idle`. Cognitive state only overrides the lifecycle while the sandbox is still running; terminal phases always win.

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

- One `sandbox exec` per running sandbox per tick adds gateway load — fine at small scale, revisit at dozens of sandboxes.
- The full live prompt → marker → report cycle isn't verified end-to-end: the sandboxed agent in this environment can't reach a model (`credential_placement_mismatch`). The event→marker mapping is unit-tested; the runtime half needs one live run with a working provider.
- The poller only (re)spawns on server start — a poller that dies mid-session isn't revived until the next start.
- New panes split the focused pane, so many concurrent sandboxes keep shrinking it; a dedicated workspace/tab is the upgrade.
- Linux and macOS only (the singleton lock uses a unix socket).
