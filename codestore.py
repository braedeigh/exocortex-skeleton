"""The codebase's own history as real rows — the third typed entity in exo.db.

**The problem this solves.** The system's code history lived in two places
nothing could query: git (which knows every commit but only answers through
subprocess calls — routes/terrain.py shells out to `git log` on every map
load, with a 90-day window and a per-file touch cap to keep that bearable),
and `bot_chats/footprints.json` (which knows which agent session touched
which file, but as a JSON sidecar keyed by absolute path — not joinable
against anything). Questions like "which files did I touch the week X
happened", "what changes together", or "which session wrote this file" were
either subprocess archaeology or impossible.

This module walks both repos' full git history, plus the session sidecars,
into six tables (see the v5 rung in sqlstore.py): `files` / `file_paths`
(identity that survives renames — habit_aliases' lesson applied to paths),
`commits`, `commit_files` (the join table "what changed together" lives on),
and `sessions` / `session_files` (the footprints harvest, made joinable).

**Git and the sidecars stay the source of truth and are never written here.**
Everything is derived and re-derivable:

  - `rebuild()` — wipe and re-walk everything. The undo button, wired to
    POST /api/sql/rebuild alongside habits and expenses.
  - `update()` — incremental: index only commits the tables don't have yet.
    Terrain runs it on every cache miss, so the map is never staler than its
    own cache; it reads git before taking the write lock, and takes the lock
    only when there's something new. This is the one place
    this entity deviates from habitstore/expensestore's rebuild-only shape:
    git history only grows, and a full re-walk on every map load is the
    exact cost the old `git log` path already paid and this store exists to
    retire.
  - `sync_sessions()` — full re-derive of the two session tables from
    bot_chats/index.json + gists.json + footprints.json (small, so no
    incremental variant is needed).
  - `sync_turns()` — full re-derive of `session_turns`: when she actually
    SENT a message to an agent, read straight out of the conversation
    transcripts. The sidecars don't carry this (footprints.json records
    files, index.json records only a session's first and last moment), so
    this is the one place that opens the jsonl logs itself. ~300 MB across
    ~150 files, scanned in under two seconds by skipping any line that can't
    contain a timestamp before parsing it.

Everything gets indexed — both repos, full history, machine-churn commits
included. Filtering (Terrain's denylist, the hourly "auto backup" noise) is
a DISPLAY decision made by whoever queries; the tables stay complete so a
future visualization isn't stuck with one page's taste.

Touches: `sqlstore.py` (owns the schema + connection factory), `store.py`
(BUILD_DIR / CONTENT_DIR for the default repo roots, and the bot_chats
sidecars), `buildlist.py` (the owner's other git folders, indexed here under
their own ids and reported by `commit_log` / `repo_summary`), `routes/terrain.py` (reads `touches()` instead of running git),
`routes/sqlab.py` (rebuild button + table list), and
`scripts/update_code_history.py` (the hourly cron wrapper).

Prompt that produced this file: "make the codebase itself SQL backed — when
it was edited, information about associated files… Terrain will be built off
of this; I want to build more UI like terrain and make visualizations of my
entire codebase/file system as it grows."
"""
from datetime import datetime
from pathlib import Path
import json
import os
import subprocess

import buildlist
import config
import lanes
import sqlstore
import store

# One marker line per commit in the git log output; \x01 can't appear in the
# tab-separated fields that follow (same trick routes/terrain.py used).
_MARKER = "\x01"

_GIT_TIMEOUT = 60


def default_repos():
    """The two repos this system is made of, in the terrain payload's own ids:
    the skeleton checkout (the app code) and the vault (her data + content).
    Same roots routes/observatory._terrain_repos resolves — kept independent
    so this module never imports the routes layer.

    The desktop app has neither: its one folder is a build (buildlist.py), so
    there this is empty and history_repos() is the builds alone."""
    if config.standalone():
        return ()
    return (
        {"id": "skeleton", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "root": Path(store.CONTENT_DIR).parent},
    )


def history_repos():
    """Every repo whose history these tables keep: the two this system is made
    of, plus the owner's builds (buildlist.py) — other git folders she reads on
    Terrain, each under its own id. This is what update(), rebuild() and
    sync_sessions() walk when they aren't handed a list.

    Kept apart from default_repos() on purpose. The code graph and the tracer
    also start from that pair, and they describe THIS app: a build is somebody
    else's code, with history worth keeping and nothing to wire into the
    app's own import graph."""
    return (*default_repos(), *buildlist.repos())


# --- reading git --------------------------------------------------------------

