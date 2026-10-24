#!/usr/bin/env python3
"""swarm_to_project_room.py — turn one big swarm into a project room, once.

Plain English: when a swarm has grown to "everything in a project", this
makes the project a project room instead (project_rooms.py), and keeps the
swarm's helper — its chat and the owner's standing rules — as the project's
helper. Prints what it will do; changes nothing without `--apply`.

    ./venv/bin/python3 scripts/swarm_to_project_room.py --swarm <id> --build <build id> \
        --helper <conv> [--apply]

In this order, so nothing in between mistakes the helper for an idle one:

  1. RE-ROLE the swarm's helper: role `project_helper`, its project room,
     title "Project helper · <name>", the swarm id kept as `former_swarm_id`.
     Its growing chat is reset (no `claude_session_id`, no `helper_grown_at`,
     as helper_chat.resumes expects), so its next turn starts from the new
     seed. Its rules file is copied to the project helper's path
     (helper_chat.rules_path). Done first: a swarm with no members archives
     a `swarm_helper` whose swarm is gone (swarms._archive_helpers), and
     this helper no longer is one.
  2. RELEASE every member of the swarm in one recorded move by the owner
     (room_helper.execute "release"), undoable with
     `scripts/room_moves.py undo <id>`. The emptied swarm row stays, with no
     members: no closing summary is written for it (swarms.retired is False
     for a swarm with no members).
  3. SWITCH the build on as a project room, and sync who's in it.

Touches: the session index, helper_chat.py (rules_path), room_helper.py
(execute), project_rooms.py (switch, sync), swarms.py.
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

if os.environ.get("EXOCORTEX_DATA_DIR"):
    store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])

import buildlist  # noqa: E402
import helper_chat  # noqa: E402
import project_rooms  # noqa: E402
import room_helper  # noqa: E402
import swarms  # noqa: E402


def plan(swarm_id, build_id, helper):
    """What would be done, as (lines to print, the re-roled entry, members),
    or raises SystemExit with the reason it can't be."""
    index = store.read("bot_chats/index", {})
    build = buildlist.find(build_id)
    entry = index.get(helper)
    if build is None:
        sys.exit(f"no build {build_id!r} on the Builds list")
    if not isinstance(entry, dict) or entry.get("role") != "swarm_helper" \
            or entry.get("swarm_id") != swarm_id:
        sys.exit(f"{helper} isn't swarm {swarm_id}'s helper")
    if not swarms.is_live(swarm_id):
        sys.exit(f"swarm {swarm_id} isn't live")
    members = sorted(swarms.overview_members(swarm_id))
    working = [m for m in members if not swarms.member_retired(index.get(m))]
    new = {**entry, "role": room_helper.PROJECT_ROLE, "project_room": build_id,
           "room": project_rooms.ROOM, "former_swarm_id": swarm_id,
           "title": f"Project helper · {build['name']}"}
    for field in ("swarm_id", "claude_session_id", "helper_grown_at", "helper_pending"):
        new.pop(field, None)
    old_rules, new_rules = helper_chat.rules_path(entry), helper_chat.rules_path(new)
    lines = [
        f"1. Re-role {helper} ({entry.get('title')}) → {new['title']}:"
        f" role project_helper, project room {build_id}, chat reset to a fresh seed.",
        f"   Rules: copy {old_rules} → {new_rules}"
        + ("" if old_rules.exists() else " (no rules file yet: nothing to copy)"),
        f"2. Release all {len(members)} members of swarm {swarm_id}"
        f" ({len(working)} still working) in one move by the owner, undoable:",
        *[f"     {m}  {(index.get(m) or {}).get('title') or m}" for m in working],
        f"   (+ {len(members) - len(working)} finished members)",
        f"3. Switch {build_id} ({build['name']}, {build['root']}) on as a project room,"
        f" then sync who's in it.",
    ]
    return lines, new, members, (old_rules, new_rules)


def apply(swarm_id, build_id, helper, new, members, rules):
    old_rules, new_rules = rules
    with store.mutate("bot_chats/index", {}) as index:
        index[helper] = new
    if old_rules.exists() and not new_rules.exists():
        new_rules.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old_rules, new_rules)
    move = room_helper.execute(
        project_rooms.ROOM, "release", members, None,
        f"swarm {swarm_id} becomes the {build_id} project room",
        f"Swarm {swarm_id} is now the {build_id} project room; its helper ({helper}) is the"
        " project's helper, and smaller swarms form inside it among the sessions that work"
        " together.", by="owner")
    project_rooms.switch(build_id, True)
    inside = project_rooms.members(build_id)
    print(f"done: move #{move['id']} (undo: scripts/room_moves.py undo {move['id']});"
          f" {len(inside)} sessions in the {build_id} project room now")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Turn a swarm into a project room.")
    parser.add_argument("--swarm", type=int, required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--helper", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    lines, new, members, rules = plan(args.swarm, args.build, args.helper)
    print("\n".join(lines))
    if not args.apply:
        print("\n(dry run — nothing changed; add --apply to do it)")
        return 0
    apply(args.swarm, args.build, args.helper, new, members, rules)
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), like the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
