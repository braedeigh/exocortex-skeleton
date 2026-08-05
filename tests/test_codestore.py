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
import os
import sqlite3
import subprocess

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