def _git(root, *args):
    """Run one git command, or None on any failure — a missing binary, a root
    that isn't a repo, a timeout. Code history is derived data; failing to
    read it must degrade to 'nothing new', never to an exception a page sees."""
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(root),
            capture_output=True, text=True, timeout=_GIT_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def _rev_list(root):
    """Every sha reachable from HEAD, newest first. None if the root isn't a
    repo (or has no commits yet)."""
    out = _git(root, "rev-list", "HEAD")
    if out is None:
        return None
    return [line for line in out.splitlines() if line]


def _log_over(root, shas, *diff_args):
    """One `git log` pass over exactly `shas`, in the order given, parsed into
    [(sha, epoch, author, subject, [diff lines])]. `--no-walk=unsorted` shows
    precisely the commits fed on stdin, in stdin order — which lets the caller
    hand us oldest-first so history applies chronologically."""
    if not shas:
        return []
    try:
        proc = subprocess.run(
            ["git", "log", "--no-walk=unsorted", "--stdin", "-M",
             f"--pretty=format:{_MARKER}%H{_MARKER}%ct{_MARKER}%an{_MARKER}%s",
             *diff_args],
            cwd=str(root), input="\n".join(shas) + "\n",
            capture_output=True, text=True, timeout=_GIT_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    commits = []
    for line in proc.stdout.splitlines():
        if line.startswith(_MARKER):
            parts = line.split(_MARKER)
            # ['', sha, epoch, author, subject] — subject may be empty.
            if len(parts) >= 5:
                try:
                    epoch = int(parts[2])
                except ValueError:
                    continue
                commits.append((parts[1], epoch, parts[3], _MARKER.join(parts[4:]), []))
        elif line.strip() and commits:
            commits[-1][4].append(line)
    return commits


def _parse_name_status(lines):
    """Diff lines from --name-status into [(status_letter, path, old_path)].
    Renames/copies arrive as 'R100\told\tnew' — old_path carries the origin;
    everything else is 'M\tpath' with old_path None."""
    out = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0][:1]
        if status in ("R", "C") and len(parts) >= 3:
            out.append((status, parts[2], parts[1]))
        else:
            out.append((status, parts[1], None))
    return out


def _expand_rename(path):
    """A --numstat rename path back into the NEW path. Git compresses renames
    two ways: 'old => new' whole-path, or 'prefix/{old => new}/suffix' with the
    unchanged parts factored out of the braces."""
    if "{" in path and "}" in path:
        head, _, rest = path.partition("{")
        inner, _, tail = rest.partition("}")
        if " => " in inner:
            _, _, new = inner.partition(" => ")
            return (head + new + tail).replace("//", "/")
    if " => " in path:
        return path.partition(" => ")[2]
    return path


def _parse_numstat(lines):
    """Diff lines from --numstat into {new_path: (added, removed)}. Binary
    files show '-' for both counts — stored as None, which is 'uncountable',
    not zero."""
    out = {}
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added = None if parts[0] == "-" else _int_or_none(parts[0])
        removed = None if parts[1] == "-" else _int_or_none(parts[1])
        out[_expand_rename("\t".join(parts[2:]))] = (added, removed)
    return out


def _int_or_none(raw):
    try:
        return int(raw)
    except ValueError:
        return None


def _iso(epoch):
    """Epoch → local ISO text, the clock the rest of this system keeps (journal
    days, habit dates are all local)."""
    return datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


# --- writing the git tables ---------------------------------------------------

def _live_paths(conn, repo_id):
    """{current path: file_id} for every file alive in this repo — the walk's
    working map of who owns which path right now."""
    return dict(conn.execute(
        "SELECT path, id FROM files WHERE repo = ? AND deleted_at IS NULL",
        (repo_id,),
    ).fetchall())


def _file_row(conn, repo_id, path, live, seen_at=None, revive=True):
    """The file_id that owns `path` right now, minting a row if none does.

    Resurrection rule: if the path's most recent owner (file_paths) still
    wears this path and is merely deleted, it comes back as the same row —
    a file deleted and restored is one file, not two. A row whose current
    path has moved on (renamed away) is NOT resurrected; the path gets a
    fresh row and file_paths repoints to the new occupant.

    `revive=False` finds that deleted row and hands it back STILL deleted.
    The sessions sync asks for this: a session having once read a file is
    not the file coming back.
    """
    fid = live.get(path)
    if fid is not None:
        return fid
    row = conn.execute(
        "SELECT f.id FROM file_paths p JOIN files f ON f.id = p.file_id"
        " WHERE p.repo = ? AND p.path = ? AND f.path = ?",
        (repo_id, path, path),
    ).fetchone()
    if row is not None and not revive:
        return row[0]
    if row is not None:
        fid = row[0]
        conn.execute("UPDATE files SET deleted_at = NULL WHERE id = ?", (fid,))
    else:
        cur = conn.execute(
            "INSERT INTO files (repo, path, first_seen) VALUES (?, ?, ?)",
            (repo_id, path, seen_at),
        )
        fid = cur.lastrowid
    _claim_path(conn, repo_id, path, fid)
    live[path] = fid
    return fid


