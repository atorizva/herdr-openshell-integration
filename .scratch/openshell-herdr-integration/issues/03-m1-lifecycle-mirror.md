# 03: M1 lifecycle mirror (core slice)

**Type:** task

**What to build:** Every OpenShell sandbox automatically appears in Herdr as a pane (running `openshell sandbox connect <name>`), and its lifecycle phase is reported as the pane's agent state.

**Blocked by:** 01 (Lock the bridge contract), 02 (Host plugin + poller lifecycle).

**Status:** resolved

- [ ] A newly created sandbox appears as a Herdr pane running the connect command, with no manual steps.
- [ ] The pane's agent state tracks the sandbox phase: provisioning/starting/ready → working, completed + exit 0 → done, error/exit ≠ 0 → blocked (with exit-code message), stopped/suspended → done (paused).
- [ ] A deleted sandbox closes its pane.
- [ ] A stopped or suspended sandbox keeps its pane and reports done (paused), resumable.
- [ ] Re-running the poller does not create duplicate panes for already-tracked sandboxes.
