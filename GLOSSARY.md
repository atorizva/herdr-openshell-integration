# Herdr–OpenShell Integration

The integration that makes coding agents running inside OpenShell sandboxes appear and
behave as agents in the Herdr terminal runtime.

## Language

**Agent**:
A coding-agent program (here, opencode) that Herdr recognizes in a pane and OpenShell hosts
in a sandbox.

**Pane**:
Herdr's terminal unit (`workspace → tab → pane`) that hosts one agent.

**Sandbox**:
OpenShell's isolated execution environment whose *main process* is one agent.

**Agent state**:
Herdr's per-agent lifecycle: `idle`, `working`, `blocked`, `done`, `unknown`.
_Avoid_: status, agent status.

**Sandbox phase**:
OpenShell's per-sandbox lifecycle: `Provisioning`, `Ready`, `Completed`, `Error`,
`Stopped`, `Suspended`, …
_Avoid_: status, state.

**Blocked**:
The Herdr state meaning the agent is waiting on the human (an approval or question).
_Avoid_: needs input, waiting for input.

**State marker**:
The `HERDR-STATE state=… seq=…` line the in-sandbox opencode plugin writes to
`/sandbox/.herdr-state`, the only channel that carries cognitive state out of a sandbox
(the plugin cannot use Herdr's socket). Format: `docs/contracts/state-markers.md`.
_Avoid_: signal, event line.

**Bridge**:
The Herdr plugin (and its detached poller) that detects the pane the user connected each
OpenShell sandbox to, and reports that pane's agent state.