def _claim_path(conn, repo_id, path, fid):
    """file_paths maps a path to its MOST RECENT owner — history keeps every
    path a file ever wore, but a reused path belongs to the newcomer."""
    conn.execute(
        "INSERT INTO file_paths (repo, path, file_id) VALUES (?, ?, ?)"
        " ON CONFLICT (repo, path) DO UPDATE SET file_id = excluded.file_id",
        (repo_id, path, fid),
    )


def _apply_commits(conn, repo_id, structure, counts_by_sha):
    """Walk parsed commits (oldest first) into the tables. `structure` is the
    --name-status pass; `counts_by_sha` the --numstat line counts keyed by sha
    then new-path."""
    live = _live_paths(conn, repo_id)
    n = 0
    for sha, epoch, author, subject, diff_lines in structure:
        when = _iso(epoch)
        conn.execute(
            "INSERT INTO commits (sha, repo, authored_ts, authored_at, author, subject)"
            " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha) DO NOTHING",
            (sha, repo_id, epoch, when, author, subject),
        )
        counts = counts_by_sha.get(sha, {})
        for status, path, old_path in _parse_name_status(diff_lines):
            if status == "R":
                # The file keeps its row through a rename — path is an
                # attribute, not identity. The old path stays in file_paths
                # (so history written under it still resolves) but leaves the
                # live map: a later file created there is a different file.
                fid = live.pop(old_path, None)
                if fid is not None:
                    conn.execute("UPDATE files SET path = ? WHERE id = ?", (path, fid))
                    _claim_path(conn, repo_id, path, fid)
                    live[path] = fid
                else:
                    fid = _file_row(conn, repo_id, path, live, seen_at=when)
            else:
                fid = _file_row(conn, repo_id, path, live, seen_at=when)
            if status == "D":
                conn.execute(
                    "UPDATE files SET deleted_at = ? WHERE id = ?", (when, fid))
                live.pop(path, None)
            added, removed = counts.get(path, (None, None))
            conn.execute(
                "INSERT INTO commit_files (sha, file_id, status, added, removed)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT (sha, file_id) DO UPDATE SET"
                "   status = excluded.status, added = excluded.added,"
                "   removed = excluded.removed",
                (sha, fid, status, added, removed),
            )
            conn.execute(
                "UPDATE files SET"
                "  first_seen = MIN(COALESCE(first_seen, ?), ?),"
                "  last_seen  = MAX(COALESCE(last_seen,  ?), ?)"
                " WHERE id = ?",
                (when, when, when, when, fid),
            )
        n += 1
    return n


def _read_new(conn, repo_id, root):
    """Read from git every commit the tables don't have yet, oldest first, as
    (structure, counts) ready for _apply_commits — or None when there's
    nothing new. Reads only: it takes no write lock, so a caller can run the
    slow part (the git subprocesses) before asking for one. Incremental by sha
    set: whatever `git rev-list HEAD` reports that the commits table doesn't
    have. On a fresh database that's everything, so 'full build' and 'catch
    up' are the same program. Commits that fell out of history (a rebase)
    simply stop being reachable — they stay in the tables until the next
    rebuild() sweeps them."""
    shas = _rev_list(root)
    if shas is None:
        return None
    stored = {r[0] for r in conn.execute(
        "SELECT sha FROM commits WHERE repo = ?", (repo_id,))}
    missing = [s for s in shas if s not in stored]
    if not missing:
        return None
    missing.reverse()   # rev-list is newest-first; history applies oldest-first
    structure = _log_over(root, missing, "--name-status")
    counts = {sha: _parse_numstat(lines)
              for sha, _, _, _, lines in _log_over(root, missing, "--numstat")}
    # Chronological order: rev-list order is topological-newest-first, so the
    # reversed list is already oldest-first; sort by timestamp as a belt for
    # histories whose topology and clocks disagree.
    structure.sort(key=lambda c: c[1])
    return structure, counts


def _index_repo(conn, repo_id, root):
    """Bring one repo's tables up to its current HEAD, in one go — for a
    caller that already holds the write lock (rebuild)."""
    found = _read_new(conn, repo_id, root)
    return _apply_commits(conn, repo_id, *found) if found else 0


# --- the public entry points --------------------------------------------------

