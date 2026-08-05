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
    Milliseconds when nothing is new, so Terrain runs it on every cache miss
    and the map is never staler than its own cache. This is the one place
    this entity deviates from habitstore/expensestore's rebuild-only shape:
    git history only grows, and a full re-walk on every map load is the
    exact cost the old `git log` path already paid and this store exists to
    retire.
  - `sync_sessions()` — full re-derive of the two session tables from
    bot_chats/index.json + gists.json + footprints.json (small, so no
    incremental variant is needed).

Everything gets indexed — both repos, full history, machine-churn commits
included. Filtering (Terrain's denylist, the hourly "auto backup" noise) is
a DISPLAY decision made by whoever queries; the tables stay complete so a
future visualization isn't stuck with one page's taste.

Touches: `sqlstore.py` (owns the schema + connection factory), `store.py`
(BUILD_DIR / CONTENT_DIR for the default repo roots, and the bot_chats
sidecars), `routes/terrain.py` (reads `touches()` instead of running git),
`routes/sqlab.py` (rebuild button + table list), and
`scripts/update_code_history.py` (the hourly cron wrapper).

Prompt that produced this file: "make the codebase itself SQL backed — when
it was edited, information about associated files… Terrain will be built off
of this; I want to build more UI like terrain and make visualizations of my
entire codebase/file system as it grows."
"""
from datetime import datetime
from pathlib import Path
import os
import subprocess

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
    so this module never imports the routes layer."""
    return (
        {"id": "skeleton", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "root": Path(store.CONTENT_DIR).parent},
    )


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


def _file_row(conn, repo_id, path, live, seen_at=None):
    """The file_id that owns `path` right now, minting a row if none does.

    Resurrection rule: if the path's most recent owner (file_paths) still
    wears this path and is merely deleted, it comes back as the same row —
    a file deleted and restored is one file, not two. A row whose current
    path has moved on (renamed away) is NOT resurrected; the path gets a
    fresh row and file_paths repoints to the new occupant.
    """
    fid = live.get(path)
    if fid is not None:
        return fid
    row = conn.execute(
        "SELECT f.id FROM file_paths p JOIN files f ON f.id = p.file_id"
        " WHERE p.repo = ? AND p.path = ? AND f.path = ?",
        (repo_id, path, path),
    ).fetchone()
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


def _index_repo(conn, repo_id, root):
    """Bring one repo's tables up to its current HEAD. Incremental by sha set:
    whatever `git rev-list HEAD` reports that the commits table doesn't have
    gets walked, oldest first. On a fresh database that's everything, so
    'full build' and 'catch up' are the same program. Commits that fell out
    of history (a rebase) simply stop being reachable — they stay in the
    tables until the next rebuild() sweeps them."""
    shas = _rev_list(root)
    if shas is None:
        return 0
    stored = {r[0] for r in conn.execute(
        "SELECT sha FROM commits WHERE repo = ?", (repo_id,))}
    missing = [s for s in shas if s not in stored]
    if not missing:
        return 0
    missing.reverse()   # rev-list is newest-first; history applies oldest-first
    structure = _log_over(root, missing, "--name-status")
    counts = {sha: _parse_numstat(lines)
              for sha, _, _, _, lines in _log_over(root, missing, "--numstat")}
    # Chronological order: rev-list order is topological-newest-first, so the
    # reversed list is already oldest-first; sort by timestamp as a belt for
    # histories whose topology and clocks disagree.
    structure.sort(key=lambda c: c[1])
    return _apply_commits(conn, repo_id, structure, counts)


# --- the public entry points --------------------------------------------------

def update(repos=None):
    """Catch the git tables up to both repos' HEADs. Cheap when there's
    nothing new (one rev-list per repo), so callers can run it eagerly —
    Terrain does, on every cache miss. Returns {repo_id: commits_indexed}."""
    repos = default_repos() if repos is None else repos
    conn = sqlstore.open_db()
    out = {}
    try:
        conn.execute("BEGIN IMMEDIATE")
        for repo in repos:
            out[repo["id"]] = _index_repo(conn, repo["id"], repo["root"])
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
    repos = default_repos() if repos is None else repos
    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
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
        sessions = _sync_sessions(conn, repos)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    files = _count("files")
    return {"commits": commits, "files": files, "sessions": sessions}


def sync_sessions(repos=None):
    """Re-derive sessions + session_files from the bot_chats sidecars. Full
    rewrite every run — the corpus is ~a thousand rows, and the sidecars are
    themselves rebuilt wholesale by their own cron, so mirroring that shape
    keeps the two rebuilds impossible to half-align."""
    repos = default_repos() if repos is None else repos
    conn = sqlstore.open_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        n = _sync_sessions(conn, repos)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return n


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
        conn.execute(
            "INSERT INTO sessions (id, title, bot, lane, started, last_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (cid, title, meta.get("bot"), meta.get("lane"),
             meta.get("started"), meta.get("last_at")),
        )

    # Footprint paths are absolute; map each under whichever repo root holds
    # it (same relpath dance routes/terrain.py does) and skip the rest — a
    # session reading /etc/hosts is not part of either codebase's story.
    roots = [(r["id"], str(Path(r["root"]))) for r in repos]
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
            # A session can touch a file git has never seen (uncommitted
            # work) — it still gets a files row, with first_seen NULL.
            fid = _file_row(conn, rid, rel, live_by_repo[rid])
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


def _count(table):
    conn = sqlstore.open_db()
    try:
        return conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    finally:
        conn.close()
