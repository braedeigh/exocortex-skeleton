<!-- Origin: personal vault person-summary/ (new file, not present in the
     vault — generic workspace README). -->
# person-summary workspace

Copy this dir into your own vault at `<VAULT_DIR>/person-summary`; the app
opens Claude sessions here (the "regenerate impression" button on a person
page — see `routes/person.py`'s `person_summarize`, which spawns a tmux
session cwd'd into this folder via `routes/kitchen/shared.py`'s
`ensure_claude_session`).

**Reads:** the person's file and journal days under `<VAULT_DIR>/tulku/`.
**Writes:** only that one person's `## Impression` section, and only after
they approve the draft live in the terminal — see `CLAUDE.md`.

Its permission sandbox is `.claude/settings.json`, which grants
`additionalDirectories` access to the vault's `tulku/` tree — it ships with a
literal `<VAULT_DIR>/tulku` placeholder; replace `<VAULT_DIR>` with your
vault's actual absolute path before first use, or Claude Code will treat it
as a literal (nonexistent) directory name.
