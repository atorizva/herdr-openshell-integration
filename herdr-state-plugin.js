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
//     v2.3.0 plugins load in the `opencode serve --stdio` child, whose stdout is
//     a pipe/socket (or /dev/null), not the pane — writing markers there would
//     corrupt the server protocol instead of reaching the pane.

import fs from "node:fs";
import path from "node:path";

const MARKER_PREFIX = "HERDR-STATE";
const MARKER_FILE = path.join(process.env.HOME ?? "/sandbox", ".herdr-state");

export const STATE_BY_STATUS = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["running", "working"],
]);

export const STATE_BY_EVENT = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["session.error", "blocked"],
  ["tool.execute.before", "working"],
  ["tool.execute.after", "working"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
  ["session.compacted", "working"],
  ["session.idle", "idle"],
]);

// Subagent events must not overwrite the pane state of the root session, except for the
// ones that genuinely mean "the human is being asked" (and their answers).
const CHILD_EVENTS = new Set([
  "permission.asked",
  "question.asked",
  "permission.replied",
  "question.replied",
  "question.rejected",
]);

export function stateForEvent(type, properties = {}) {
  if (type === "session.status") {
    const status = properties.status;
    const kind = typeof status === "string" ? status : status?.type;
    return typeof kind === "string"
      ? STATE_BY_STATUS.get(kind.toLowerCase())
      : undefined;
  }
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
    const properties = event?.properties ?? {};
    const sessionID =
      typeof properties.sessionID === "string" ? properties.sessionID : undefined;

    const info = properties.info;
    if (info?.id && info.parentID) childSessions.add(info.id);

    // A subagent may only report the events that mean "a human is being asked"; every other
    // one would overwrite the root session's state.
    const state =
      sessionID && childSessions.has(sessionID) && !CHILD_EVENTS.has(type)
        ? undefined
        : stateForEvent(type, properties);

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

export const HerdrStatePlugin = async () => {
  const emit = createStateEmitter(writeMarker);
  return {
    event: async ({ event }) => emit(event),
  };
};

export default {
  id: "herdr.openshell-state",
  server: HerdrStatePlugin,
  setup() {},
};
