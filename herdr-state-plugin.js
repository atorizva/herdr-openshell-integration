// In-sandbox opencode state emitter for the Herdr ↔ OpenShell bridge.
//
// Runs inside an OpenShell sandbox as an opencode plugin (uploaded to
// `~/.config/opencode/plugins/herdr-state-plugin.js`). Herdr's socket is
// unreachable from the sandbox, so instead of reporting it emits one marker line
// per agent-state change:
//
//   HERDR-STATE state=<idle|working|blocked> seq=<monotonic integer>
//
// e.g. `HERDR-STATE state=blocked seq=1763398000001234` — one line, "\n"
// terminated, no escapes, nothing else on the line, so `grep HERDR-STATE` and
// /HERDR-STATE state=(idle|working|blocked) seq=([0-9]+)/ both work on it.
// A line is emitted only when the state actually changes; `seq` grows
// monotonically, which is what lets a reader drop the duplicated markers that
// `openshell sandbox connect` replays when it re-attaches.
//
// Sinks (see docs/contracts/state-markers.md):
//   * always appended to `$HOME/.herdr-state` (`/sandbox/.herdr-state`), which
//     the host reads with `openshell sandbox exec <name> -- cat /sandbox/.herdr-state`;
//   * also written to stdout when stdout is the agent's terminal. In opencode
//     v2.x plugins load in the `opencode serve --stdio` child, whose stdout is
//     a pipe/socket (or /dev/null), not the pane — writing markers there would
//     corrupt the server protocol instead of reaching the pane.
//
// opencode v2 plugin API: only `setup(ctx)` is honoured; the V1 `server()`/`event`
// hook does NOT run in v2 (the original bug). Events arrive from
// `ctx.event.subscribe({ signal })` as `{ type, data, ... }` — payload in `data`,
// not V1's `properties`.

import fs from "node:fs";
import path from "node:path";

const MARKER_PREFIX = "HERDR-STATE";
const MARKER_FILE = path.join(process.env.HOME ?? "/sandbox", ".herdr-state");

// opencode v2 event -> Herdr agent state. `session.status`/`session.idle` are declared
// in the v2 schema but have no publisher, so the real signals are `session.execution.*`
// (busy/idle) and `permission.*`/`form.*` (needs input; v2 has no `question.*` events).
export const STATE_BY_EVENT = new Map([
  // working: a turn began or continued, or the human answered a prompt
  ["session.execution.started", "working"],
  ["session.step.started", "working"],
  ["session.step.ended", "working"],
  ["session.tool.called", "working"],
  ["session.retry.scheduled", "working"],
  ["permission.replied", "working"],
  ["form.replied", "working"],
  ["form.cancelled", "working"],
  // idle: the turn finished
  ["session.execution.succeeded", "idle"],
  ["session.execution.interrupted", "idle"],
  // blocked: needs the human (pending permission, a question form, or a failed turn)
  ["permission.asked", "blocked"],
  ["form.created", "blocked"],
  ["session.execution.failed", "blocked"],
]);

// Subagent (child) events must not overwrite the root session's state, except the ones
// that genuinely mean "the human is being asked" (and their answers).
const CHILD_EVENTS = new Set([
  "permission.asked",
  "form.created",
  "permission.replied",
  "form.replied",
  "form.cancelled",
]);

export function stateForEvent(type) {
  return STATE_BY_EVENT.get(type);
}

export function markerFor(state, seq) {
  return `${MARKER_PREFIX} state=${state} seq=${seq}`;
}

// `write` receives one complete marker line per state change.
export function createStateEmitter(write) {
  const childSessions = new Set();
  let lastState;
  let seq = Date.now() * 1000;

  return (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;

    // v2 marks a subagent child on session.created with a parentID.
    if (type === "session.created" && data.parentID) childSessions.add(data.sessionID);

    // A subagent may only report the events that mean "a human is being asked"; every other
    // one would overwrite the root session's state.
    const state =
      sessionID && childSessions.has(sessionID) && !CHILD_EVENTS.has(type)
        ? undefined
        : stateForEvent(type);

    if (!state || state === lastState) return;
    lastState = state;
    seq += 1;
    write(`${markerFor(state, seq)}\n`);
  };
}

function writeMarker(line) {
  try {
    fs.appendFileSync(MARKER_FILE, line);
  } catch {
    // The sandbox workspace is read-only or gone; state reporting is best effort
    // and must never crash the agent.
  }
  if (process.stdout.isTTY) {
    try {
      fs.writeSync(1, line);
    } catch {}
  }
}

export default {
  id: "herdr.openshell-state",
  setup(ctx) {
    const emit = createStateEmitter(writeMarker);
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          emit(event);
        }
      } catch {
        // subscription aborted on dispose; nothing to do
      }
    })();
    return () => controller.abort();
  },
};
