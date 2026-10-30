"""Project rooms — a middle layer between the Coding room and its swarms.

**What this is, in plain English.** Some builds live in a repo of their own
(the Builds list, buildlist.py). When one is switched on as a PROJECT ROOM
(`"project_room": true` on its entry, set with `scripts/room_moves.py project
on <build id>`), every Coding session working on it gathers in one place
inside the Coding room, with its own helper — the project helper, a room
helper scoped to the project (room_helper.py, scope `coding:<build id>`).
Smaller swarms form inside the room among the sessions that actually work
together, as they do anywhere (swarms.py); the project helper looks after
those, and the Coding room helper sees the whole project as one block.

The app's own checkout and the vault are never a project: sessions working
there stay with the Coding room helper, as before.

HOW A SESSION LANDS IN ONE, first rule that applies:

  1. a placement by hand (`room_moves.py project-place <build id|none>
     <conv>…`) — its whole line of work moves;
  2. where it works: most of the places its tool calls point at are in the
     build's repo — the build's own folder or any git worktree of it. A
     place is an Edit/Write call's file, or the folder a Bash command starts
     with `cd` into. (Bash counts because most project sessions here edit
     through Bash; their cwd is the app checkout, so cwd says nothing.) A
     worktree is told by its `.git` FILE, which points into the build's
     `.git/worktrees/`, so the repo is the "common dir" both share;
  3. it was spun off or continued from a session already in the room, and
     works nowhere else. A continuation always stays in its parent's room
     ("they'd probably stay in the same room if they connected once").

Membership is stored (`project_room_members`), at most one room per session,
and only grows, like a swarm's: a session that later works elsewhere stays,
until it's placed by hand. `sync` refreshes it cheaply — a dry pass first, and
the write lock only when something is new, the same pattern as swarms.sync.
Rows of a room that is switched off count for nothing: its sessions are in no
room, and may land in another one by the rules.

WHO OPENS AND CLOSES A ROOM, AND WHO MOVES SESSIONS BETWEEN ROOMS is the room
helper's (room_helper.py: open_room, close_room, place, propose). This file
only keeps the rows and answers the questions those moves ask: `rows`,
`clear` and `restore` for what an undo puts back, `working_in` for how many
sessions already work in a folder, `build_at` and `main_checkout` for which
build a folder belongs to.

A SWARM'S PROJECT is the room most of its working members are in (swarm_room).

Touches: buildlist.py (which builds are switched on), sqlstore.py (the
`project_room_members` table), the `tool_calls` table (where sessions work),
swarms.py (line_of_work, member_retired, helpers), lanes.py, the session
index, room_helper.py and helper_chat.py (who reads and is woken for what),
scripts/room_moves.py (the switch and placements), tests/test_project_rooms.py.
Design: docs/swarms.md, "Project rooms".

Prompt that produced this: "maybe we make rooms where swarms can form like
based foods. Swarms could form within the room? based off the room helper?
Which can coordinate with the smaller swarm helpers."
"""
from collections import Counter
from datetime import datetime
from pathlib import Path
import re

import buildlist
import lanes
import sqlstore
import store
import swarms

# The room project rooms sit inside.
ROOM = "coding"

_EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
# A Bash command that starts by moving into a folder: `cd /path && …`.
_CD = re.compile(r"""^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))""")


def _now():
    return datetime.now().isoformat(timespec="seconds")


# --- Which rooms exist --------------------------------------------------------------

def rooms():
    """The switched-on project rooms: [{id, name, root}], in the Builds list's
    order."""
    return [{"id": b["id"], "name": b["name"], "root": b["root"]}
            for b in buildlist.builds() if b.get("project_room")]


def find(room_id):
    return next((r for r in rooms() if r["id"] == room_id), None)


def switch(build_id, on):
    """Switch a build's project room on or off. Raises ValueError for a build
    that isn't on the list."""
    if buildlist.find(build_id) is None:
        raise ValueError(f"no build {build_id!r} on the Builds list")
    buildlist.set_project_room(build_id, on)


# --- Which repo a path is in --------------------------------------------------------

_REPO_CACHE = {}


def repo_of(path):
    """The git repo a path is in, named by its common git dir (a worktree and
    its main checkout share one), or None outside any repo. Walks up from the
    nearest folder that exists; a worktree's `.git` is a file reading
    `gitdir: <main>/.git/worktrees/<name>`, whose `commondir` leads back to
    the main `.git`. Cached per folder: this is asked for every tool call."""
    folder = Path(path)
    while not folder.is_dir() and folder != folder.parent:
        folder = folder.parent
    key = str(folder)
    if key not in _REPO_CACHE:
        _REPO_CACHE[key] = _common_dir(folder)
    return _REPO_CACHE[key]


