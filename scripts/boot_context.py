#!/usr/bin/env python3
"""Assemble the Keeper's boot package — the files a new Keeper would otherwise
hunt for and read one by one — and print it as one markdown document.

**What this does, in plain English.** A Keeper wakes with no memory. It used
to be told "read these files" and then find them itself, which meant guessing
paths, skipping things, and hand-carrying upcoming dates from one Keeper's
diary to the next. This script reads the list of what to load from a small
manifest in the owner's data folder, gathers it in a fixed order — the
standing rules first, then the recent journal, then a generated **Coming up**
section last — and prints the lot. `/journalstart` (and the 3 AM rollover) put
that output straight into the Keeper's first prompt.

**Three kinds of section.** The manifest is `keeper_boot.json` in the data
dir. Its shape:

    {"root": "../content",            # optional; where paths start (relative
                                      #   to the data dir). Default: CONTENT_DIR
     "sections": [
       {"title": "How to be", "files": ["CLAUDE.md", "PROTOCOLS.md"]},
       {"title": "Recent weeks", "dir": "Journal/Weekly", "glob": "*.md",
        "last": 4, "source": "database"},
       {"title": "Recent days", "cards": true, "budget_chars": 60000,
        "min_days": 3, "dir": "Journal/Daily", "glob": "*.md", "last": 7},
       {"title": "Sunday", "files": ["SUNDAY.md"], "weekday": "sunday"}
     ]}

  - `files` — named files, read from disk as they are.
  - `dir` + `glob` + `last` — the newest N files of a folder. With
    `"source": "database"` the folder is first copied into the `journal_pages`
    table (pagestore.py) and the pages are loaded from there; the files stay
    the truth and whatever writes them keeps writing them.
  - `"cards": true` — the recent journal days, built from the journal cards in
    exo.db (`cards`), newest days first until `budget_chars` is used up, never
    fewer than `min_days`. Each day is laid out exactly like its day file (the
    same renderer, tools/stream/stream.py) with one addition: every line
    carries its card id. If the database can't be read, the section falls
    back to its `dir` + `glob` + `last` day files.

**Why cards.** A card id is what lets the rest of the session avoid loading
the same thing twice. `build_package()` returns the ids it loaded beside the
text; the caller (routes/observatory.py `attach_boot_package`) writes them to
the session's record (loadrecord.py), and the context-on-mention hook
(tools/mention_context.py) skips anything on that record.

No manifest → a default list that matches a fresh install's content scaffold,
so the skeleton works out of the box and carries nothing personal.

It never crashes a wake: a missing file, an unreadable manifest, or any other
fault becomes a plain note inside the output, not an error.

Touches: `store.py` (DATA_DIR / CONTENT_DIR), `cardstore.py` and
`pagestore.py` (the two database mirrors), `tools/stream/stream.py` (the day
renderer), `comingup.py` (the Coming up block), `loadrecord.py` (through its
caller), `claude-commands/journalstart.md` and `scripts/keeper_rollover.py`
(its two callers), `tests/test_boot_context.py`.

Prompt that produced this: "instead of asking Claude to find and read the
files, I automatically inject them into the prompt from my records, either
from the sql or the markdown." / "Tell the keeper they can read more stuff
beyond the boundary of the injection." / "I'm wanting to load you from the
database instead, so that I can load more context that doesn't overlap."
"""
import argparse
import json
import os
import sys
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pagestore  # noqa: E402
import store  # noqa: E402

MANIFEST_NAME = "keeper_boot.json"
DEFAULT_MAX_CHARS = 40000
# A cards section with no `budget_chars` loads about this much journal.
DEFAULT_CARD_BUDGET = 60000
DEFAULT_MIN_DAYS = 3
# However large the budget, a cards section never looks further back than this.
MOST_DAYS = 120
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday",
            "saturday", "sunday")

# The fresh-install list: what the content scaffold's seed keeper reads.
DEFAULT_MANIFEST = {
    "sections": [
        {"title": "How to be", "files": ["CLAUDE.md"]},
        {"title": "Recent weeks", "dir": "Journal/Weekly", "glob": "*.md", "last": 2,
         "source": "database"},
        {"title": "Recent days", "cards": True,
         "dir": "Journal/Daily", "glob": "*.md", "last": 5},
        {"title": "Your last diary entries", "dir": "keeper-diary", "glob": "[0-9]*.md",
         "last": 2, "source": "database"},
    ],
}

