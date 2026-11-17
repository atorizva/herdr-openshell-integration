# Herdr ↔ OpenShell integration

Make agents running inside OpenShell sandboxes appear — and behave — as agents in the
Herdr terminal runtime, so they can be watched on the agent panel and worked with "as if
they ran on the host".

## Model

One OpenShell **sandbox** = one **opencode** agent = one Herdr **pane** — but the pane is the
*user's own*, the one they ran `openshell sandbox connect <name>` in, never a pane the plugin
creates. The sandbox's *main process* is opencode, so `connect` lands directly in the agent
and OpenShell's `exit_code` / `phase` genuinely reflect it.

## Decisions (agreed)

1. **Surface** — Herdr TUI (`herdr`), not `herdr-core`/`herdr-app`.
2. **Agent** — opencode only.
3. **Fidelity** — full cognitive state (`working` / `done` / `needs input`) is the target;
   lifecycle mapping is milestone 1.
4. **Scope** — general: every OpenShell sandbox appears in Herdr once the user connects to
   it (a running-but-unconnected sandbox has no pane to report to, so no row).
5. **Glue** — a Herdr plugin.
6. **"Needs input"** — an in-sandbox opencode plugin + a host-side reader; validate Herdr's
   built-in opencode screen-detection first as a free win.
7. **Launch model** — sandbox = agent (opencode as main process/workload).
8. **Identity** — report `agent: "opencode"` with `source: "openshell"`; the pane is the
   user's own (identified by its connect session, not renamed by the plugin).
9. **Removal** — sandbox deleted / gone ⇒ release the agent row; never close the user's
   pane. Sandbox stopped/suspended ⇒ keep reporting `done(paused)` so it can be resumed.

## Architecture

A Herdr plugin (`herdr-plugin.toml`) acts as the bridge. There is no plugin SDK: the whole
`herdr` CLI plus the socket are the plugin API, and every plugin command receives
`HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, and `HERDR_ENV=1`.

- **`[[startup]]`** spawns a detached poller (Node) that loops; Herdr does not supervise or
  reap descendants, so the plugin owns lifecycle and re-spawns on every server start.
- **Poller loop (~5s):** `openshell sandbox list -o json` → diff against tracked sandboxes →
  detect the pane each sandbox is connected to via `herdr pane process-info` (the connect
  session's `ssh`/`ssh-proxy` argv carries the sandbox name), then report state to that pane;
  for a vanished sandbox, release the agent row.
- **Lifecycle state** is reported via `pane.report_agent`
  (`herdr pane report-agent <pane_id> --source openshell --agent opencode --state …`).
- **"Needs input"** is read by the poller from the pane via socket `events.subscribe
  pane.output_matched` (or `pane read`), matching a marker line printed by an in-sandbox
  opencode plugin.

The in-sandbox plugin is a small variant of the existing
`~/.config/opencode/plugins/herdr-agent-state.js`, changed to write state markers to stdout
instead of the socket (the socket is unreachable from inside the sandbox — deny-by-default
egress).

## Milestones

### M1 — lifecycle

`openshell sandbox get <name> -o json` → Herdr state:

| OpenShell phase / signal | Herdr state |
|---|---|
| `Provisioning` / `Starting` / `Ready` | `working` |
| `Completed` + exit code 0 | `done` |
| `Error` / exit code ≠ 0 | `blocked` (message: exit code) |
| `Stopped` / `Suspended` | `done` (paused) |

Reportable states are `idle|working|blocked|unknown`; `done` is derived by Herdr. Exact
enum values finalized against the live API during M1.

### M2 — "needs input"

Reuse the existing opencode integration's event→state map, emitted to the marker file by the
in-sandbox plugin and translated by the poller. This is the **v2** event map (v1 hooks do not
run in opencode v2.x):

| opencode v2 event | Herdr state |
|---|---|
| `permission.asked`, `form.created`, `session.execution.failed` | `blocked` |
| `session.execution.started`, `session.step.*`, `session.tool.called`, `session.retry.scheduled`, `permission.replied`, `form.replied`, `form.cancelled` | `working` |
| `session.execution.succeeded`, `session.execution.interrupted` | `idle` |

## Deliverables

- `herdr-plugin.toml` + poller (host side, this repo).
- in-sandbox opencode state-emitter plugin (installed into each agent sandbox).

## Open questions / risks

- **Template wiring:** `openshell sandbox template` / `sandbox provider` subcommands errored
  on the installed 0.1.8 CLI — confirm opencode can be set as a sandbox's *main process* via
  a workload template (or `sandbox create --from <image>`), or the plugin must be uploaded
  per sandbox. First implementation spike.
- **`sandbox connect` attach/replay** not yet verified against the live gateway.
- **Detached poller** is unsupervised — re-spawn on server start + self-heal required.
- **Detached sandbox** reports lifecycle-only ("needs input" requires the connect pane; a
  sandbox never connected to has no row at all).
