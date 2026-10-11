"""Tests for codestore.py — the code-history tables (typed entity #3).

Same layered shape as test_habitstore/test_expensestore, with one difference
that follows from the entity itself: the source of truth is GIT, so these
tests build real scratch repos in tmp_path and pass them in explicitly (the
conftest floor points codestore.default_repos at nothing, so no test can
accidentally walk the live checkout). The contracts that matter:

  - rebuild() derives commits/files/line counts from a walk and is idempotent.
  - A rename keeps the file's id — path is an attribute, not identity.
  - A deletion marks the row instead of erasing history.
  - update() indexes only what's new and lands on the same state a rebuild
    would — the incremental and the full walk are two roads to one truth.
  - The session tables derive from the bot_chats sidecars and join on file id.
"""
import json
import os
import sqlite3
import subprocess
import time

import pytest

import codestore
import sqlstore
import store


def _git(repo, *args, env=None):
    e = {**os.environ, **(env or {})}
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, env=e)


def _make_repo(root):
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    return root


def _commit(repo, relpath, content, message=None, date=None):
    path = repo / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    _git(repo, "add", relpath)
    env = {"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else None
    _git(repo, "commit", "-q", "-m", message or f"add {relpath}", env=env)


def _repos(root):
    return ({"id": "skeleton", "root": root},)


def _rows(sql, *params):
    conn = sqlite3.connect(store.DATA_DIR / "exo.db")
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def test_rebuild_indexes_commits_files_and_line_counts(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "app.py", "one\ntwo\n", message="first",
            date="2026-06-01T10:00:00")
    _commit(repo, "app.py", "one\ntwo\nthree\nfour\n", message="grow",
            date="2026-06-02T10:00:00")

    result = codestore.rebuild(_repos(repo))
    assert result["commits"] == 2 and result["files"] == 1

    subjects = {r[0] for r in _rows("SELECT subject FROM commits")}
    assert subjects == {"first", "grow"}
    # The second commit added two lines and removed none — numstat, stored.
    added = _rows(
        "SELECT cf.added, cf.removed FROM commit_files cf"
        " JOIN commits c ON c.sha = cf.sha WHERE c.subject = 'grow'")
    assert added == [(2, 0)]
    first, last = _rows("SELECT first_seen, last_seen FROM files")[0]
    assert first.startswith("2026-06-01") and last.startswith("2026-06-02")


def test_a_rename_keeps_the_files_identity(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "old_name.py", "def f():\n    return 1\n")
    _git(repo, "mv", "old_name.py", "new_name.py")
    _git(repo, "commit", "-q", "-m", "rename")

    codestore.rebuild(_repos(repo))
    files = _rows("SELECT id, path, deleted_at FROM files")
    assert len(files) == 1                     # one file, not a death and a birth
    fid, path, deleted = files[0]
    assert path == "new_name.py" and deleted is None
    # Both paths it ever wore resolve to the same row.
    assert {r[0] for r in _rows(
        "SELECT path FROM file_paths WHERE file_id = ?", fid)} == {
        "old_name.py", "new_name.py"}
    # And its history follows it: touches() reports both commits under the
    # current name.
    touches = codestore.touches("skeleton")
    assert set(touches) == {"new_name.py"}
    assert len(touches["new_name.py"]) == 2


def test_a_deleted_file_is_marked_not_erased(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "doomed.py", "x = 1\n")
    (repo / "doomed.py").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "remove")

    codestore.rebuild(_repos(repo))
    rows = _rows("SELECT deleted_at FROM files WHERE path = 'doomed.py'")
    assert len(rows) == 1 and rows[0][0] is not None
    # Off the map (touches serves living files), still in the record.
    assert codestore.touches("skeleton") == {}
    assert _rows("SELECT COUNT(*) FROM commit_files")[0][0] == 2


def test_recreating_a_deleted_path_resurrects_the_same_row(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "phoenix.py", "v1\n")
    (repo / "phoenix.py").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "remove")
    _commit(repo, "phoenix.py", "v2\n", message="return")

    codestore.rebuild(_repos(repo))
    files = _rows("SELECT deleted_at FROM files WHERE path = 'phoenix.py'")
    assert len(files) == 1 and files[0][0] is None   # one row, alive again
    assert len(codestore.touches("skeleton")["phoenix.py"]) == 3


