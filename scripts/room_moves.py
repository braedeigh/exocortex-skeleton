#!/usr/bin/env python3
"""room_moves.py — the room helper's moves, listed, made by hand, and undone.

Plain English: the room helper (room_helper.py) forms, joins, splits and
releases swarms on its own, and posts each move in its chat with an undo
line. This is that undo, and the same four moves for when she (or the room
helper, from its chat) wants one made on purpose. Every move goes through
room_helper, so it's recorded, told to the moved sessions, and undoable like
the helper's own. It is also the door to the project rooms above them: opening
and closing rooms, placing sessions in them, and the proposals the room helper
sends a project helper to approve or decline.

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
    ./venv/bin/python3 scripts/room_moves.py open <build id|folder> [--name "…"] --reason "…"
    ./venv/bin/python3 scripts/room_moves.py close <build id> --reason "…"
    ./venv/bin/python3 scripts/room_moves.py propose form|release <conv>... --reason "…" [--message "…"]
    ./venv/bin/python3 scripts/room_moves.py propose join|split <swarm id> <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py propose place <build id|none> <conv>... --reason "…"
    ./venv/bin/python3 scripts/room_moves.py propose close <build id> --reason "…"
    ./venv/bin/python3 scripts/room_moves.py proposals [--status open|approved|declined|lapsed]
    ./venv/bin/python3 scripts/room_moves.py --room coding:<build id> form|join|… (a project helper's moves)
    ./venv/bin/python3 scripts/room_moves.py --room coding:<build id> approve <n>
    ./venv/bin/python3 scripts/room_moves.py --room coding:<build id> decline <n> --reason "…"

A session's continuations always move with it. `--by-owner` marks a move as
hers, which lets it redo a move she undid, and skips the floor and the
proposal below.

`hubs` lists the hubs: sessions in back-and-forth with so many others that
their messages link nobody into a swarm (swarms.hubs). `hub` overrides that
for one session's line of work: `on` always a hub, `off` never one, `auto`
back to the count. It isn't a room move, so there's no undo — set it back.

`project` only flips a build's project-room switch (project_rooms.py), with no
record and no helper: `open` and `close` are the real moves. `open` adds a
folder to the Builds list if it isn't there, switches it on, makes its helper,
and is refused below config.PROJECT_ROOM_MIN_SESSIONS sessions already working
there.

Inside a project room the room helper proposes and that room's helper answers.
`propose` asks; so do `project-place` and `close`, which become a proposal
unless `--by-owner` says she asked. `approve` makes the move, like any other,
and `decline` sends the reason back up. `undo` works on all of them by move id.

Touches: room_helper.py (execute, undo, recent_moves, place, open_room,
close_room, propose, approve, decline), swarms.py (hubs, mark_hub),
project_rooms.py (switch), exo.db (room_moves, room_proposals, swarm_hubs,
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
    project_place.add_argument("--message", default="")
    project_place.add_argument("--by-owner", action="store_true")
    open_room = sub.add_parser("open")
    open_room.add_argument("where")
    open_room.add_argument("--name")
    open_room.add_argument("--reason", required=True)
    open_room.add_argument("--by-owner", action="store_true")
    close = sub.add_parser("close")
    close.add_argument("build_id")
    close.add_argument("--reason", required=True)
    close.add_argument("--by-owner", action="store_true")
    propose = sub.add_parser("propose")
    propose.add_argument("kind", choices=room_helper.PROPOSAL_KINDS)
    propose.add_argument("rest", nargs="+")
    propose.add_argument("--reason", required=True)
    propose.add_argument("--message", default="")
    propose.add_argument("--by-owner", action="store_true")
    listed = sub.add_parser("proposals")
    listed.add_argument("--status", default="open",
                        choices=("open", "approved", "declined", "lapsed"))
    approve = sub.add_parser("approve")
    approve.add_argument("number", type=int)
    approve.add_argument("--by-owner", action="store_true")
    decline = sub.add_parser("decline")
    decline.add_argument("number", type=int)
    decline.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    by = "owner" if getattr(args, "by_owner", False) else "cli"

    # Switch a project room on or off.
    if args.cmd == "project":
        try:
            project_rooms.switch(args.build_id, args.state == "on")
        except ValueError as e:
            print(f"not done: {e}", file=sys.stderr)
            return 1
        print(f"project room {args.build_id}: {args.state}")
        return 0
    # The moves about project rooms themselves, and the proposals.
    if args.cmd in ("project-place", "open", "close", "propose", "proposals", "approve", "decline"):
        try:
            return _project_move(args, by)
        except ValueError as e:
            print(f"not done: {e}", file=sys.stderr)
            return 1

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
            undone = f"  [undone {move['undone_at']}]" if move["undone_at"] else ""
            print(f"#{move['id']}  {move['at']}  {move['kind']:<7} "
                  f"{', '.join(move['convs'])} → {move['target']}{undone}\n    {move['reason']}")
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
    _print_move(move)
    return 0


def _print_move(move):
    target = move["target"] if move["to_swarm"] is None else f"swarm {move['to_swarm']}"
    print(f"move #{move['id']}: {move['kind']} {', '.join(move['convs'])} → {target}")
    # Say plainly when the move closed the swarm it left (room_helper.closed_line).
    if room_helper.closed_line(move):
        print(room_helper.closed_line(move))
    print(f"undo: ./venv/bin/python3 scripts/room_moves.py undo {move['id']}")


def _print_proposal(proposal):
    print(f"proposal {room_helper._proposal_words(proposal)}"
          f"\n  → {proposal['project']}'s helper, {proposal['status']}"
          + (f": {proposal['answer_reason']}" if proposal["answer_reason"] else ""))


def _target(word):
    """A room named on the command line: `none` is out of every room."""
    return None if word == "none" else word


def _project_move(args, by):
    """The project-room moves and proposals. A placement or a close the owner
    didn't ask for goes to that room's helper as a proposal. Only the helper
    above the rooms asks: a project helper reports up instead (its runs' `up`,
    or peers.py). Raises ValueError (room_helper.MoveError is one)."""
    if args.cmd == "proposals":
        for proposal in room_helper.proposals(room_helper._scope(args.room)[1], args.status):
            _print_proposal(proposal)
        return 0
    if args.cmd == "approve":
        _print_move(room_helper.approve(args.room, args.number, by=by))
        return 0
    if args.cmd == "decline":
        room_helper.decline(args.room, args.number, args.reason)
        print(f"declined proposal #{args.number}; the room helper has your reason")
        return 0
    if room_helper._scope(args.room)[1] is not None and by != "owner":
        raise ValueError(f"`{args.cmd}` is the room helper's; tell it what you need with peers.py")
    if args.cmd == "open":
        _print_move(room_helper.open_room(args.where, args.name, args.reason, by=by))
        return 0
    if args.cmd == "project-place":
        kind, rest = "place", [args.build_id, *args.convs]
    elif args.cmd == "close":
        kind, rest = "close", [args.build_id]
    else:
        kind, rest = args.kind, args.rest
    # Read each kind's arguments the way its direct command takes them.
    swarm_id, target, convs = None, None, rest
    if kind in ("join", "split"):
        swarm_id, convs = int(rest[0]), rest[1:]
    elif kind == "place":
        target, convs = _target(rest[0]), rest[1:]
    elif kind == "close":
        target, convs = rest[0], []
    filed = room_helper.propose(kind, convs, swarm_id, target, args.reason,
                                getattr(args, "message", ""), by=by)
    if "move" in filed:
        _print_move(filed["move"])
    else:
        _print_proposal(filed["proposal"])
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
