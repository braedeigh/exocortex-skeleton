#!/usr/bin/env python3
"""Check, stamp and help write the Map room's box files (codemap.py).

Plain English: every map on Terrain's Map room is a folder of small markdown
files, one per box. This is the door a session (or the nightly cron) uses on
them:

    venv/bin/python3 scripts/codemap.py list                  # every map, with its counts
    venv/bin/python3 scripts/codemap.py check [map]           # what's stale, broken or malformed
    venv/bin/python3 scripts/codemap.py check --devnote       # same, and post it as a [map] dev note
    venv/bin/python3 scripts/codemap.py imports <map>         # box-to-box imports found in the code
    venv/bin/python3 scripts/codemap.py stamp <map> [box ...] # "these boxes' words match their files now"

A map is named `<repo>/<name>`, e.g. `skeleton/observatory`. `check` exits 1
when any box is broken (a source file gone) — stale alone is normal life and
exits 0. `imports` marks with `·` each import that no link in the map covers
yet, which is where a missing "depends-on" usually hides.

The procedure for rewriting a stale box is in docs/codemap.md.

Prompt that produced this file: "A check that every box's source files still
exist, and a box is flagged stale when its source files changed after its
description was written. A nightly cron that re-checks is welcome; rewriting
stale boxes can be a script a session runs."
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import codemap  # noqa: E402  (sys.path above)

DEVNOTE_TAB = "terrain"
DEVNOTE_PREFIX = "[map] "


def _pick(key):
    """The maps a command runs on: the named one, or all of them."""
    maps = codemap.find_maps()
    if key is None:
        return maps
    chosen = [found for found in maps if found["key"] == key]
    if not chosen:
        print(f"no map '{key}' — one of: {', '.join(m['key'] for m in maps) or '(none)'}",
              file=sys.stderr)
    return chosen


def cmd_list(_args):
    for found in codemap.find_maps():
        counts = codemap.summary(codemap.load(found))
        print(f"{counts['key']:32} {counts['boxes']:3} boxes  {counts['stale']:3} stale  "
              f"{counts['broken']:3} broken  {counts['problems']:3} problems")
    return 0


def check_lines(loaded):
    """What's wrong with one map, one line each — empty when all is well."""
    lines = [f"{loaded['key']}: {problem}" for problem in loaded["problems"]]
    for box in loaded["boxes"]:
        gone = [s["path"] for s in box["sources"] if not s["exists"]]
        if gone:
            lines.append(f"{loaded['key']} {box['id']}: BROKEN — gone: {', '.join(gone)}")
        elif box["stale"]:
            lines.append(f"{loaded['key']} {box['id']}: stale — its files changed since {box['written'] or 'it was written'}")
        for problem in box["problems"]:
            lines.append(f"{loaded['key']} {box['id']}: {problem}")
    return lines


def cmd_check(args):
    chosen = _pick(args.map)
    if args.map and not chosen:
        return 2
    lines, broken, stale = [], 0, 0
    for found in chosen:
        loaded = codemap.load(found)
        lines += check_lines(loaded)
        broken += sum(1 for box in loaded["boxes"] if box["broken"])
        stale += sum(1 for box in loaded["boxes"] if box["stale"])
    print("\n".join(lines) if lines else "every box matches its files")
    if args.devnote:
        _post_devnote(stale, broken, len(lines))
    return 1 if broken else 0


def _post_devnote(stale, broken, total):
    """Write/replace the one '[map] …' note on the terrain tab — same
    replace-not-append mechanics as usage_doctor's _post_devnote. A clean check
    takes the note down rather than leaving an old warning up."""
    from routes.devnotes import load_dev_notes, save_dev_notes, _new_note

    notes = load_dev_notes()
    tab_notes = notes.setdefault("tabs", {}).setdefault(DEVNOTE_TAB, [])
    tab_notes[:] = [n for n in tab_notes if not str(n.get("text", "")).startswith(DEVNOTE_PREFIX)]
    if total:
        tab_notes.append(_new_note(
            f"{DEVNOTE_PREFIX}Map room: {stale} stale box(es), {broken} broken, {total} finding(s) in all. "
            "Run scripts/codemap.py check to see them; docs/codemap.md says how to rewrite one."))
    save_dev_notes(notes)


def cmd_imports(args):
    chosen = _pick(args.map)
    if not chosen:
        return 2
    loaded = codemap.load(chosen[0])
    # An import is covered by any link between the two boxes or the boxes
    # inside them — an import through a package's index file lands on the
    # package box, while its link rightly names the part it reaches.
    parents = {box["id"]: box["parent"] for box in loaded["boxes"]}

    def within(box_id):
        chain = []
        while box_id and box_id not in chain:
            chain.append(box_id)
            box_id = parents.get(box_id)
        return chain

    linked = {(a, b) for box in loaded["boxes"] for link in box["links"]
              for a in within(box["id"]) for b in within(link["to"])}
    for frm, to, count in codemap.import_links(loaded, chosen[0]["root"]):
        mark = " " if (frm, to) in linked else "·"
        print(f"{mark} {frm:36} → {to:36} {count:4} import(s)")
    return 0


def cmd_stamp(args):
    chosen = _pick(args.map)
    if not chosen:
        return 2
    stamped = codemap.stamp(chosen[0], set(args.boxes) or None)
    print(f"stamped {len(stamped)} box(es)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check and stamp the Map room's box files.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    check = commands.add_parser("check")
    check.add_argument("map", nargs="?")
    check.add_argument("--devnote", action="store_true",
                       help="post (or clear) a [map] note on the terrain dev-note tab")
    imports = commands.add_parser("imports")
    imports.add_argument("map")
    stamp = commands.add_parser("stamp")
    stamp.add_argument("map")
    stamp.add_argument("boxes", nargs="*")
    args = parser.parse_args(argv)
    return {"list": cmd_list, "check": cmd_check, "imports": cmd_imports,
            "stamp": cmd_stamp}[args.command](args)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), from __main__ only.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