def _common_dir(folder):
    for here in (folder, *folder.parents):
        marker = here / ".git"
        if marker.is_dir():
            return str(marker.resolve())
        if marker.is_file():
            text = marker.read_text(errors="replace").strip()
            if not text.startswith("gitdir:"):
                return None
            gitdir = Path(text[len("gitdir:"):].strip())
            gitdir = gitdir if gitdir.is_absolute() else here / gitdir
            common = gitdir / "commondir"
            if common.is_file():
                return str((gitdir / common.read_text().strip()).resolve())
            return str(gitdir.resolve())
    return None


# --- Where a session works ----------------------------------------------------------

def _places(conn, convs):
    """{conv: Counter of repos its tool calls point at} — Edit/Write files and
    the folders Bash commands `cd` into. Calls outside any repo, and failed
    edits, aren't counted."""
    if not convs:
        return {}
    marks = ",".join("?" * len(convs))
    rows = conn.execute(
        f"SELECT conv, name, target, cwd, is_error FROM tool_calls WHERE conv IN ({marks})"
        f" AND name IN ({','.join('?' * (len(_EDIT_TOOLS) + 1))})",
        (*convs, *_EDIT_TOOLS, "Bash")).fetchall()
    found = {conv: Counter() for conv in convs}
    for conv, name, target, cwd, failed in rows:
        if not target:
            continue
        if name == "Bash":
            match = _CD.match(target)
            if not match:
                continue
            place = next(g for g in match.groups() if g)
        elif failed:
            continue
        else:
            place = target
        place = Path(place).expanduser()
        if not place.is_absolute():
            place = Path(cwd or store.BUILD_DIR) / place
        repo = repo_of(place)
        if repo:
            found[conv][repo] += 1
    return found


def _room_by_repo():
    """{repo (common git dir): project room id}, for the switched-on rooms."""
    out = {}
    for room in rooms():
        repo = repo_of(room["root"])
        if repo:
            out[repo] = room["id"]
    return out


def _by_files(counted, by_repo):
    """The room where most of these places are, or None."""
    total = sum(counted.values())
    if not total:
        return None
    repo, count = counted.most_common(1)[0]
    return by_repo.get(repo) if count * 2 > total else None


# --- Membership ---------------------------------------------------------------------

def stored(conn):
    """Every stored row, as {conv: (room id or None, how)}."""
    return {conv: (room_id, how) for conv, room_id, how in
            conn.execute("SELECT conv, room_id, how FROM project_room_members")}


def _candidates(index):
    """The sessions the rules are run for: Coding sessions, not helpers, still
    working."""
    return [conv for conv, entry in index.items()
            if isinstance(entry, dict) and lanes.derive_lane(entry) == ROOM
            and not swarms.is_helper_session(conv, index)
            and not swarms.member_retired(entry)]


class _WriteNeeded(Exception):
    """Raised by sync's dry pass the moment it finds something to write."""


def sync(index=None):
    """Bring the stored memberships up to date: every working Coding session
    with no row yet is run through the rules (see the top of the file), and
    lands in a room or stays out. Returns {conv: room id} for every session in
    a room. Cheap enough for every page read: one query over the tool calls of
    the sessions not yet placed, and no write lock unless one lands."""
    if index is None:
        index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    if not rooms():
        return {}
    conn = sqlstore.open_db()
    try:
        try:
            _assign(conn, index, dry=True)
        except _WriteNeeded:
            sqlstore.begin_immediate(conn)
            try:
                _assign(conn, index, dry=False)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        # Leave out rows of a room that is switched off: with another room still
        # on, they would hide those sessions from every helper.
        live = {r["id"] for r in rooms()}
        return {conv: room for conv, (room, _) in stored(conn).items() if room in live}
    finally:
        conn.close()


def _assign(conn, index, dry):
    have = stored(conn)
    live_rooms = {r["id"] for r in rooms()}
    # Run the rules for sessions with no row, and for those whose row is in a
    # room that is switched off. A hand placement out of every room (no room
    # on its row) stands.
    todo = [c for c in _candidates(index)
            if c not in have or (have[c][0] and have[c][0] not in live_rooms)]
    if not todo:
        return
    by_repo = _room_by_repo()
    places = _places(conn, sorted(todo))
    decided = {conv: (room if room in live_rooms else None) for conv, (room, _) in have.items()}

    def parent_room(conv):
        parent = (index.get(conv) or {}).get("spawned_from")
        if not parent:
            return None
        if parent in decided:
            return decided[parent]
        # A parent no longer working has no row: it's judged by its files now.
        found = _by_files(_places(conn, [parent]).get(parent, Counter()), by_repo)
        decided[parent] = found
        return found

    # Oldest first, so a parent is settled before the sessions it started.
    for conv in sorted(todo):
        entry = index.get(conv) or {}
        counted = places.get(conv, Counter())
        room, how = _by_files(counted, by_repo), "files"
        if room is None:
            inherited = parent_room(conv)
            if inherited in live_rooms:
                if entry.get("spawned_via") == "continue":
                    room, how = inherited, "continue"
                # A spinoff: only while it works nowhere outside the room.
                elif all(by_repo.get(repo) == inherited for repo in counted):
                    room, how = inherited, "spawn"
        decided[conv] = room
        if room is None:
            continue
        if dry:
            raise _WriteNeeded
        conn.execute("INSERT OR REPLACE INTO project_room_members (conv, room_id, joined_at,"
                     " how) VALUES (?, ?, ?, ?)", (conv, room, _now(), how))