def update(repos=None):
    """Catch the git tables up to every repo's HEAD — both of this system's
    and each build's (history_repos), unless handed a list. Returns
    {repo_id: commits_indexed}.

    Git is read first, with no lock held; the write lock is taken only when
    there's something new, and only for the inserts. Terrain runs this on
    every cache miss — every few seconds while a session is running — and
    `git rev-list` takes most of a second on these repos even when nothing
    is new. Holding the write lock across that starved every other writer in
    the app into "database is locked"; now the usual case, nothing new,
    never asks for the lock at all.

    Reading outside the lock means another update can land the same commits
    in between, so the new ones are filtered once more under the lock before
    anything is applied — applying one twice would double its line counts."""
    repos = history_repos() if repos is None else repos
    conn = sqlstore.open_db()
    try:
        found = {repo["id"]: _read_new(conn, repo["id"], repo["root"]) for repo in repos}
        out = {repo_id: 0 for repo_id in found}
        if not any(found.values()):
            return out
        sqlstore.begin_immediate(conn)
        try:
            for repo_id, pending in found.items():
                if not pending:
                    continue
                structure, counts = pending
                stored = {r[0] for r in conn.execute(
                    "SELECT sha FROM commits WHERE repo = ?", (repo_id,))}
                structure = [c for c in structure if c[0] not in stored]
                out[repo_id] = _apply_commits(conn, repo_id, structure, counts)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return out


def rebuild(repos=None):
    """Wipe and re-derive everything — git tables and session tables both.
    The undo button, and the self-heal for anything an incremental walk got
    wrong (a rebase, a hand-poked row). Nothing here can hurt the sources:
    git and the sidecars are only ever read."""
    repos = history_repos() if repos is None else repos
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        # Children first, same reasoning as expensestore.
        conn.execute("DELETE FROM session_files")
        conn.execute("DELETE FROM sessions")
        conn.execute("DELETE FROM commit_files")
        conn.execute("DELETE FROM commits")
        conn.execute("DELETE FROM file_paths")
        conn.execute("DELETE FROM files")
        commits = 0
        for repo in repos:
            commits += _index_repo(conn, repo["id"], repo["root"])
        sessions, turns = _sync_sessions(conn, repos)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    files = _count("files")
    return {"commits": commits, "files": files, "sessions": sessions,
            "turns": turns}


def sync_sessions(repos=None):
    """Re-derive sessions + session_files + session_turns from the bot_chats
    sidecars and transcripts. Full rewrite every run — the corpus is ~a
    thousand rows, and the sidecars are themselves rebuilt wholesale by their
    own cron, so mirroring that shape keeps the rebuilds impossible to
    half-align.

    Turns come along for the ride rather than getting their own door here,
    because this function DELETES every `sessions` row and re-inserts it: any
    child row that didn't follow would be orphaned by construction. Returns
    {"files": n, "turns": n}."""
    repos = history_repos() if repos is None else repos
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        n, turns = _sync_sessions(conn, repos)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {"files": n, "turns": turns}


