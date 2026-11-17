# 02: Host plugin + poller lifecycle

**Type:** task

**What to build:** The Herdr plugin manifest and a detached Node poller that Herdr starts on server start, and that keeps itself running (re-spawn on server start, self-heal if killed).

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] Installing/enabling the plugin registers a `[[startup]]` hook that spawns the poller detached, with the plugin environment (socket path, bin path, env flag).
- [ ] The poller starts, runs a ~5s loop, and does not block Herdr's server process.
- [ ] The poller re-spawns on every Herdr server start.
- [ ] If the poller process is killed, it recovers on the next server start.
- [ ] A smoke check shows the poller alive after a Herdr server restart.
