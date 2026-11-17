# 01: Lock the bridge contract (research spike)

**Type:** research

**What to build:** Verify and record the concrete contract the bridge depends on, against the live OpenShell gateway and Herdr socket. This makes every later ticket implementable against a known, stable contract instead of guesses.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] Record the exact JSON field paths (and observed values) from `openshell sandbox list -o json` and `openshell sandbox get <name> -o json` for: sandbox name/id, phase, exit code, and any stopped/suspended indicator.
- [ ] Enumerate the observed sandbox phases and map each to the agreed Herdr agent state (working / done / blocked-with-message / done-paused) per the spec's M1 table.
- [ ] Confirm a working way to make opencode the sandbox's main process (template, `create --from` + trailing command, or upload-per-sandbox), and record which path is used.
- [ ] Verify `openshell sandbox connect <name>` attaches to the sandbox and note its exit/disconnect behaviour.
- [ ] Save all findings as markdown notes outside the repo, referenced by later tickets.
