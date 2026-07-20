<!-- Origin: personal vault triage/ (new file, not present in the vault —
     generic workspace README). -->
# triage workspace

Copy this dir into your own vault at `<VAULT_DIR>/triage`; the app opens
Claude sessions here (the Triage button — see `routes/triage.py`'s
`triage_open`, which spawns a "todo" tmux session cwd'd into this folder via
`routes/kitchen/shared.py`'s `ensure_claude_session`, then the frontend
deep-links into a live terminal pane pointed at it).

**Reads:** `<VAULT_DIR>/data/todos.json`, `reminders.json`,
`activity_log.json`. **Writes:** only `todos.json`, and only bucket/order —
never item text — per the rules in `CLAUDE.md`.

Its permission sandbox is `.claude/settings.json`, which grants
`additionalDirectories` access to the vault's `data/` dir so it can read/write
those three files without a permission prompt — it ships with a literal
`<VAULT_DIR>/data` placeholder; replace `<VAULT_DIR>` with your vault's
actual absolute path before first use, or Claude Code will treat it as a
literal (nonexistent) directory name.
