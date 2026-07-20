<!-- Origin: personal vault recipes/ (new file, not present in the vault —
     generic workspace README). -->
# recipes workspace

Copy this dir into your own vault at `<VAULT_DIR>/recipes`; the app opens
Claude sessions here (the Kitchen tab's Recipes section — see
`routes/kitchen/recipes.py`, which spawns a "recipes" tmux session cwd'd into
this folder via `routes/kitchen/shared.py`'s `ensure_claude_session`).

**Reads:** URL/photo submissions in `urls/` and `images/`. **Writes:** only
structured recipe JSON in `parsed/` — never `data/recipes.json` itself, which
stays human-reviewed; the frontend writes it after the owner approves. See
`CLAUDE.md` for the output schema.

No `.claude/settings.json` here — the app instead loosens this dir's
permissions (`chmod_for_claude`) before spawning, since Flask and the Claude
process may run as different Linux users.