def test_update_indexes_only_new_commits(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "a\n")
    codestore.rebuild(_repos(repo))

    assert codestore.update(_repos(repo)) == {"skeleton": 0}   # nothing new

    _commit(repo, "b.py", "b\n")
    assert codestore.update(_repos(repo)) == {"skeleton": 1}
    assert _rows("SELECT COUNT(*) FROM commits")[0][0] == 2
    assert codestore.update(_repos(repo)) == {"skeleton": 0}   # idempotent


def test_update_on_a_fresh_database_is_the_full_build(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "a\n")
    _commit(repo, "b.py", "b\n")
    assert codestore.update(_repos(repo)) == {"skeleton": 2}
    assert {r[0] for r in _rows("SELECT path FROM files")} == {"a.py", "b.py"}


def test_a_root_that_is_not_a_repo_degrades_to_nothing(data_dir, tmp_path):
    assert codestore.update(_repos(tmp_path / "no-repo")) == {"skeleton": 0}
    result = codestore.rebuild(_repos(tmp_path / "no-repo"))
    assert result["commits"] == 0


def test_binary_line_counts_are_uncountable_not_zero(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    (repo / "blob.bin").write_bytes(b"\x00\x01\x02")
    _git(repo, "add", "blob.bin")
    _git(repo, "commit", "-q", "-m", "binary")

    codestore.rebuild(_repos(repo))
    assert _rows("SELECT added, removed FROM commit_files") == [(None, None)]


def test_touches_orders_newest_first_across_the_whole_history(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    for day in ("01", "02", "03"):
        _commit(repo, "a.py", f"day {day}\n", date=f"2026-06-{day}T10:00:00")
    codestore.rebuild(_repos(repo))
    ts = codestore.touches("skeleton")["a.py"]
    assert len(ts) == 3 and ts == sorted(ts, reverse=True)


# --- the session tables -------------------------------------------------------

def _seed_sidecars(repo):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {
        "conv-1": {"title": "Index title", "bot": "keeper", "lane": "orchestra",
                   "started": "2026-06-01T09:00:00", "last_at": "2026-06-01T10:00:00"},
        "conv-quiet": {"title": "Touched nothing"},
    })
    store.write("bot_chats/gists", {"conv-1": {"title": "Gist title"}})
    store.write("bot_chats/footprints", {
        "conv-1": {"files": {
            str(repo / "app.py"): {"writes": 3, "reads": 1, "creates": 0,
                                   "last": "2026-06-01T09:30:00"},
            str(repo / "uncommitted.py"): {"writes": 1, "reads": 0, "creates": 1,
                                           "last": "2026-06-01T09:45:00"},
            "/etc/hosts": {"writes": 0, "reads": 2, "creates": 0, "last": None},
        }},
    })


def test_sync_sessions_makes_the_footprints_joinable(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "app.py", "x\n")
    _seed_sidecars(repo)

    codestore.rebuild(_repos(repo))

    # Every indexed conversation gets a row, footprint or not; the gist title
    # outranks the index title, same precedence the terrain payload uses.
    sessions = dict(_rows("SELECT id, title FROM sessions"))
    assert sessions == {"conv-1": "Gist title", "conv-quiet": "Touched nothing"}

    # The join works by file id: conv-1's write count is reachable from the
    # committed file's row, which is the whole point of the exercise.
    rows = _rows(
        "SELECT f.path, sf.writes, sf.creates FROM session_files sf"
        " JOIN files f ON f.id = sf.file_id ORDER BY f.path")
    assert rows == [("app.py", 3, 0), ("uncommitted.py", 1, 1)]
    # /etc/hosts is under neither root — not part of this codebase's story.

    # A session touch of a never-committed file still mints a files row, with
    # first_seen honestly NULL (git has no opinion about it).
    assert _rows("SELECT first_seen FROM files WHERE path = 'uncommitted.py'") == [(None,)]


def test_a_session_that_read_a_deleted_file_does_not_bring_it_back(data_dir, tmp_path):
    """A folder of files is deleted and committed; sessions that once read
    them are still in the footprints. The files must stay off the map through
    every later sync — and a row an older sync already revived is put right."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "briefs/one/BRIEF.md", "one\n")
    _commit(repo, "briefs/two/BRIEF.md", "two\n")
    _commit(repo, "kept.py", "x\n")
    _git(repo, "rm", "-rq", "briefs")
    _git(repo, "commit", "-q", "-m", "briefs live in the database now")
    (store.DATA_DIR / "bot_chats").mkdir(exist_ok=True)
    store.write("bot_chats/index", {"conv-1": {"title": "Read the briefs"}})
    store.write("bot_chats/footprints", {"conv-1": {"files": {
        str(repo / "briefs/one/BRIEF.md"): {"writes": 1, "reads": 4, "creates": 1,
                                            "last": "2026-06-01T09:30:00"},
        str(repo / "kept.py"): {"writes": 0, "reads": 1, "creates": 0, "last": None},
    }}})

    codestore.rebuild(_repos(repo))
    codestore.sync_sessions(_repos(repo))
    assert set(codestore.touches("skeleton")) == {"kept.py"}
    # The session's touch is still on record, on the deleted file's own row.
    assert _rows("SELECT sf.reads FROM session_files sf JOIN files f ON f.id = sf.file_id"
                 " WHERE f.path = 'briefs/one/BRIEF.md'") == [(4,)]

    # A row revived by the old sync (deleted_at wiped) is buried again, with
    # the time of the commit that deleted it.
    conn = sqlite3.connect(store.DATA_DIR / "exo.db")
    conn.execute("UPDATE files SET deleted_at = NULL WHERE path LIKE 'briefs/%'")
    conn.commit()
    conn.close()
    codestore.sync_sessions(_repos(repo))
    assert set(codestore.touches("skeleton")) == {"kept.py"}
    deleted = _rows("SELECT f.deleted_at, c.authored_at FROM files f, commits c"
                    " WHERE f.path LIKE 'briefs/%' AND c.subject LIKE 'briefs live%'")
    assert len(deleted) == 2 and all(at == when for at, when in deleted)

    # A file git never saw (written and removed between commits) that is not
    # on disk is not alive either, and stays that way sync after sync.
    store.write("bot_chats/footprints", {"conv-1": {"files": {
        str(repo / "briefs/one/BRIEF.md"): {"writes": 1, "reads": 4, "creates": 1,
                                            "last": "2026-06-01T09:30:00"},
        str(repo / "briefs/never/BRIEF.md"): {"writes": 1, "reads": 0, "creates": 1,
                                              "last": "2026-06-01T09:30:00"}}}})
    for _ in range(2):
        codestore.sync_sessions(_repos(repo))
        assert _rows("SELECT deleted_at FROM files WHERE path = 'briefs/never/BRIEF.md'"
                     ) == [("2026-06-01T09:30:00",)]

    # Written again but not yet committed: it is on disk, so it is alive.
    (repo / "briefs/one").mkdir(parents=True)
    (repo / "briefs/one/BRIEF.md").write_text("back\n")
    codestore.sync_sessions(_repos(repo))
    assert _rows("SELECT deleted_at FROM files WHERE path = 'briefs/one/BRIEF.md'") == [(None,)]


def test_sessions_carry_their_real_lane_and_keeper_flag(data_dir, tmp_path):
    # Older sessions never stored a lane — SQL used to show them blank. And
    # every session says bot="keeper", so that column can't find the journal.
    (data_dir / "bot_chats").mkdir()
    store.write("bot_chats/index", {
        "vault-old": {"bot": "keeper", "cwd": str(tmp_path / "vault")},
        "build-old": {"bot": "keeper", "cwd": str(store.BUILD_DIR)},
        "coding-new": {"bot": "keeper", "lane": "coding", "cwd": str(store.BUILD_DIR)},
        "the-keeper": {"bot": "keeper", "journal": True, "cwd": str(tmp_path / "vault")},
    })
    store.write("bot_chats/footprints", {})
    codestore.sync_sessions(())
    rows = {r[0]: (r[1], r[2]) for r in _rows("SELECT id, lane, is_keeper FROM sessions")}
    assert rows == {
        "vault-old": ("personal", 0),
        "build-old": ("orchestra", 0),
        "coding-new": ("coding", 0),
        "the-keeper": ("personal", 1),
    }


def test_sync_sessions_is_a_full_rederive(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "app.py", "x\n")
    _seed_sidecars(repo)
    codestore.rebuild(_repos(repo))

    # The sidecar shrinks (its own cron rebuilds it wholesale) — the tables
    # must follow it down, not accumulate.
    store.write("bot_chats/footprints", {})
    codestore.sync_sessions(_repos(repo))
    assert _rows("SELECT COUNT(*) FROM session_files")[0][0] == 0


# --- the turns: when she was actually at the keyboard -------------------------
#
# A conversation's jsonl carries four kinds of line, and only one of them is a
# message she sent. Getting that test wrong doesn't error — it silently claims
# she typed seventeen times when she typed one, which on a time axis reads as a
# busy afternoon she never had.

def _write_transcript(conv_id, lines):
    path = store.DATA_DIR / "bot_chats" / f"{conv_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")


def test_turns_are_only_the_messages_she_sent(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _seed_sidecars(repo)
    _write_transcript("conv-1", [
        {"type": "user", "text": "do the thing", "ts": "2026-06-01T09:00:12"},
        # An agent reply — wears `timestamp`, not `ts`.
        {"type": "assistant", "timestamp": "2026-06-01T14:00:20.100Z"},
        # A TOOL RESULT. Also type "user", which is the trap: these outnumber
        # her real messages fifteen to one in a working session.
        {"type": "user", "timestamp": "2026-06-01T14:00:25.500Z"},
        {"type": "user", "text": "again", "ts": "2026-06-01T09:05:44"},
    ])

    codestore.rebuild(_repos(repo))

    assert _rows("SELECT session_id, seq, ts FROM session_turns ORDER BY seq") == [
        ("conv-1", 0, "2026-06-01T09:00:12"),
        ("conv-1", 1, "2026-06-01T09:05:44"),
    ]


def test_an_imported_utc_turn_is_converted_to_her_clock(data_dir, tmp_path, monkeypatch):
    """Most transcripts write local time, but the handful imported from an
    earlier system wrote UTC with a `Z`. One table, one clock — the conversion
    happens at the sync, so nothing downstream has to know which kind it got."""
    monkeypatch.setenv("TZ", "Etc/GMT+5")
    time.tzset()
    try:
        repo = _make_repo(tmp_path / "repo")
        _seed_sidecars(repo)
        _write_transcript("conv-1", [
            {"type": "user", "text": "local", "ts": "2026-06-01T09:00:00"},
            {"type": "user", "text": "imported", "ts": "2026-06-01T14:30:00.500Z"},
        ])

        codestore.rebuild(_repos(repo))

        assert [r[0] for r in _rows("SELECT ts FROM session_turns ORDER BY seq")] == [
            "2026-06-01T09:00:00",   # already local — passed through untouched
            "2026-06-01T09:30:00",   # 14:30Z, five hours back
        ]
    finally:
        monkeypatch.undo()
        time.tzset()


def test_a_transcript_with_no_session_row_is_skipped(data_dir, tmp_path):
    """The transcripts directory outlives the index — a log whose entry was
    pruned would otherwise mint turns that join to nothing."""
    repo = _make_repo(tmp_path / "repo")
    _seed_sidecars(repo)
    _write_transcript("conv-1", [{"type": "user", "text": "a", "ts": "2026-06-01T09:00:00"}])
    _write_transcript("conv-forgotten",
                      [{"type": "user", "text": "b", "ts": "2026-06-01T09:00:00"}])

    codestore.rebuild(_repos(repo))

    assert {r[0] for r in _rows("SELECT DISTINCT session_id FROM session_turns")} == {"conv-1"}


def test_a_torn_transcript_line_doesnt_hide_the_rest(data_dir, tmp_path):
    """These logs are appended to live, so the last line can be half-written
    when the sync reads it. One bad line must cost one turn, not the file."""
    repo = _make_repo(tmp_path / "repo")
    _seed_sidecars(repo)
    path = store.DATA_DIR / "bot_chats" / "conv-1.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '{"type": "user", "text": "first", "ts": "2026-06-01T09:00:00"}\n'
        '{"type": "user", "text": "torn", "ts": "2026-06-0\n'
        '{"type": "user", "text": "third", "ts": "2026-06-01T09:10:00"}\n'
    )

    codestore.rebuild(_repos(repo))

    assert [r[0] for r in _rows("SELECT ts FROM session_turns ORDER BY seq")] == [
        "2026-06-01T09:00:00", "2026-06-01T09:10:00"]


def test_a_turn_records_whether_it_became_a_journal_entry(data_dir, tmp_path):
    """The capture hook stamps `journaled` on the turn as it mints the card, so
    this is the pool's own answer rather than a guess. The pond uses it to
    avoid drawing one moment in both lanes. A turn with no flag at all (the
    imported conversations predate it) counts as NOT journalled — erring toward
    drawing a message is recoverable; silently hiding one is not."""
    repo = _make_repo(tmp_path / "repo")
    _seed_sidecars(repo)
    _write_transcript("conv-1", [
        {"type": "user", "text": "an entry", "ts": "2026-06-01T09:00:00", "journaled": True},
        {"type": "user", "text": "a build ask", "ts": "2026-06-01T09:05:00", "journaled": False},
        {"type": "user", "text": "imported, no flag", "ts": "2026-06-01T09:10:00"},
    ])

    codestore.rebuild(_repos(repo))

    assert _rows("SELECT ts, journaled FROM session_turns ORDER BY seq") == [
        ("2026-06-01T09:00:00", 1),
        ("2026-06-01T09:05:00", 0),
        ("2026-06-01T09:10:00", 0),
    ]


def test_turns_are_a_full_rederive(data_dir, tmp_path):
    """Same contract as its sibling: the transcripts are truth, so a turn that
    left them must leave the table too."""
    repo = _make_repo(tmp_path / "repo")
    _seed_sidecars(repo)
    _write_transcript("conv-1", [
        {"type": "user", "text": "a", "ts": "2026-06-01T09:00:00"},
        {"type": "user", "text": "b", "ts": "2026-06-01T09:01:00"},
    ])
    codestore.rebuild(_repos(repo))
    assert _rows("SELECT COUNT(*) FROM session_turns")[0][0] == 2

    _write_transcript("conv-1", [{"type": "user", "text": "a", "ts": "2026-06-01T09:00:00"}])
    assert codestore.sync_turns() == 1
    assert _rows("SELECT COUNT(*) FROM session_turns")[0][0] == 1


def test_growth_series_counts_days_deltas_not_totals(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "one\ntwo\n", date="2026-06-01T10:00:00")
    _commit(repo, "b.py", "x\n", date="2026-06-03T10:00:00")
    (repo / "a.py").unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "remove",
         env={"GIT_AUTHOR_DATE": "2026-06-03T11:00:00",
              "GIT_COMMITTER_DATE": "2026-06-03T11:00:00"})
    codestore.rebuild(_repos(repo))

    series = codestore.growth_series("skeleton")
    assert [d["date"] for d in series] == ["2026-06-01", "2026-06-03"]
    day1, day3 = series
    assert day1 == {"date": "2026-06-01", "commits": 1, "added": 2,
                    "removed": 0, "born": 1, "died": 0}
    # Two commits that day: b.py born (+1 line), a.py dying (-2 lines).
    assert day3["commits"] == 2 and day3["born"] == 1 and day3["died"] == 1
    assert day3["added"] == 1 and day3["removed"] == 2


def test_update_and_rebuild_agree(data_dir, tmp_path):
    """The incremental road and the full re-walk must land on the same state —
    if they can drift, the fast path is quietly lying."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "a\n", date="2026-06-01T10:00:00")
    codestore.update(_repos(repo))
    _commit(repo, "b.py", "b\n", date="2026-06-02T10:00:00")
    _git(repo, "mv", "a.py", "renamed.py")
    _git(repo, "commit", "-q", "-m", "rename")
    codestore.update(_repos(repo))
    incremental = _rows(
        "SELECT f.path, cf.status FROM commit_files cf"
        " JOIN files f ON f.id = cf.file_id ORDER BY cf.sha, f.path")

    codestore.rebuild(_repos(repo))
    rebuilt = _rows(
        "SELECT f.path, cf.status FROM commit_files cf"
        " JOIN files f ON f.id = cf.file_id ORDER BY cf.sha, f.path")
    assert incremental == rebuilt


# --- update() and the write lock ---------------------------------------------
#
# Terrain calls update() every time its cache expires — every few seconds while
# a session runs — and git takes the better part of a second even when nothing
# is new. Held across that, the write lock starved every other writer in the
# app (swarms, the usage beacons, peer mail) into "database is locked".

def _someone_else_can_write():
    """Can another connection take the write lock right now, without waiting?"""
    conn = sqlite3.connect(store.DATA_DIR / "exo.db", timeout=0, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("ROLLBACK")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def test_update_leaves_the_database_writable_while_git_runs(data_dir, tmp_path, monkeypatch):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "a\n")
    codestore.update(_repos(repo))
    _commit(repo, "b.py", "b\n")
    seen = []
    real_git, real_log = codestore._git, codestore._log_over

    def git_watching(*args, **kwargs):
        seen.append(_someone_else_can_write())
        return real_git(*args, **kwargs)

    def log_watching(*args, **kwargs):
        seen.append(_someone_else_can_write())
        return real_log(*args, **kwargs)

    monkeypatch.setattr(codestore, "_git", git_watching)
    monkeypatch.setattr(codestore, "_log_over", log_watching)
    assert codestore.update(_repos(repo)) == {"skeleton": 1}
    assert seen and all(seen)


def test_update_racing_another_update_indexes_each_commit_once(data_dir, tmp_path, monkeypatch):
    """Git is read outside the lock, so another update can land the same
    commits in between; the slower one must notice, not apply them twice."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "a.py", "a\n")
    codestore.update(_repos(repo))
    _commit(repo, "a.py", "a2\n")
    _git(repo, "rm", "-q", "a.py")
    _git(repo, "commit", "-q", "-m", "drop")
    real_log = codestore._log_over
    raced = []

    def log_then_race(*args, **kwargs):
        if not raced:
            raced.append(True)
            monkeypatch.setattr(codestore, "_log_over", real_log)
            codestore.update(_repos(repo))
        return real_log(*args, **kwargs)

    monkeypatch.setattr(codestore, "_log_over", log_then_race)
    assert codestore.update(_repos(repo)) == {"skeleton": 0}
    assert _rows("SELECT COUNT(*) FROM commits")[0][0] == 3
    assert _rows("SELECT COUNT(*) FROM commit_files")[0][0] == 3


# --- when a file was last really EDITED ---------------------------------------
#
# folder_edit_times answers "when did she last work on this", which is NOT the
# newest touch: the vault's backup cron commits whatever it finds each hour, so
# an import or a machine migration lands as one commit across dozens of pages.
# Taking that as an edit draws a flat band meaning "a commit passed through
# here", which is the exact thing the coils exist to stop showing. These pin
# the rule that separates the two, and the fallback that keeps every file
# dated — an undated dot goes on a coil's outer tip, which is a worse lie than
# an approximate time.

def _commit_many(repo, paths, message, date):
    """One commit touching several files at once — a sweep, if it's wide."""
    for relpath, content in paths.items():
        path = repo / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        _git(repo, "add", relpath)
    _git(repo, "commit", "-q", "-m", message,
         env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})


