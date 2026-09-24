<!-- Origin: written for the skeleton, 2026-09-24, as the template for the
     research-room folder (store.RESEARCH_ROOM_DIR — default
     <VAULT_DIR>/research-room/). Deploy copies it there. Scrubbed modular
     copy — plug-in points marked PLUG-IN(...). -->
# Research room — <OWNER_NAME>'s research desk

You (Claude Code) are running in this folder as a session in the **Research
room** of the Observatory. Two kinds of session stand here, and you are one
of them:

- **<OWNER_NAME>'s own desk session** — she opened it from the Research page
  to think, look things up, and read her own data with you.
- **A dispatched research worker** — the run dispatcher started you to answer
  ONE question (or distill ONE topic). Your job description was appended to
  your system prompt (`research-worker/CLAUDE.md` or
  `research-distiller/CLAUDE.md`); your first message begins `SESSION=` and
  carries an `APPLY:` line. Follow that job description; this file is the
  ground you stand on, not a second job.

<!-- PLUG-IN(OWNER_NAME): the person this research pipeline serves.
     PLUG-IN(VAULT_DIR): absolute path to the personal data vault (holds
     data/research.json, data/exo.db and the research/ library).
     PLUG-IN(SKELETON_DIR): absolute path to the app checkout — see
     agents/research-README.md. -->

## Reading her data — the read-only door

Her tables live in SQLite (`<VAULT_DIR>/data/exo.db`). Read them ONLY through
the query door, run from the app checkout with the data dir named:

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        venv/bin/python3 scripts/exo_query.py schema              # every table
    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        venv/bin/python3 scripts/exo_query.py schema <table>      # one table's columns
    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        venv/bin/python3 scripts/exo_query.py query "<sql>"       # a SELECT

It is read-only by construction: it refuses anything but a SELECT. Never open
`exo.db` with `sqlite3` yourself and never write to it — the JSON files beside
it are export mirrors the app never reads back, so a hand edit to either is a
write that silently goes nowhere or, worse, somewhere.

The research library (`<VAULT_DIR>/research/*.md`) and the pool
(`<VAULT_DIR>/data/research.json`) are yours to READ directly.

## Writing research — the one write door

Every write to the research pool goes through the code-enforced CLI, never a
hand edit of `research.json`:

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        venv/bin/python3 scripts/research_ctl.py <verb> ...

- `reply --session <id> --to <entry_id> --text "..." [--file report.md]`
  — an answer threaded under an entry.
- `apply --session <id> --text "..." [--file report.md]` — a worker's one
  result (what the `APPLY:` line in a worker prompt spells out verbatim).
- `file --entry <id> --topics id1,id2` — file an entry under topics.
- `create-topic --name "..."` — refuses a duplicate and prints the existing id.
- `close --session <id> --status done|failed --report "..."`.
- `set-session --session <id> [--conv <conversation>] [--run <run id>]` —
  link a research session to what ran it (the dispatcher does this for you).
- `claim add` / `claim link` / `claim value` — the claims verbs: a claim is a
  single checkable statement; `link` ties it to its source entry; `value`
  records the number or verdict it carries. (See `research_ctl.py --help`
  for the exact arguments on this install.)

Reports go in `<VAULT_DIR>/research/<slug>.md` — lowercase snake_case, never
overwrite (suffix `_2`, `_3`), first line `# Title`, inline citations.

## The law

- **Never fabricate a citation.** A source you cannot open is a source you do
  not cite. If you are unsure whether a thing exists, say so and stop.
- **Tier every claim.** Say which kind of ground each one stands on — a
  primary source you read, a secondary summary, a reasoned inference, or a
  guess — in those words, next to the claim.
- **Everything you write lands `reviewed: false`.** The verbs above enforce
  it; you never set `reviewed`, `verdict`, or a question's `status`. Those are
  <OWNER_NAME>'s alone — she checks, you propose.
- In the library you may only **create** `.md` files; the one exception is
  `research/edge/<topic-id>.md`, which a distill session (re)writes.
- Don't touch any other file in the vault, and never the app checkout.
- There is no terminal to close. When your job is done, just stop.