def room_of(conv, members=None):
    """The project room this session is in, or None."""
    if members is None:
        members = sync()
    return members.get(conv)


def members(room_id, all_members=None):
    """Every session in this project room."""
    if all_members is None:
        all_members = sync()
    return sorted(conv for conv, room in all_members.items() if room == room_id)


def place(room_id, convs, by="cli"):
    """Put these sessions (with their whole lines of work) into a project room
    by hand, or out of every room (room_id None). A placement wins over the
    files from then on. Returns what each was before, as {conv: room id or
    None}. Raises ValueError for a room that isn't switched on."""
    if room_id is not None and find(room_id) is None:
        raise ValueError(f"{room_id!r} isn't a switched-on project room")
    index = store.read("bot_chats/index", {})
    moved = set()
    for conv in convs:
        if not isinstance(index.get(conv), dict):
            raise ValueError(f"no such session: {conv}")
        moved |= swarms.line_of_work(conv, index)
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        before = {conv: room for conv, (room, _) in stored(conn).items() if conv in moved}
        for conv in sorted(moved):
            conn.execute("INSERT OR REPLACE INTO project_room_members (conv, room_id,"
                         " joined_at, how) VALUES (?, ?, ?, 'hand')", (conv, room_id, _now()))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {conv: before.get(conv) for conv in sorted(moved)}


def rows(convs):
    """These sessions' stored rows, as {conv: [room id or None, joined_at, how]
    or None for no row} — what an undo puts back (restore)."""
    conn = sqlstore.open_db()
    try:
        found = {conv: [room, joined, how] for conv, room, joined, how in conn.execute(
            "SELECT conv, room_id, joined_at, how FROM project_room_members")}
    finally:
        conn.close()
    return {conv: found.get(conv) for conv in convs}


def _write(steps):
    """Run these (sql, params) under the write lock, all or nothing."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        for sql, params in steps:
            conn.execute(sql, params)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def restore(before):
    """Put stored rows back as `rows` returned them: a session that had no row
    loses its row, and is run through the rules again."""
    _write([("DELETE FROM project_room_members WHERE conv = ?", (conv,)) if row is None else
            ("INSERT OR REPLACE INTO project_room_members (conv, room_id, joined_at, how)"
             " VALUES (?, ?, ?, ?)", (conv, *row))
            for conv, row in before.items()])


def clear(room_id):
    """Delete every row of this room. Returns them, as `rows` does, so a move
    can keep them for its undo."""
    conn = sqlstore.open_db()
    try:
        kept = {conv: [room_id, joined, how] for conv, joined, how in conn.execute(
            "SELECT conv, joined_at, how FROM project_room_members WHERE room_id = ?", (room_id,))}
    finally:
        conn.close()
    _write([("DELETE FROM project_room_members WHERE room_id = ?", (room_id,))])
    return kept


def working_in(folder, index=None):
    """The working Coding sessions (not helpers, not retired) with most of
    their places in this folder's repo, whatever room they're in now."""
    repo = repo_of(folder)
    if not repo:
        return []
    if index is None:
        index = store.read("bot_chats/index", {})
    index = index if isinstance(index, dict) else {}
    convs = _candidates(index)
    conn = sqlstore.open_db()
    try:
        places = _places(conn, sorted(convs))
    finally:
        conn.close()
    return sorted(conv for conv in convs if _by_files(places.get(conv, Counter()), {repo: conv}))


def build_at(folder):
    """The build on the list whose repo this folder is in, or None."""
    repo = repo_of(folder)
    if not repo:
        return None
    return next((b for b in buildlist.builds() if repo_of(b["root"]) == repo), None)


def main_checkout(folder):
    """The main checkout of the repo this folder is in, so that opening a room
    from a worktree or a subfolder lists the repo itself. A folder in no repo
    comes back as it is (buildlist.add_folder refuses it)."""
    repo = repo_of(folder)
    return Path(repo).parent if repo and Path(repo).name == ".git" else Path(folder)


def swarm_room(member_convs, index, all_members=None):
    """The project room a swarm belongs to: the room most of its working
    members are in (all its members, when none is working), or None when
    most are in no room. Like swarms._majority_lane, for rooms."""
    if all_members is None:
        all_members = sync(index)
    working = [m for m in member_convs if not swarms.member_retired(index.get(m))
               and not swarms.is_helper_session(m, index)]
    counts = Counter(all_members.get(m) for m in (working or member_convs))
    return counts.most_common(1)[0][0] if counts else None