def sync_turns():
    """Re-derive `session_turns` alone — when she was at the keyboard talking
    to an agent.

    Split out from the sessions sync because it moves on a different clock:
    the sidecars are rebuilt hourly by their own crons, but a transcript grows
    every time she hits send. Safe on its own (it only ever touches this one
    table, and existing `sessions` rows are what it hangs off), so a caller
    that wants a fresh answer without re-walking the footprints can have one.
    Returns the row count."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        n = _sync_turns(conn)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return n


def _bury_deleted(conn, roots):
    """Mark deleted again any file whose newest commit deleted it and which
    is not on disk. This is the repair for rows an earlier sessions sync
    revived by mistake (a footprint on a file that no longer exists): the
    commit that removed it is still in commit_files, so its time is put back.
    A file that is on disk is left alone — it was recreated and not yet
    committed."""
    for repo_id, root in roots:
        rows = conn.execute(
            "SELECT f.id, f.path, c.authored_at, cf.status FROM files f"
            " JOIN commit_files cf ON cf.file_id = f.id"
            " JOIN commits c ON c.sha = cf.sha"
            " WHERE f.repo = ? AND f.deleted_at IS NULL"
            " ORDER BY c.authored_ts", (repo_id,)).fetchall()
        newest = {fid: (path, when, status) for fid, path, when, status in rows}
        for fid, (path, when, status) in newest.items():
            if status == "D" and not os.path.exists(os.path.join(root, path)):
                conn.execute(
                    "UPDATE files SET deleted_at = ? WHERE id = ?", (when, fid))


def _bury_vanished(conn, roots):
    """Mark deleted any file git never saw that is not on disk. Such a row
    exists only because a session touched the path (work written and then
    moved or removed before any commit caught it), so no commit can say when
    it went: the time used is the last session touch on record, or now. A
    file that is on disk is left alone."""
    for repo_id, root in roots:
        rows = conn.execute(
            "SELECT f.id, f.path, (SELECT MAX(sf.last) FROM session_files sf"
            "                      WHERE sf.file_id = f.id) FROM files f"
            " WHERE f.repo = ? AND f.deleted_at IS NULL AND NOT EXISTS"
            "   (SELECT 1 FROM commit_files cf WHERE cf.file_id = f.id)",
            (repo_id,)).fetchall()
        now = datetime.now().isoformat(timespec="seconds")
        for fid, path, last_touch in rows:
            if not os.path.exists(os.path.join(root, path)):
                conn.execute("UPDATE files SET deleted_at = ? WHERE id = ?",
                             (last_touch or now, fid))


def _sync_sessions(conn, repos):
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        index = {}
    gists = store.read("bot_chats/gists", {})
    if not isinstance(gists, dict):
        gists = {}
    footprints = store.read("bot_chats/footprints", {})
    if not isinstance(footprints, dict):
        footprints = {}

    conn.execute("DELETE FROM session_turns")
    conn.execute("DELETE FROM session_files")
    conn.execute("DELETE FROM sessions")

    # Every conversation the index knows, footprint or not — a session that
    # touched nothing still happened, and date-joins against the journal
    # want it here.
    conv_ids = set(index) | set(footprints)
    for cid in sorted(conv_ids):
        meta = index.get(cid) if isinstance(index.get(cid), dict) else {}
        gist = gists.get(cid) if isinstance(gists.get(cid), dict) else {}
        title = gist.get("title") or meta.get("title") or ""
        # The room and the Keeper flag are DERIVED here with the app's own
        # rule (lanes.py), so a session that never stored a lane still lands
        # in the right one instead of a blank — and "keeper" means a real
        # journaling session, not the leftover `bot` label every session has.
        # A footprint-only session (no index entry) has nothing to derive
        # from, so it stays blank rather than guessed.
        lane = lanes.derive_lane(meta) if meta else None
        conn.execute(
            "INSERT INTO sessions (id, title, bot, lane, is_keeper, started, last_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cid, title, meta.get("bot"), lane, 1 if lanes.is_keeper(meta) else 0,
             meta.get("started"), meta.get("last_at")),
        )

    # Footprint paths are absolute; map each under whichever repo root holds
    # it (same relpath dance routes/terrain.py does) and skip the rest — a
    # session reading /etc/hosts is not part of either codebase's story.
    roots = [(r["id"], str(Path(r["root"]))) for r in repos]
    _bury_deleted(conn, roots)
    live_by_repo = {rid: _live_paths(conn, rid) for rid, _ in roots}
    n = 0
    for cid, conv in footprints.items():
        conv_files = conv.get("files") if isinstance(conv, dict) else None
        if not isinstance(conv_files, dict):
            continue
        for abspath, counts in conv_files.items():
            if not isinstance(counts, dict):
                continue
            placed = None
            for rid, root in roots:
                try:
                    rel = os.path.relpath(abspath, root)
                except ValueError:
                    continue
                if rel != os.curdir and not rel.startswith(os.pardir):
                    placed = (rid, rel.replace(os.sep, "/"))
                    break
            if placed is None:
                continue
            rid, rel = placed
            # Hang the touch on the file's row without bringing a deleted
            # file back. A session can touch a file git has never seen
            # (uncommitted work) — it still gets a files row, with first_seen
            # NULL. But a file git has seen DELETED stays deleted unless it
            # is on disk again right now: an old read of it is history, and
            # reviving the row drew folders of long-gone files on Terrain.
            fid = _file_row(conn, rid, rel, live_by_repo[rid],
                            revive=os.path.exists(abspath))
            conn.execute(
                "INSERT INTO session_files"
                " (session_id, file_id, writes, reads, creates, last)"
                " VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT (session_id, file_id) DO UPDATE SET"
                "   writes = excluded.writes, reads = excluded.reads,"
                "   creates = excluded.creates, last = excluded.last",
                (cid, fid,
                 int(counts.get("writes") or 0),
                 int(counts.get("reads") or 0),
                 int(counts.get("creates") or 0),
                 counts.get("last")),
            )
            n += 1
    _bury_vanished(conn, roots)
    return n, _sync_turns(conn)


# --- when she was actually talking ---------------------------------------------

# The transcript line that carries a message SHE sent. A conversation's jsonl
# is one JSON object per line and holds four kinds of clock reading; only this
# one is her:
#
#   {"type": "user", "text": "...", "ts": "...", "journaled": true}  <- her, LOCAL
#   {"type": "user", "timestamp": "...Z"}        a tool RESULT, not a message
#   {"type": "assistant", "timestamp": "...Z"}   the agent's reply, UTC
#
# `journaled` rides along on her own turns: true when the capture hook minted a
# journal card out of that message. It is the pool's own answer, not a guess —
# 97% of flagged turns have a matching card within two minutes, and the flag
# never appears on a session rooted in the app checkout. Recorded here so a
# drawing can avoid showing the same moment twice; the row is kept either way.
#
# So `type == "user"` AND a `ts` key is the exact test for "she hit send", and
# the value is already in the local clock the rest of the system keeps. The
# tool-result envelopes wear `timestamp` instead, which is what keeps 254 of
# them out of a table that would otherwise claim she sent 270 messages.
_TURN_HINT = '"ts"'


def local_iso(raw):
    """One turn timestamp, normalised to the local clock, or None.

    `ts` is USUALLY already local and naive — that's what the capture hook
    writes. But the five conversations imported from an earlier system
    (`imported_from` in the index) carry UTC with a `Z` instead: 47 of 1,765
    rows here. Left alone they'd sit five hours off on any drawing, at 3am
    on a page whose whole point is that her sleep schedule is visible in the
    shape — wrong in exactly the way that looks plausible.

    So the conversion happens ONCE, here, and `session_turns.ts` is local
    without exception. Note this differs from its sibling
    `session_files.last`, which stores whatever the footprints sidecar wrote
    (UTC, from the transcripts' `timestamp` fields) — that column has other
    readers and isn't ours to redefine, so the pond converts it at read time
    instead. Two tables, two clocks, both documented where they're used.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    try:
        when = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z")
                                      else text)
    except ValueError:
        return None
    # A naive reading is already local — astimezone() on it would ASSUME local
    # and convert to local, which is a no-op, but only by luck. Return it as
    # written and leave the guessing out.
    if when.tzinfo is not None:
        when = when.astimezone().replace(tzinfo=None)
    return when.isoformat(timespec="seconds")


