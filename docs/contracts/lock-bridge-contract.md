# Bridge contract: OpenShell sandbox ⇄ Herdr pane

Locked against the live gateway and Herdr socket on 2026-11-17 (openshell 0.1.8, herdr 0.9.5,
gateway `https://127.0.0.1:17670`, local Docker compute driver). Raw JSON, phase timelines and
attach transcripts: `/tmp/opencode/herdr-research/` (outside the repo).

## 1. Sandbox → pane identity

One sandbox = one opencode agent, surfaced in the one Herdr pane the user connected to it from
(the plugin never creates a pane).

| Need | Field path | Notes |
|---|---|---|
| pane name / `connect` argument | `sandboxes[].name` | unique per workspace |
| stable id (track across polls) | `sandboxes[].id` | uuid |
| lifecycle | `sandboxes[].phase` | string enum name |
| exit code | `sandboxes[].exit_code` | `null` or number |
| stopped/suspended indicator | `sandboxes[].phase` only | no separate boolean |
| diagnostic message | `sandboxes[].conditions[].reason` / `.message` | e.g. `MainProcessFailed` |

`openshell sandbox list -o json` returns `{next_page_token, sandboxes[]}` and already contains
every field above — **poll `list` once per tick; `get` is only for diagnostics.** `get` adds
`main_process_instance_id`, `restart_count`, `restart_policy`, `revision`, `policy`.

A missing sandbox is an error, not an empty entry:

```
Error:   × code: 'Some requested entity was not found', message: "sandbox not found"
```

This also happens for ~1 s right after `create` — treat it as "recheck next tick", not a crash.

## 2. Phase → agent-state mapping (M1)

`S = sandboxes[]` from `list`. Report with
`herdr pane report-agent <pane_id> --source openshell --agent opencode --state <state> --seq <n> [--message <msg>]`.

| `S.phase` (+ `S.exit_code`) | Report | Panel |
|---|---|---|
| `Provisioning`, `Starting`, `Ready` | `--state working` | working |
| `Completed` (`exit_code == 0`) | `--state idle` | done |
| `Error` (`exit_code != 0`) | `--state blocked --message "exit code <n>"` | blocked |
| `Error` (infra, `exit_code` null) | `--state blocked --message "<conditions[].reason>"` | blocked |
| `Stopped`, `Suspending`, `Suspended` | `--state idle --message "paused: sandbox <phase>"` | done (paused) |
| `Deleting`, or absent from `list` | `release-agent` (never close the pane) | — |
| `Unspecified`, `Unknown` | `--state unknown` | unknown |

Rules:

- **`done` is never reported.** Herdr's reportable states are `idle | working | blocked | unknown`;
  it derives `done` from `idle` (panel `agent_status` includes `done`). "Done (paused)" is
  `idle` plus the `--message` text — Herdr has no paused state.
- **Phase wins over exit code.** `Stopped` can carry `exit_code: 143` (SIGTERM); always map it to
  paused, never to blocked.
- `stop` passes through a transient `Error`/`Stopping` with `exit_code 143`: require an `Error`
  to persist to the next poll before reporting `blocked`.
- Send `--seq` strictly increasing per pane; on pane removal, `herdr pane release-agent`.
- A non-zero `report-agent` exit is **not** proof the pane is gone: confirm with
  `herdr pane get <pane_id>` (`error.code == "pane_not_found"`) and only then drop tracking.
  Any other failure is transient — retry the same report next tick rather than re-detecting
  (and reporting twice) for the same sandbox.
- A `Completed`/`Error` sandbox has a gone main process, so it can never be connected to —
  it never gets a row.

## 3. Pane detection

The poller never creates a pane. It maps each sandbox to the pane the user connected to it
from, via `herdr pane process-info --pane <id>` → `foreground_processes[].argv`. A live
`connect` session shows three foreground processes; the sandbox name is recoverable from any
of them:

- `openshell sandbox connect <name>` (argv `["openshell","sandbox","connect",<name>]`);
- the `ssh` child's `ProxyCommand=… openshell ssh-proxy … --sandbox <name> …` string;
- the `/usr/bin/openshell ssh-proxy … --sandbox <name> …` process (the `--sandbox` token).

The older `openshell sandbox exec -n <name> --tty …` session shows a single `openshell
sandbox exec` argv instead (no ssh child). **The ssh/ssh-proxy argv carries a `--token`
credential — never log or store raw argv.**

`connect` attaches to the sandbox's **canonical main process** (`ssh -tt … -s sandbox
openshell-main`), not to a new shell:

- keystrokes and output are the agent's own stdin/stdout;
- a later attach **replays up to 1 MiB** of prior output (so stdout markers repeat after a
  re-attach — dedupe in M2);
- `Ctrl-D` or `Ctrl-P` then `Ctrl-Q` detaches without terminating the main process (same
  `main_process_instance_id` after detach);
- one attachment owns stdin at a time; others are read-only and their keystrokes are dropped;
- the pane's exit code equals the agent's exit code (measured: agent `exit 3` ⇒ `connect` exit 3);
- for an already-finished agent `connect` exits 1 with
  `openshell: cannot connect to the canonical main process: canonical main process already finished`;
- a PTY is only allocated when the sandbox was created with `--tty` — sandboxes hosting the
  opencode TUI must be created with `--tty`.

## 4. opencode as the sandbox main process

`openshell sandbox template create` only sets image/resources/env — **a template cannot set the
main process**. Use `create --from <image> -- <command>` (the image must contain opencode):

```bash
openshell sandbox create --name my-agent \
  --from ghcr.io/anomalyco/opencode@sha256:998e… \
  --provider opencode-go \
  --tty --detach \
  -- opencode
```

Verified live: `-- opencode --version` ⇒ phase `Completed`, `exit_code 0`
(`MainProcessCompleted`); `-- opencode` (TUI) ⇒ phase `Ready` and `connect` lands directly in the
opencode TUI. The default `nvcr.io/nvidia/base/ubuntu:24.04` image has no opencode.

The in-sandbox state plugin (M2) is uploaded **after** create, because `--upload` cannot be
combined with a trailing command. The poller does it automatically for each sandbox it first
sees (best effort, retried):

```bash
openshell sandbox upload <name> ./herdr-state-plugin.js /sandbox/.config/opencode/plugins/
```

(`HOME=/sandbox`, read-write; the file survives `stop` → `start`.) Baking it into the image works
too and is the only way to have it present before the agent starts.
