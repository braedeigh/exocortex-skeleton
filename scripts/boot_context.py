#!/usr/bin/env python3
"""Assemble the Keeper's boot package — the files a new Keeper would otherwise
hunt for and read one by one — and print it as one markdown document.

**What this does, in plain English.** A Keeper wakes with no memory. It used
to be told "read these files" and then find them itself, which meant guessing
paths, skipping things, and hand-carrying upcoming dates from one Keeper's
diary to the next. This script reads the list of what to load from a small
manifest in the owner's data folder, gathers those files in a fixed order —
the standing rules first, then the recent journal, then a generated
**Coming up** section last — and prints the lot. `/journalstart` (and the 3 AM
rollover) put that output straight into the Keeper's first prompt.

The manifest is `keeper_boot.json` in the data dir. Its shape:

    {"root": "../content",            # optional; where paths start (relative
                                      #   to the data dir). Default: CONTENT_DIR
     "sections": [
       {"title": "How to be", "files": ["CLAUDE.md", "PROTOCOLS.md"]},
       {"title": "Recent days", "dir": "Journal/Daily", "glob": "*.md",
        "last": 7, "max_chars": 20000},
       {"title": "Sunday", "files": ["SUNDAY.md"], "weekday": "sunday"}
     ]}

No manifest → a default list that matches a fresh install's content scaffold,
so the skeleton works out of the box and carries nothing personal.

It never crashes a wake: a missing file, an unreadable manifest, or any other
fault becomes a plain note inside the output, not an error.

Touches: `store.py` (DATA_DIR / CONTENT_DIR), `comingup.py` (the Coming up
block), `claude-commands/journalstart.md` and `scripts/keeper_rollover.py`
(its two callers), `tests/test_boot_context.py`.

Prompt that produced this: "instead of asking Claude to find and read the
files, I automatically inject them into the prompt from my records, either
from the sql or the markdown." / "Tell the keeper they can read more stuff
beyond the boundary of the injection."
"""
import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

MANIFEST_NAME = "keeper_boot.json"
DEFAULT_MAX_CHARS = 40000
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday",
            "saturday", "sunday")

# The fresh-install list: what the content scaffold's seed keeper reads.
DEFAULT_MANIFEST = {
    "sections": [
        {"title": "How to be", "files": ["CLAUDE.md"]},
        {"title": "Recent days", "dir": "Journal/Daily", "glob": "*.md", "last": 5},
        {"title": "Recent weeks", "dir": "Journal/Weekly", "glob": "*.md", "last": 2},
        {"title": "Your last diary entries", "dir": "keeper-diary", "glob": "[0-9]*.md", "last": 2},
    ],
}

HEADER = """# Boot package

Injected {stamp}. Everything below has already been read for you — don't
re-read these files at wake. **This is your starting point, not your
boundary:** read anything else you need, whenever the moment calls for it —
other days, threads, people, the owner's data files. The section list comes
from `{manifest}`.
"""


def _natural_key(path):
    """Sort names the way a person would: '99-x' before '205-y', and dates in
    date order. Digit runs compare as numbers, everything else as text."""
    return [int(part) if part.isdigit() else part
            for part in re.split(r"(\d+)", path.name)]


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


def render_file(path, max_chars):
    """One file as a headed block, cut at max_chars with a note saying where
    the rest is."""
    if not path.is_file():
        return f"### {path}\n\n*(missing — nothing at this path)*\n"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return f"### {path}\n\n*(unreadable: {e})*\n"
    if len(text) > max_chars:
        text = (text[:max_chars]
                + f"\n\n*(cut at {max_chars:,} characters — Read {path} for the rest)*")
    return f"### {path}\n\n{text.rstrip()}\n"


def build(today=None):
    """The whole package as one string."""
    today = today or date.today()
    manifest, source = load_manifest()
    root = content_root(manifest)
    parts = [HEADER.format(stamp=datetime.now().strftime("%A %Y-%m-%d %H:%M"),
                           manifest=source)]
    weekday = WEEKDAYS[today.weekday()]
    for section in manifest["sections"]:
        if not isinstance(section, dict):
            continue
        only_on = section.get("weekday")
        if only_on and str(only_on).lower() != weekday:
            continue
        max_chars = section.get("max_chars") or DEFAULT_MAX_CHARS
        parts.append(f"## {section.get('title') or 'Files'}\n")
        for path in section_files(section, root):
            parts.append(render_file(path, max_chars))
    # Coming up goes last: it's the part that changes every day.
    try:
        import comingup
        parts.append(comingup.format_block(today))
    except Exception as e:  # never let a data fault cost the wake
        parts.append(f"## Coming up\n\n*(couldn't build this section: {e})*\n")
    return "\n".join(parts)


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
