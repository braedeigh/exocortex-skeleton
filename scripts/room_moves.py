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

A session's continuations always move with it. `--by-owner` marks a move as
hers, which lets it redo a move she undid.

Touches: room_helper.py (execute, undo, recent_moves), exo.db (room_moves).
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
    args = parser.parse_args(argv)

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
    print(f"move #{move['id']}: {move['kind']} {', '.join(move['convs'])} → {target}"
          f"\nundo: ./venv/bin/python3 scripts/room_moves.py undo {move['id']}")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