def _turn_times(path):
    """Every message she sent in one conversation as (local ts, journaled), in
    transcript order, each timestamp already normalised by `local_iso`.

    A turn with no `journaled` key at all (the 47 imported ones, which predate
    the flag) counts as NOT journalled rather than unknown — the pond would
    otherwise hide a message on the strength of a field that was never written.
    Erring toward drawing it is the recoverable direction.

    The cheap `in` test before json.loads is doing real work, not
    micro-optimising: these logs total ~300 MB and 95% of their lines are
    assistant events and tool results that can't match. Parsing only the
    candidates turns a full sweep of every conversation from a minute into
    under two seconds, which is what makes this affordable to re-derive
    wholesale on an hourly cron instead of maintaining an incremental cursor.
    """
    out = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if _TURN_HINT not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue        # a torn line shouldn't hide the rest
                if not isinstance(ev, dict) or ev.get("type") != "user":
                    continue
                ts = local_iso(ev.get("ts"))
                if ts:
                    out.append((ts, 1 if ev.get("journaled") is True else 0))
    except (OSError, UnicodeDecodeError):
        return []                   # an unreadable log is a quiet gap, not a crash
    return out


def _sync_turns(conn):
    """Rebuild `session_turns` from the conversation transcripts.

    Only conversations that already have a `sessions` row get turns — the
    transcripts directory can hold a log whose index entry has been archived
    away, and a turn belonging to no session is a row nothing can join to.
    Full rewrite, same reasoning as its sibling.
    """
    conn.execute("DELETE FROM session_turns")
    known = {r[0] for r in conn.execute("SELECT id FROM sessions")}
    chats = store.DATA_DIR / "bot_chats"
    if not chats.exists():
        return 0
    n = 0
    for path in sorted(chats.glob("*.jsonl")):
        if path.stem not in known:
            continue
        rows = [(path.stem, seq, ts, journaled)
                for seq, (ts, journaled) in enumerate(_turn_times(path))]
        if not rows:
            continue
        conn.executemany(
            "INSERT INTO session_turns (session_id, seq, ts, journaled)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
        n += len(rows)
    return n


# --- reading ------------------------------------------------------------------

def touches(repo_id):
    """{current path: [epoch, ...]} for every LIVING file in a repo, newest
    first — the whole history, no window, no cap. This is what replaced
    Terrain's per-request `git log`: a renamed file's touches follow it to
    its current path, and deleted files stay out of the map (their history
    remains queryable in the tables)."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT f.path, c.authored_ts"
            " FROM commit_files cf"
            " JOIN commits c ON c.sha = cf.sha"
            " JOIN files f ON f.id = cf.file_id"
            " WHERE f.repo = ? AND f.deleted_at IS NULL"
            " ORDER BY c.authored_ts DESC",
            (repo_id,),
        ).fetchall()
    finally:
        conn.close()
    out = {}
    for path, ts in rows:
        out.setdefault(path, []).append(ts)
    return out


# How many files of ONE folder a single commit has to touch before it stops
# counting as editing and starts counting as a sweep. The one number to turn
# if a coil reads wrong. Ten is well above a session's real editing and well
# below the batches that forced this: measured on the vault, the commits that
# trip it are the 2026-03-26 initial import, the 2026-08-22 machine cutover,
# and the hourly cron catching up a backlog — 40 Daily pages in one
# "Auto-backup", 17 Threads in another.
SWEEP_MIN = 10


def folder_edit_times(repo_id, prefix, sweep_min=SWEEP_MIN):
    """{path: epoch} for the living files directly inside `prefix` — when each
    was last really EDITED.

    A file's time is its newest touch from a commit that changed FEWER than
    `sweep_min` files of this same folder. A commit that changed more than
    that did not edit them, it swept them: the vault's hourly backup cron
    commits whatever it finds, so an import, a machine migration or a
    caught-up backlog lands as one commit across dozens of pages, and taking
    its timestamp as an edit reads as a flat band meaning "a commit passed
    through here".

    A file whose every touch was a sweep falls back to its FIRST add — the
    commit that created it. That keeps two promises at once: never undated
    (an undated dot has to go on the coil's outer tip, which is a worse lie
    than an approximate time), and a file that is never really edited shows
    when it was made, which is the honest thing to say about it.

    Counted PER FOLDER, not per commit: a backup sweeping 200 files across
    the vault but only two of them here really did edit those two.

    The suppression is a DISPLAY decision, made at the query the way the
    module header says filtering must be — the tables keep every commit.
    """
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT f.path, cf.sha, c.authored_ts, cf.status"
            " FROM commit_files cf"
            " JOIN commits c ON c.sha = cf.sha"
            " JOIN files f ON f.id = cf.file_id"
            " WHERE f.repo = ? AND f.deleted_at IS NULL"
            "   AND f.path LIKE ? AND instr(substr(f.path, ?), '/') = 0",
            (repo_id, prefix + "%", len(prefix) + 1),
        ).fetchall()
    finally:
        conn.close()

    # How much of THIS folder each commit moved — the number the rule reads.
    folder_span = {}
    for _path, sha, _ts, _status in rows:
        folder_span[sha] = folder_span.get(sha, 0) + 1

    edited = {}   # newest touch that was really an edit
    born = {}     # earliest add, the fallback
    for path, sha, ts, status in rows:
        if ts is None:
            continue
        if folder_span[sha] < sweep_min and ts > edited.get(path, -1):
            edited[path] = ts
        if status == "A" and ts < born.get(path, float("inf")):
            born[path] = ts
    return {path: edited.get(path, born[path])
            for path in set(edited) | set(born)}


def growth_series(repo_id):
    """One repo's history as per-day counters, date-ascending — the data under
    the Growth room's charts: [{date, commits, added, removed, born, died}].

    Deltas, not running totals: the client owns the cumulative sum because the
    chart's date window changes what "so far" means. Days nothing happened are
    simply absent.

    An honest limit: born/died come from files.first_seen / files.deleted_at,
    and a file deleted then re-created keeps ONE row (the resurrection rule in
    _file_row), so its earlier death and rebirth aren't counted — the curve
    smooths over resurrection churn. Commits and line counts are exact.

    Prompt that produced it: "I want to build more UI like terrain and make
    visualizations of my entire codebase/file system as it grows."
    """
    conn = sqlstore.open_db()
    try:
        days = {}

        def _day(d):
            return days.setdefault(d, {"date": d, "commits": 0, "added": 0,
                                       "removed": 0, "born": 0, "died": 0})

        # COUNT(DISTINCT sha): the LEFT JOIN fans a commit out to one row per
        # file, and a merge commit with no file rows must still count as one.
        for d, commits, added, removed in conn.execute(
            "SELECT date(c.authored_at), COUNT(DISTINCT c.sha),"
            "       SUM(COALESCE(cf.added, 0)), SUM(COALESCE(cf.removed, 0))"
            " FROM commits c LEFT JOIN commit_files cf ON cf.sha = c.sha"
            " WHERE c.repo = ? GROUP BY 1", (repo_id,),
        ):
            entry = _day(d)
            entry["commits"] = commits
            entry["added"] = added or 0
            entry["removed"] = removed or 0
        for d, n in conn.execute(
            "SELECT date(first_seen), COUNT(*) FROM files"
            " WHERE repo = ? AND first_seen IS NOT NULL GROUP BY 1", (repo_id,),
        ):
            _day(d)["born"] = n
        for d, n in conn.execute(
            "SELECT date(deleted_at), COUNT(*) FROM files"
            " WHERE repo = ? AND deleted_at IS NOT NULL GROUP BY 1", (repo_id,),
        ):
            _day(d)["died"] = n
        return [days[d] for d in sorted(days)]
    finally:
        conn.close()


def _repo_ids(repo_id):
    """One repo id or several, as a list plus the `?, ?` marks for an IN (…).
    The two readers below take either, so the main map — two folders — reads
    as one history the same way a single build does."""
    ids = [repo_id] if isinstance(repo_id, str) else list(repo_id)
    return ids, ",".join("?" * len(ids))


def commit_log(repo_id, limit=None):
    """A repo's commits, newest first — what a report lists:
    [{sha, ts, author, subject, files, added, removed}]. `repo_id` is one id
    or a list of them; a list reads as one history, interleaved by time.

    `files` is how many files the commit changed; `added`/`removed` are its
    line counts summed over them, with a binary file counting as nothing
    (its counts are stored as NULL — uncountable, not zero). `limit` cuts the
    list to the newest N."""
    ids, marks = _repo_ids(repo_id)
    conn = sqlstore.open_db()
    try:
        # LEFT JOIN, so a commit that changed no files (a merge) is still a row.
        rows = conn.execute(
            "SELECT c.sha, c.authored_ts, c.author, c.subject, COUNT(cf.file_id),"
            "       SUM(COALESCE(cf.added, 0)), SUM(COALESCE(cf.removed, 0))"
            " FROM commits c LEFT JOIN commit_files cf ON cf.sha = c.sha"
            f" WHERE c.repo IN ({marks}) GROUP BY c.sha"
            " ORDER BY c.authored_ts DESC, c.sha"
            + (" LIMIT ?" if limit is not None else ""),
            (*ids, limit) if limit is not None else ids,
        ).fetchall()
    finally:
        conn.close()
    return [{"sha": sha, "ts": ts, "author": author, "subject": subject,
             "files": files, "added": added or 0, "removed": removed or 0}
            for sha, ts, author, subject, files, added, removed in rows]


def repo_summary(repo_id):
    """A repo's history in a handful of numbers — the line a build wears on
    the Builds list: {commits, files, first, last, added, removed, days}.
    `repo_id` is one id or a list of them; a list is summed as one history.

    `files` counts the files alive now; `first`/`last` are the oldest and
    newest commit as unix seconds (None for a repo with no commits indexed);
    `days` is how many distinct local days had a commit."""
    ids, marks = _repo_ids(repo_id)
    conn = sqlstore.open_db()
    try:
        commits, first, last, days = conn.execute(
            "SELECT COUNT(*), MIN(authored_ts), MAX(authored_ts),"
            "       COUNT(DISTINCT date(authored_at))"
            f" FROM commits WHERE repo IN ({marks})", ids).fetchone()
        added, removed = conn.execute(
            "SELECT SUM(COALESCE(cf.added, 0)), SUM(COALESCE(cf.removed, 0))"
            " FROM commit_files cf JOIN commits c ON c.sha = cf.sha"
            f" WHERE c.repo IN ({marks})", ids).fetchone()
        files = conn.execute(
            f"SELECT COUNT(*) FROM files WHERE repo IN ({marks}) AND deleted_at IS NULL"
            "  AND first_seen IS NOT NULL", ids).fetchone()[0]
    finally:
        conn.close()
    return {"commits": commits, "files": files, "first": first, "last": last,
            "added": added or 0, "removed": removed or 0, "days": days}


def forget(repo_id):
    """Delete everything these tables hold about one repo — for a build taken
    off the list. Git is untouched, and adding the build back re-derives every
    row, so this loses nothing. Returns how many commits were dropped."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        try:
            # Children first: the rows that point at this repo's files and
            # commits go before the files and commits themselves.
            conn.execute(
                "DELETE FROM session_files WHERE file_id IN"
                " (SELECT id FROM files WHERE repo = ?)", (repo_id,))
            conn.execute(
                "DELETE FROM commit_files WHERE file_id IN"
                " (SELECT id FROM files WHERE repo = ?)", (repo_id,))
            dropped = conn.execute(
                "DELETE FROM commits WHERE repo = ?", (repo_id,)).rowcount
            conn.execute("DELETE FROM file_paths WHERE repo = ?", (repo_id,))
            conn.execute("DELETE FROM files WHERE repo = ?", (repo_id,))
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return dropped


def _count(table):
    conn = sqlstore.open_db()
    try:
        return conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    finally:
        conn.close()
