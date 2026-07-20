<!-- Origin: personal vault receipts/ (new file, not present in the vault —
     generic workspace README). -->
# receipts workspace

Copy this dir into your own vault at `<VAULT_DIR>/receipts`; the app opens
Claude sessions here (the Kitchen tab's "Scan receipt" / Money-tab receipt
upload — see `routes/kitchen/receipts.py`, which spawns a "receipts" tmux
session cwd'd into this folder via `routes/kitchen/shared.py`'s
`ensure_claude_session`).

**Reads:** receipt photos dropped in `grocery/` and this folder's root, plus
`../data/expense_receipts.json` (read-only). **Writes:** only sibling
`.parsed.json` staging files — never the SQL-backed `data/*.json` mirrors
directly. See `CLAUDE.md` for the full doctrine, `receipt_scanner.md` for the
OCR technique, and `grocery_agent.md` for a broader standalone grocery-agent
reference.

No `.claude/settings.json` here — the app instead loosens this dir's
permissions (`chmod_for_claude`) before spawning, since Flask and the Claude
process may run as different Linux users.