def _at(repo, rel):
    return codestore.folder_edit_times("skeleton", rel, sweep_min=3)


def test_edit_times_read_the_newest_real_touch(data_dir, tmp_path):
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "pages/a.md", "one", date="2026-06-01T10:00:00")
    _commit(repo, "pages/a.md", "two", date="2026-07-01T10:00:00")
    codestore.rebuild(_repos(repo))

    at = _at(repo, "pages/")

    assert time.strftime("%Y-%m-%d", time.localtime(at["pages/a.md"])) == "2026-07-01"


def test_a_commit_that_sweeps_the_folder_is_not_an_edit(data_dir, tmp_path):
    """The backup cron catching up a backlog moved these; she didn't write
    them. The real edit underneath is what the coil should show."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "pages/a.md", "one", date="2026-06-01T10:00:00")
    _commit(repo, "pages/b.md", "one", date="2026-06-02T10:00:00")
    _commit(repo, "pages/c.md", "one", date="2026-06-03T10:00:00")
    _commit_many(repo, {"pages/a.md": "x", "pages/b.md": "x", "pages/c.md": "x"},
                 "Auto-backup 2026-09-01_0500", "2026-09-01T05:00:00")
    codestore.rebuild(_repos(repo))

    at = _at(repo, "pages/")

    assert time.strftime("%Y-%m-%d", time.localtime(at["pages/a.md"])) == "2026-06-01"
    assert time.strftime("%Y-%m-%d", time.localtime(at["pages/c.md"])) == "2026-06-03"


def test_a_commit_touching_few_of_this_folder_still_counts(data_dir, tmp_path):
    """Counted PER FOLDER: a backup sweeping the whole vault but only two
    files here really did edit those two."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "pages/a.md", "one", date="2026-06-01T10:00:00")
    _commit_many(repo, {"pages/a.md": "x", "other/1.md": "x", "other/2.md": "x",
                        "other/3.md": "x", "other/4.md": "x"},
                 "Auto-backup 2026-09-01_0500", "2026-09-01T05:00:00")
    codestore.rebuild(_repos(repo))

    at = _at(repo, "pages/")

    # Wide commit, but it only moved ONE page here — that's an edit.
    assert time.strftime("%Y-%m-%d", time.localtime(at["pages/a.md"])) == "2026-09-01"