HEADER = """# Boot package

Injected {stamp}. Everything below has already been read for you — don't
re-read these files at wake. **This is your starting point, not your
boundary:** read anything else you need, whenever the moment calls for it —
other days, threads, people, the owner's data files. The section list comes
from `{manifest}`.

In the journal days below, every line carries its card id in brackets after
the speaker letter: `B [1010b]:` under the heading for 2026-10-04 is card
`2026-10-04.1010b`. The app keeps a record of the cards loaded here, and the
packs that load when the owner names a person or thread skip them, so a pack
holds only what you don't already have.
"""


def _natural_key(path):
    """Sort names the way a person would: '99-x' before '205-y', and dates in
    date order."""
    return pagestore.natural_key(path.name)


def load_manifest():
    """(manifest, where_it_came_from). A missing or broken manifest falls back
    to the default list — with a note saying so, because a silently wrong boot
    is the failure this whole script exists to end."""
    path = store.DATA_DIR / MANIFEST_NAME
    if not path.exists():
        return DEFAULT_MANIFEST, "built-in default (no keeper_boot.json)"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(manifest.get("sections"), list):
            raise ValueError("no 'sections' list")
        return manifest, str(path)
    except (OSError, ValueError, AttributeError) as e:
        return DEFAULT_MANIFEST, f"built-in default ({path} unreadable: {e})"


def content_root(manifest):
    """Where the manifest's paths start: its own `root` (relative to the data
    dir) if it names one, else the content dir."""
    root = manifest.get("root")
    if root:
        return (store.DATA_DIR / root).resolve()
    return Path(store.CONTENT_DIR)


def section_files(section, root):
    """The files one section asks for, in reading order (oldest first).

    `files` lists them by name; `dir` + `glob` + `last` takes the newest N of
    a folder. Names that don't exist are returned anyway — the caller prints a
    'missing' note for them rather than dropping them without a word."""
    if section.get("files"):
        return [root / name for name in section["files"]]
    folder = root / section.get("dir", "")
    if not folder.is_dir():
        return [folder]
    found = sorted((p for p in folder.glob(section.get("glob", "*.md")) if p.is_file()),
                   key=_natural_key)
    last = section.get("last")
    if isinstance(last, int) and last > 0:
        found = found[-last:]
    return found


def _cut(text, max_chars, path):
    """Cut text at max_chars with a note saying where the rest is."""
    if len(text) > max_chars:
        text = (text[:max_chars]
                + f"\n\n*(cut at {max_chars:,} characters — Read {path} for the rest)*")
    return text.rstrip()


def render_file(path, max_chars):
    """One file as a headed block, cut at max_chars with a note saying where
    the rest is."""
    if not path.is_file():
        return f"### {path}\n\n*(missing — nothing at this path)*\n"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return f"### {path}\n\n*(unreadable: {e})*\n"
    return f"### {path}\n\n{_cut(text, max_chars, path)}\n"


def pages_from_database(section, root, max_chars):
    """A folder section loaded through the database: copy the folder's files
    into `journal_pages`, then read the newest ones back as headed blocks.
    None when the folder has no matching pages, so the caller can fall back to
    the files and say what is missing."""
    folder, glob = section.get("dir", ""), section.get("glob", "*.md")
    pagestore.sync_folder(root, folder, glob)
    pages = pagestore.newest(folder, glob, section.get("last"))
    if not pages:
        return None
    return [f"### {root / page['path']}\n\n"
            f"{_cut(page['body'], max_chars, root / page['path'])}\n" for page in pages]


@contextmanager
def _journal_engine(root):
    """The journal engine (tools/stream/stream.py), pointed at this vault.

    The engine finds the vault from an environment variable. The 3 AM rollover
    runs without one, so for the length of the render it is set to the
    manifest's root, then put back."""
    engine_folder = str(Path(__file__).resolve().parents[1] / "tools" / "stream")
    if engine_folder not in sys.path:
        sys.path.insert(0, engine_folder)
    import stream
    had = os.environ.get("TULKU_STREAM_ROOT")
    known = had or os.environ.get("EXOCORTEX_CONTENT_DIR")
    if not known:
        os.environ["TULKU_STREAM_ROOT"] = str(root)
    try:
        yield stream
    finally:
        if not known:
            os.environ.pop("TULKU_STREAM_ROOT", None)


