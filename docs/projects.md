# Projects, and the commons

How the app is cut into pieces, and where data that belongs to nobody lives.

## Three places, three kinds of thing

| Place | What's in it | In git? |
|---|---|---|
| **skeleton** (this repo) | Code. Generic, shareable, no one's data. | Yes, deliberate commits. |
| **the owner's vault** (`EXOCORTEX_DATA_DIR`) | Their life data: `exo.db`, the `.json` copies, journal content. | Their private repo. |
| **the commons** (`commons.py`) | Public reference data — agency datasets, reports, PDFs — kept exactly as published, with a checksummed `manifest.json`. | Its own repo, shareable. |

Rule of thumb: if it's code, the skeleton; if it's about the owner, the vault; if a
government or a journal published it and anyone could download it, the commons. The
*recipe* for getting commons data (which file, from where, how to parse it) is code
and lives here — `scripts/commons_fetch.py` is the one door files come in through.

Why the commons isn't in either repo: the files are big (git carries every version
forever, and GitHub refuses any file over 100 MB — one refused file blocks every
push), they aren't personal, and they aren't code. Keeping them whole and
checksummed is what lets anyone re-check a number against its source.

What's built *from* commons files (a `commons.db` of parsed rows) is rebuildable and
never committed. Hooking `commons.db` up to `exo.db` so one query can join them
(SQLite `ATTACH`) is the next step, due when the first dataset is parsed.

## Projects

`projects.json` cuts the app into projects — core, journal, todos, kitchen, health,
research, money, life, workshop, observatory. Each lists its modules, routes, pages,
scripts, **tables**, SQL collections and dev-note tabs.

- `scripts/project_map.py` prints the list; `scripts/project_map.py <project>` prints
  one in full, with its tables split into *their own record* (a new install starts
  these empty) and *rebuilt from a source* (nothing to carry over).
- `tests/test_projects.py` fails if a table, route, page, top-level module or SQL
  collection belongs to no project or to two. **Adding any of those means giving it a
  project in `projects.json`** — the failing test will say which.

This is a map, not a move: files stay where they are. It is the first step toward a
project someone else could install on its own (the "schema packs" idea) — a project
that can say exactly which code and tables it is, is one that could one day be
packaged. The projects are separate from the life *fronts* (`fronts.json`) and the
Observatory's session *domains* (`exo_domains.json`); whether domains should become
projects is an open question.