def test_a_file_only_ever_swept_falls_back_to_when_it_was_created(data_dir, tmp_path):
    """Imported in a batch and never touched since. Its creation is the only
    honest thing left to say, and saying nothing would strand it on the tip."""
    repo = _make_repo(tmp_path / "repo")
    _commit_many(repo, {"pages/a.md": "x", "pages/b.md": "x", "pages/c.md": "x"},
                 "Initial commit", "2026-03-26T15:00:00")
    codestore.rebuild(_repos(repo))

    at = _at(repo, "pages/")

    assert set(at) == {"pages/a.md", "pages/b.md", "pages/c.md"}
    assert time.strftime("%Y-%m-%d", time.localtime(at["pages/a.md"])) == "2026-03-26"


def test_edit_times_cover_every_living_file_in_the_folder(data_dir, tmp_path):
    """The promise the fallback exists to keep: never undated."""
    repo = _make_repo(tmp_path / "repo")
    _commit_many(repo, {f"pages/{i}.md": "x" for i in range(6)},
                 "Initial commit", "2026-03-26T15:00:00")
    _commit(repo, "pages/0.md", "edited", date="2026-08-01T10:00:00")
    codestore.rebuild(_repos(repo))

    at = _at(repo, "pages/")

    assert len(at) == 6
    assert all(isinstance(v, int) for v in at.values())


def test_edit_times_ignore_a_subfolders_files(data_dir, tmp_path):
    """A coil is a statement about the folder's OWN files."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "pages/a.md", "one", date="2026-06-01T10:00:00")
    _commit(repo, "pages/shots/b.png", "one", date="2026-06-02T10:00:00")
    codestore.rebuild(_repos(repo))

    assert set(_at(repo, "pages/")) == {"pages/a.md"}


def test_a_deleted_file_keeps_no_edit_time(data_dir, tmp_path):
    """Deleted files stay off the map, the same way touches() holds it."""
    repo = _make_repo(tmp_path / "repo")
    _commit(repo, "pages/a.md", "one", date="2026-06-01T10:00:00")
    _commit(repo, "pages/b.md", "one", date="2026-06-02T10:00:00")
    _git(repo, "rm", "-q", "pages/b.md")
    _git(repo, "commit", "-q", "-m", "drop")
    codestore.rebuild(_repos(repo))

    assert set(_at(repo, "pages/")) == {"pages/a.md"}
