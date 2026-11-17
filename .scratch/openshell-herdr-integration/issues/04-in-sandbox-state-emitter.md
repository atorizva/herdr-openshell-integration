# 04: In-sandbox state-emitter plugin

**Type:** task

**What to build:** An opencode plugin that runs inside the sandbox and prints the agent's cognitive state as stdout marker lines (the "needs input" signal), in place of the existing socket-based host plugin.

**Blocked by:** 01 (Lock the bridge contract) — needs the main-process/install path from the spike.

**Status:** resolved

- [ ] The plugin emits marker lines to stdout for the mapped opencode events (permission.asked / question.asked / session.error → blocked; session.status active/busy/running + tool.execute.* → working; session.idle → idle), matching the spec's M2 map.
- [ ] The plugin does not try to reach Herdr's socket (unreachable from inside the sandbox).
- [ ] Running opencode in a sandbox with the plugin installed produces the expected marker lines on a prompt.
