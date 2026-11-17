# Contract: in-sandbox state markers (M2)

The in-sandbox opencode plugin (`herdr-state-plugin.js`) cannot reach Herdr's socket (the
sandbox is deny-by-default egress), so it reports the agent's cognitive state as **marker
lines**. This file is the format ticket 05 consumes; both ends change together.

## Format

```
HERDR-STATE state=<idle|working|blocked> seq=<integer>
```

- Exactly one line per state **change**, terminated by `\n`, printable ASCII, no ANSI escapes,
  no other text on the line. `grep HERDR-STATE` finds them; parse with
  `/HERDR-STATE state=(idle|working|blocked) seq=([0-9]+)/`.
- `seq` is strictly increasing for the lifetime of the agent process (`Date.now() * 1000`,
  then `+1` per line), so a reader can both order and dedupe markers.
- Example: `HERDR-STATE state=blocked seq=1763398000001234`.
- A repeated state emits nothing; the plugin never reports `done` or `unknown` (Herdr derives
  `done` from `idle`, and M1 owns `unknown`).

## Where the markers land

- **`$HOME/.herdr-state`** (`/sandbox/.herdr-state`) — always, appended. Read it with
  `openshell sandbox exec <name> -- cat /sandbox/.herdr-state`. This is the reliable channel.
- **stdout** — only when the plugin's stdout is the agent's terminal (`process.stdout.isTTY`).
  In opencode v2.3.0 the plugin is loaded in the `opencode serve --stdio` child of the agent
  (measured: `loading plugin … role=server`, that process's fd 1 is `/dev/null` in TUI mode and
  a `socket:` in `--standalone` mode, `/dev/tty` is `EACCES`, `/dev/pts` is not even listable),
  so stdout there is the server protocol, not the pane. Do **not** rely on pane output for M2
  with this range of opencode; read the file.

## Event → state map (spec M2)

| opencode event | state |
|---|---|
| `permission.asked`, `question.asked`, `session.error` | `blocked` |
| `session.status` with status `active` / `busy` / `running`, `tool.execute.before`, `tool.execute.after` | `working` |
| `session.idle`, `session.status` with status `idle` | `idle` |
| `permission.replied`, `question.replied`, `question.rejected`, `session.compacted` | `working` |

Nothing else emits: `session.created`, `session.updated`, `session.deleted` and unknown
`session.status` values produce no marker, so the M1 lifecycle state stands.

Events from a subagent (child) session are ignored except `permission.asked`,
`question.asked` and the three replied/rejected events — a subagent going idle must not flip the
pane to `idle` while the root agent is still working.

## Reader rules (for ticket 05)

- Read the file on each poll, then keep only markers whose `seq` is greater than the last one
  seen for that sandbox: the file is append-only across `stop`/`start`, so old markers are still
  there. On the **first** sight of a sandbox, adopt the highest `seq` in the file as the baseline
  and report nothing — that file is a previous run's news.
- A missing file, an empty file or a sandbox that cannot be `exec`ed is not an error — markers
  only exist while the agent inside is running; M1 lifecycle mapping still applies.
- Report with `herdr pane report-agent … --state <idle|working|blocked>`; nothing else is
  reportable. A marker has no text, so `blocked` is reported with `--message "needs input"`.
- Only report a cognitive state while the sandbox is in a running phase
  (`Provisioning`/`Starting`/`Ready`); once it is terminal its markers are stale and the M1
  lifecycle mapping stands.

## Install

`--upload` cannot be combined with a trailing main-process command, so upload **after** create
(the file survives `sandbox stop` → `start`). The poller does this for every sandbox it first
sees, best effort, and retries on later ticks until the sandbox accepts it:

```bash
openshell sandbox upload <name> ./herdr-state-plugin.js /sandbox/.config/opencode/plugins/
```

The directory is `plugins/` (plural) for opencode v2.3.0 (matches `~/.config/opencode/plugins`
on the host; `opencode plugin list` shows the file as a `local` plugin). Baking the file into
the image at that path is equivalent, and is the only way to have it loaded before the agent
starts. Plugins hot-reload when the file changes, so an upload into a running sandbox is picked
up without a restart.

## Verification status

- Unit-tested: `node --test test/state-plugin.test.mjs` (mapping, marker format, dedupe,
  subagent suppression, no socket use).
- Live: the plugin loads inside a real sandbox (`loading plugin … role=server` in
  `/sandbox/.local/share/opencode/log/opencode.log`) and appends to `/sandbox/.herdr-state`
  from that process (probed with a throwaway plugin, since the marker emitter is silent until
  the first state change).
- **Not verified live:** a full prompt → marker cycle. The sandboxed agent in this environment
  cannot reach a model (`credential_placement_mismatch` from `sandbox exec`, `ECONNREFUSED` to
  `models.opencode.ai`), so no session ever produced `session.status` / `session.idle`.
  The event→marker half is unit-tested; the runtime half needs one live run in an environment
  with a working provider.
