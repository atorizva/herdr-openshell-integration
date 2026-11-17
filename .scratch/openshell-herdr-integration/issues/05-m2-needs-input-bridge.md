# 05: M2 needs-input bridge

**Type:** task

**What to build:** The poller reads the in-sandbox plugin's state-marker file (`/sandbox/.herdr-state`, format in `docs/contracts/state-markers.md`) and reports the latest cognitive state as the pane's agent state, so cognitive "needs input" states flow end-to-end.

**Blocked by:** 03 (M1 lifecycle mirror), 04 (In-sandbox state-emitter plugin).

**Status:** resolved

- [ ] The poller reads the state-marker file for each running sandbox (via `openshell sandbox exec <name> -- cat /sandbox/.herdr-state`) and reports the latest mapped agent state.
- [ ] A permission/question prompt in the sandboxed agent reports blocked; activity reports working; idle reports idle.
- [ ] Detached sandboxes (no attached pane, or exec fails) still report lifecycle-only state without erroring.

> Deviation (from ticket 04 live testing): opencode v2.3.0 plugins load in a `serve --stdio` child whose stdout is `/dev/null`/`socket:`, so markers CANNOT ride pane output. The plugin writes to `/sandbox/.herdr-state`; the poller reads that file.
