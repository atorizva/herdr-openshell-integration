# Bridge OpenShell sandboxes into Herdr via a plugin + detached poller + in-sandbox self-report

We want Herdr (the TUI) to show and drive opencode agents that run inside OpenShell
sandboxes. We bridge them with a Herdr plugin whose `[[startup]]` hook spawns a detached
poller: the poller mirrors each sandbox into a Herdr pane (running `openshell sandbox
connect <name>`) and reports state via `pane.report_agent`, while an in-sandbox opencode
plugin prints state markers to stdout for the poller to read back as the "needs input"
signal.

## Considered Options

- **Standalone daemon** (rejected): simpler to write, but lives outside Herdr's lifecycle;
  the user asked for it to be bundled as a plugin.
- **In-sandbox self-report via OSC 7501** (rejected): Herdr TUI does not parse OSC 7501, and
  the sandbox cannot reach Herdr's socket (deny-by-default egress) — so neither the
  herdr-core nor the socket channel works from inside the sandbox.
- **Modify OpenShell to expose agent state** (rejected): upstream NVIDIA runtime; OpenShell
  only models sandbox *phase*, not cognitive state, and this is out of scope.
- **Rely solely on Herdr's built-in screen detection** (kept as a validation step only):
  zero code, but not reliable enough for "needs input".

## Consequences

- The detached poller is unsupervised by Herdr (no restart/health); the plugin must re-spawn
  it on every server start and self-heal.
- "Needs input" only flows while a Herdr pane is attached to the sandbox; a detached sandbox
  reports lifecycle-only state.
- Introduces two artifacts to maintain: a host-side Herdr plugin (manifest + Node poller) and
  an in-sandbox opencode state-emitter.
