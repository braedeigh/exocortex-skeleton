# Maps — a codebase as boxes and named arrows

Terrain's **Map** room (`/terrain/map`) draws a codebase the way you'd sketch it
on a whiteboard: the whole project at the top, each box opening into its parts,
and arrows between boxes that say what kind of link they are. It is drawn from
small markdown files, one per box. A person or a session writes them by hand.
Code only checks that they are still true.

Code: `codemap.py` (read, check, stamp), `routes/terrain_map.py` (the API),
`scripts/codemap.py` (the command line), `frontend/src/features/terrain/TerrainMapView.tsx`
(the page).

## Where the files live

In the repo the map describes, at `docs/map/<name>/`. Every repo this system
knows can carry maps: the main Terrain map's own folders, and every build on the
Builds list. A map is called `<repo id>/<name>`, for example `skeleton/observatory`.

## One box, one file

```markdown
---
id: api.auth
name: Sign-in
kind: module
parent: api
sources:
  - apps/api/src/auth/
links:
  - depends-on db.client: Sign-in reads a session through the database client.
  - writes db.sessions: A sign-in writes one session row.
written: 2026-10-02
fingerprint: 3f2a9c1b0d7e
---

What the box is, in plain controlled English: short sentences, one fact
each, present tense. A few sentences, no more than two paragraphs.
```

- **id**: lowercase words, dots and dashes. The file is `<id>.md`.
- **kind**: `project` (exactly one, the top box, no parent), `module`, `feature`,
  `data`, `script`.
- **parent**: the box this one sits inside. No parent means the top level.
- **order**: optional number. Boxes with an order are listed first in the side panel.
- **sources**: the files or folders this box *stands for*, relative to the repo root.
  A box should own its own files. A grouping box whose parts own the files lists
  none (or only files no part owns), otherwise every edit to a part marks the
  parent stale too.
- **links**: `<kind> <box id>: <one-line reason>`. A link may point at any box in
  the map, at any depth. The page lifts it to whichever boxes are on screen.
  Kinds: `depends-on`, `calls`, `reads`, `writes`, `hosts`, `implements`,
  `generates`, `composes`. Arrows point from the box that does the action to the
  box it acts on (A *calls* B, A *writes* B).
- **written** / **fingerprint**: stamped by the script, not typed by hand.

## Keeping it true

- **Broken**: a source file or folder no longer exists. `scripts/codemap.py check`
  exits 1 and the page marks the box red.
- **Stale**: the box's files changed since its words were stamped (the
  fingerprint is a hash of every file the box stands for). Nothing is necessarily
  wrong, but the words may have drifted. The page marks the box amber.
- The nightly cron runs `scripts/codemap.py check --devnote`, which posts (or
  takes down) one `[map]` note on the terrain dev-note tab.

**To rewrite a stale box** (any session can do this):

1. `venv/bin/python3 scripts/codemap.py check <map>` lists the stale boxes.
2. For each one, read its source files and its current file. Rewrite the
   description and links so they are true now. `scripts/codemap.py imports <map>`
   lists the box-to-box imports in the code, and `·` marks one that no link
   covers yet.
3. `venv/bin/python3 scripts/codemap.py stamp <map> <box id> …` records that the
   words match the files as of now. Stamp only boxes you actually re-read.
4. Commit the map files in the repo they live in.
