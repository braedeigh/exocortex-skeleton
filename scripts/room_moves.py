#!/usr/bin/env python3
"""room_moves.py — the room helper's moves, listed, made by hand, and undone.

Plain English: the room helper (room_helper.py) forms, joins, splits and
releases swarms on its own, and posts each move in its chat with an undo
line. This is that undo, and the same four moves for when she (or the room
helper, from its chat) wants one made on purpose. Every move goes through
room_helper.execute, so it's recorded, told to the moved sessions, and
undoable like the helper's own.

    ./venv/bin/python3 scripts/room_moves.py list [--room coding]
    ./venv/bin/python3 scripts/room_moves.py undo <move id>
    ./venv/bin/python3 scripts/room_moves.py form <conv> <conv>... --reason "…" [--message "…"]
    ./venv/bin/python3 scripts/room_moves.py join <swarm id> <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py split <swarm id> <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py release <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py hubs
    ./venv/bin/python3 scripts/room_moves.py hub <conv> on|off|auto --reason "…"
    ./venv/bin/python3 scripts/room_moves.py project on|off <build id>
    ./venv/bin/python3 scripts/room_moves.py project-place <build id|none> <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py --room coding:<build id> form|join|… (a project helper's moves)

A session's continuations always move with it. `--by-owner` marks a move as
hers, which lets it redo a move she undid.

`hubs` lists the hubs: sessions in back-and-forth with so many others that
their messages link nobody into a swarm (swarms.hubs). `hub` overrides that
for one session's line of work: `on` always a hub, `off` never one, `auto`
back to the count. It isn't a room move, so there's no undo — set it back.

`project` switches a build (from the Builds list) on or off as a project room
inside the Coding room (project_rooms.py). `project-place` puts sessions, with
their continuations, into one by hand, or out of every one (`none`); it prints
where each was, which is how to put it back.

Touches: room_helper.py (execute, undo, recent_moves), swarms.py (hubs,
mark_hub), project_rooms.py (switch, place), exo.db (room_moves, swarm_hubs,
project_room_members).
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

if os.environ.get("EXOCORTEX_DATA_DIR"):
    store.DATA_DIR = Path(os.environ["EXOCORTEX_DATA_DIR"])

import room_helper  # noqa: E402
import project_rooms  # noqa: E402
import sqlstore  # noqa: E402
import swarms  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description="The room helper's moves.")
    parser.add_argument("--room", default="coding")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    undo = sub.add_parser("undo")
    undo.add_argument("move_id", type=int)
    for kind in room_helper.KINDS:
        move = sub.add_parser(kind)
        if kind in ("join", "split"):
            move.add_argument("swarm_id", type=int)
        move.add_argument("convs", nargs="+")
        move.add_argument("--reason", required=True)
        move.add_argument("--message", default="")
        move.add_argument("--by-owner", action="store_true")
    sub.add_parser("hubs")
    hub = sub.add_parser("hub")
    hub.add_argument("conv")
    hub.add_argument("state", choices=("on", "off", "auto"))
    hub.add_argument("--reason", required=True)
    hub.add_argument("--by-owner", action="store_true")
    project = sub.add_parser("project")
    project.add_argument("state", choices=("on", "off"))
    project.add_argument("build_id")
    project_place = sub.add_parser("project-place")
    project_place.add_argument("build_id")
    project_place.add_argument("convs", nargs="+")
    project_place.add_argument("--reason", required=True)
    args = parser.parse_args(argv)

    # Switch a project room on or off.
    if args.cmd == "project":
        try:
            project_rooms.switch(args.build_id, args.state == "on")
        except ValueError as e:
            print(f"not done: {e}", file=sys.stderr)
            return 1
        print(f"project room {args.build_id}: {args.state}")
        return 0
    # Place sessions into a project room, or out of every one, by hand.
    if args.cmd == "project-place":
        target = None if args.build_id == "none" else args.build_id
        try:
            before = project_rooms.place(target, args.convs)
        except ValueError as e:
            print(f"not done: {e}", file=sys.stderr)
            return 1
        for conv, was in before.items():
            print(f"{conv}: {was or 'no project room'} → {target or 'no project room'}")
        return 0

    # List the hubs, counted and hand-marked, and every hand mark.
    if args.cmd == "hubs":
        index = store.read("bot_chats/index", {})
        conn = sqlstore.open_db()
        try:
            found = swarms.hubs(conn, index)
            marks = swarms.hub_overrides(conn)
        finally:
            conn.close()
        for line, partners in sorted(found.items(), key=lambda kv: -kv[1]):
            title = (index.get(line) or {}).get("title") or line
            print(f"{line}  {title}  — in back-and-forth with {partners} other lines")
        for conv, is_hub in sorted(marks.items()):
            print(f"marked {'on' if is_hub else 'off'}: {conv}")
        if not found and not marks:
            print("no hubs")
        return 0
    # Set or clear one hand mark.
    if args.cmd == "hub":
        before = swarms.mark_hub(args.conv, args.state,
                                 by="owner" if args.by_owner else "cli", reason=args.reason)
        print(f"hub {args.conv}: {before} → {args.state}")
        return 0

    if args.cmd == "list":
        for move in room_helper.recent_moves(args.room, limit=50):
            target = (f"swarm {move['to_swarm']}" if move["to_swarm"] is not None
                      else "alone")
            undone = f"  [undone {move['undone_at']}]" if move["undone_at"] else ""
            print(f"#{move['id']}  {move['at']}  {move['kind']:<7} "
                  f"{', '.join(move['convs'])} → {target}{undone}\n    {move['reason']}")
        return 0
    try:
        if args.cmd == "undo":
            done = room_helper.undo(args.move_id)
            print(f"undid move #{done['id']}")
            return 0
        move = room_helper.execute(
            args.room, args.cmd, args.convs, getattr(args, "swarm_id", None), args.reason,
            args.message, by="owner" if args.by_owner else "cli")
    except room_helper.MoveError as e:
        print(f"not done: {e}", file=sys.stderr)
        return 1
    target = f"swarm {move['to_swarm']}" if move["to_swarm"] is not None else "working alone"
    print(f"move #{move['id']}: {move['kind']} {', '.join(move['convs'])} → {target}")
    # Say plainly when the move closed the swarm it left (room_helper.closed_line).
    if room_helper.closed_line(move):
        print(room_helper.closed_line(move))
    print(f"undo: ./venv/bin/python3 scripts/room_moves.py undo {move['id']}")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
