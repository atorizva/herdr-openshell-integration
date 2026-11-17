# Bridge OpenShell sandboxes into Herdr via a plugin + detached poller + in-sandbox self-report

We want Herdr (the TUI) to show and drive opencode agents that run inside OpenShell
sandboxes. We bridge them with a Herdr plugin whose `[[startup]]` hook spawns a detached
poller: the poller mirrors each sandbox into a Herdr pane (named after the sandbox, running
`openshell sandbox connect <name>`) and reports lifecycle state via `pane.report_agent`,
while an in-sandbox opencode plugin *appends* cognitive state markers to a file inside the
sandbox (`/sandbox/.herdr-state`) that the poller reads back each tick with
`openshell sandbox exec <name> -- cat /sandbox/.herdr-state` — that file read is the
"needs input" signal.

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
- "Needs input" flows for any *running* sandbox, attached or not: the markers live in a file
  inside the sandbox, so a detached sandbox still reports cognitive state (lifecycle-only
  state remains the fallback when the agent is not running or the file cannot be read).
- The poller owns plugin delivery: it uploads the in-sandbox emitter into each sandbox on
  first sight (`openshell sandbox upload <name> <plugin> /sandbox/.config/opencode/plugins/`,
  best effort, retried while it fails). Baking the file into the image is equivalent and is
  the only way to have it present before the agent starts.
- The marker file is append-only across `stop` → `start`, so the poller baselines the highest
  `seq` on first sight and only reports markers newer than that — a previous run's `blocked`
  never surfaces as "needs input" on a freshly started agent.
- Introduces two artifacts to maintain: a host-side Herdr plugin (manifest + Node poller) and
  an in-sandbox opencode state-emitter.

## Amendment (2026-11-17)

The decision body above was corrected to match tickets 04/05 and the final review:

- The markers are **not** read from pane stdout. They are written to `/sandbox/.herdr-state`
  and read over `openshell sandbox exec`; `pane read` / `pane.output_matched` was the original
  idea (see the spec's architecture note) and is dropped. The stdout sink in the in-sandbox
  plugin only applies when its stdout is the agent's terminal, which it is not in opencode
  v2.3.0 (`docs/contracts/state-markers.md`).
- "Needs input" therefore no longer requires an attached pane, contradicting the original
  consequence "only flows while a Herdr pane is attached".
- Plugin installation is automated by the poller, not a manual per-sandbox step.