def card_days(section, root, today):
    """The recent journal days, built from the cards in the database.

    Returns (blocks, cards): the text blocks to print, and the cards they hold
    as [{"id", "who", "body"}]. Walks back from today one day at a time and
    stops when the next day would pass the budget, but always takes at least
    `min_days`. A day is laid out by the day-file renderer, so the context
    line, the Keeper's questions, system reminders and the to-do, streak and
    edit markers all stay in time order with the owner's lines."""
    import cardstore
    import sqlstore

    budget = section.get("budget_chars") or DEFAULT_CARD_BUDGET
    least = section.get("min_days") or DEFAULT_MIN_DAYS
    # Bring the table up to this minute: the hourly sync may be an hour behind.
    cardstore.sync_fresh(root / "_system" / "data" / "cards")
    conn = sqlstore.open_db()
    try:
        days = [row[0] for row in conn.execute(
            "SELECT DISTINCT day FROM cards WHERE deleted_at IS NULL"
            " AND missing_since IS NULL AND day <= ? ORDER BY day DESC LIMIT ?",
            (today.isoformat(), MOST_DAYS))]
        chosen, used = [], 0
        with _journal_engine(root) as stream:
            for day in days:
                rows = conn.execute(
                    "SELECT id, who, ts, reply_to, kind, refs, session, body FROM cards"
                    " WHERE day = ? AND deleted_at IS NULL AND missing_since IS NULL"
                    " AND ts IS NOT NULL", (day,)).fetchall()
                day_cards = [stream.Card(
                    id=row[0], who=row[1], ts=row[2], reply_to=row[3],
                    kind=row[4] or "line", refs=json.loads(row[5] or "[]"),
                    session=row[6], body=row[7] or "") for row in rows]
                text = stream.render_day_text(day, day_cards, with_ids=True)
                if not text:
                    continue
                if len(chosen) >= least and used + len(text) > budget:
                    break
                chosen.append((text, day_cards))
                used += len(text)
    finally:
        conn.close()
    chosen.reverse()        # reading order: oldest day first
    blocks = [text.rstrip() + "\n" for text, _ in chosen]
    cards = [{"id": card.id, "who": card.who, "body": card.body}
             for _, day_cards in chosen for card in day_cards]
    return blocks, cards


def build_package(today=None):
    """The whole package, and what it loaded: (text, cards). `cards` is every
    journal card in the text as [{"id", "who", "body"}] — what the caller
    writes to the session's record so nothing is loaded a second time."""
    today = today or date.today()
    manifest, source = load_manifest()
    root = content_root(manifest)
    parts = [HEADER.format(stamp=datetime.now().strftime("%A %Y-%m-%d %H:%M"),
                           manifest=source)]
    loaded = []
    weekday = WEEKDAYS[today.weekday()]
    for section in manifest["sections"]:
        if not isinstance(section, dict):
            continue
        only_on = section.get("weekday")
        if only_on and str(only_on).lower() != weekday:
            continue
        max_chars = section.get("max_chars") or DEFAULT_MAX_CHARS
        parts.append(f"## {section.get('title') or 'Files'}\n")
        # Try the database first for the two kinds of section that use it;
        # any fault there falls through to the plain files, with a note.
        blocks = None
        try:
            if section.get("cards"):
                blocks, cards = card_days(section, root, today)
                if blocks:
                    loaded.extend(cards)
                    parts.append(f"*({len(blocks)} days, {len(cards)} cards, from the"
                                 f" database. Each line carries its card id.)*\n")
            elif section.get("source") == "database" and not section.get("files"):
                blocks = pages_from_database(section, root, max_chars)
        except Exception as e:  # never let a data fault cost the wake
            blocks = None
            parts.append(f"*(couldn't load this from the database: {e} — the files"
                         f" are below instead)*\n")
        if not blocks:
            blocks = [render_file(path, max_chars) for path in section_files(section, root)]
        parts.extend(blocks)
    # Coming up goes last: it's the part that changes every day.
    try:
        import comingup
        parts.append(comingup.format_block(today))
    except Exception as e:  # never let a data fault cost the wake
        parts.append(f"## Coming up\n\n*(couldn't build this section: {e})*\n")
    return "\n".join(parts), loaded


def build(today=None):
    """The whole package as one string."""
    return build_package(today)[0]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print the Keeper's boot package.")
    parser.add_argument("--date", help="pretend today is YYYY-MM-DD (for testing)")
    args = parser.parse_args(argv)
    today = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else None
    try:
        print(build(today))
    except Exception as e:
        # Last line of defence: say what broke, in the prompt, and exit clean
        # so the wake itself still happens.
        print(f"# Boot package\n\n*(the boot script failed: {e} — read your "
              f"boot files by hand this once)*")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
