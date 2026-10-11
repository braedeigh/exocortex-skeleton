"""Terrain builds — the owner's other git folders, each read as its own map
and its own report (buildlist.py, routes/terrain_builds.py, and the `?build=`
door in routes/terrain.py).

What has to hold, and would break without anyone noticing:

  - A build reads as a report: its commits, its line counts, the sessions
    that worked in it — and its map carries only that folder.
  - Each session in the report carries the LAST summary a helper wrote of
    it, whichever of the two tables holds it — and says so plainly when no
    helper ever summarised it.
  - A build never reaches the main map, a visitor, or the published mirror.
    The main map is public; a build is the owner's alone.
  - The code-history tables keep a build through a rebuild, and forget it when
    it is taken off the list — without touching the folder.
  - Only a real git folder that doesn't overlap the app or the vault, or a
    GitHub address, can be added. Nothing else is handed to git.
  - A clone runs on its own and its state is read off the disk.

Real scratch repos in tmp_path throughout, same as test_codestore.py.
"""
import os
import subprocess
import time
from pathlib import Path

import pytest
from flask import Flask

import buildlist
import codestore
import sqlstore
import store
from routes import observatory, terrain, terrain_builds


def _git(repo, *args, env=None):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                   env={**os.environ, **(env or {})})


def _make_repo(root):
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    return root


def _commit(repo, relpath, content, message, date):
    path = repo / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    _git(repo, "add", relpath)
    _git(repo, "commit", "-q", "-m", message,
         env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})


@pytest.fixture
def project(tmp_path):
    """A small project built over two days, in a folder of its own."""
    repo = _make_repo(tmp_path / "side-project")
    _commit(repo, "src/app.ts", "one\ntwo\n", "Workspace", "2026-09-30T10:00:00")
    _commit(repo, "src/app.ts", "one\ntwo\nthree\n", "Calculator", "2026-10-01T09:00:00")
    _commit(repo, "README.md", "# Side project\n", "Docs", "2026-10-01T11:00:00")
    return repo


@pytest.fixture
def roots(data_dir, tmp_path, monkeypatch):
    """The main map's two folders, re-rooted at empty temp dirs, and clones
    pointed at a temp dir too — nothing here may reach the real checkout."""
    monkeypatch.setattr(terrain, "_terrain_cache", {})
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": tmp_path / "app"},
        {"id": "vault", "name": "Personal vault", "root": tmp_path / "vault"},
    ))
    monkeypatch.setattr(buildlist, "_core_roots",
                        lambda: (tmp_path / "app", tmp_path / "vault"))
    store.write("terrain_builds", {"clone_dir": str(tmp_path / "clones"), "builds": []})
    return tmp_path


@pytest.fixture
def client(roots):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain.register(app)
    terrain_builds.register(app)
    return app.test_client()


def _add(client, source):
    return client.post("/api/observatory/terrain/builds", json={"source": str(source)})


def _seed_session(project):
    """One session that wrote the project's app file three times."""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {
        "2026-10-01.011116": {"title": "Side project build", "lane": "coding",
                              "last_at": "2026-10-01T09:05:00", "archived": True},
        "2026-10-01.080000": {"title": "Something else entirely", "lane": "personal",
                              "last_at": "2026-10-01T08:00:00"},
    })
    store.write("bot_chats/footprints", {
        "2026-10-01.011116": {"files": {
            str(project / "src" / "app.ts"): {"writes": 3, "reads": 1, "creates": 1,
                                             "last": "2026-10-01T09:04:00Z"}}},
    })


def test_a_build_reads_as_a_report_of_what_happened(client, project):
    _seed_session(project)

    added = _add(client, project)
    assert added.status_code == 200
    build = added.get_json()["build"]
    assert (build["id"], build["name"], build["state"]) == (
        "side-project", "Side Project", "ready")

    report = client.get("/api/observatory/terrain/builds/side-project/report").get_json()

    # What was built, and when: every commit, newest first, with its size.
    assert [c["subject"] for c in report["commits"]] == ["Docs", "Calculator", "Workspace"]
    assert report["commits"][1]["added"] == 1 and report["commits"][2]["added"] == 2
    summary = report["summary"]
    assert (summary["commits"], summary["files"], summary["days"]) == (3, 2, 2)
    assert summary["first"] < summary["last"]
    # By whom: the one session that worked here, and not the one that didn't.
    assert [(s["title"], s["files"], s["writes"]) for s in report["sessions"]] == [
        ("Side project build", 1, 3)]

    # The same build on the list carries the same numbers.
    listed = client.get("/api/observatory/terrain/builds").get_json()["builds"]
    assert [(b["id"], b["summary"]["commits"]) for b in listed] == [("side-project", 3)]


def test_a_session_in_the_report_carries_the_last_summary_written_of_it(client, project):
    """The helpers keep a session's summary in two places: one row while it
    works alone, one per swarm it was ever in. The report must show the newest
    of them all, skip an empty one, and leave a never-summarised session bare."""
    _seed_session(project)
    index = store.read("bot_chats/index", {})
    index["2026-10-02.090000"] = {"title": "Never summarised", "lane": "coding",
                                  "last_at": "2026-10-02T09:00:00"}
    store.write("bot_chats/index", index)
    footprints = store.read("bot_chats/footprints", {})
    footprints["2026-10-02.090000"] = {"files": {
        str(project / "README.md"): {"writes": 0, "reads": 2, "creates": 0,
                                     "last": "2026-10-02T09:00:00Z"}}}
    store.write("bot_chats/footprints", footprints)

    worker = "2026-10-01.011116"
    conn = sqlstore.open_db()
    try:
        for swarm_id in (1, 2):
            conn.execute("INSERT INTO swarms (id, created_at, updated_at) VALUES (?, ?, ?)",
                         (swarm_id, "2026-10-01T00:00:00", "2026-10-01T00:00:00"))
        conn.executemany(
            "INSERT INTO swarm_members (swarm_id, conv, joined_at, summary, summary_at)"
            " VALUES (?, ?, ?, ?, ?)",
            [(1, worker, "2026-10-01T01:00:00", "Starting the workspace.", "2026-10-01T02:00:00"),
             (2, worker, "2026-10-01T05:00:00", "Calculator shipped; docs left.", "2026-10-01T09:00:00"),
             # Newer than everything, but empty: a summary that says nothing
             # must not hide the last one that did.
             (2, "2026-10-02.090000", "2026-10-02T09:00:00", "  ", "2026-10-03T00:00:00")])
        conn.execute("INSERT INTO session_summaries (conv, summary, summary_at) VALUES (?, ?, ?)",
                     (worker, "Working alone on the workspace.", "2026-10-01T04:00:00"))
        conn.commit()
    finally:
        conn.close()

    _add(client, project)
    report = client.get("/api/observatory/terrain/builds/side-project/report").get_json()
    by_title = {s["title"]: s for s in report["sessions"]}

    summarised = by_title["Side project build"]
    assert (summarised["summary"], summarised["summary_at"], summarised["summary_source"]) == (
        "Calculator shipped; docs left.", "2026-10-01T09:00:00", "swarm helper")
    bare = by_title["Never summarised"]
    assert (bare["summary"], bare["summary_at"], bare["summary_source"]) == (None, None, None)


def test_the_main_map_reads_as_one_report_over_its_own_folders(client, roots, project):
    """The main map is two folders. Its report is their histories read as one
    — and a build's commits and sessions never leak into it."""
    app, vault = roots / "app", roots / "vault"
    _make_repo(app)
    _commit(app, "server.py", "x = 1\n", "App work", "2026-10-02T10:00:00")
    _make_repo(vault)
    _commit(vault, "notes.md", "a\nb\n", "Vault work", "2026-10-03T10:00:00")
    _seed_session(project)
    index = store.read("bot_chats/index", {})
    index["2026-10-02.100000"] = {"title": "App session", "lane": "coding",
                                  "last_at": "2026-10-02T10:00:00"}
    store.write("bot_chats/index", index)
    footprints = store.read("bot_chats/footprints", {})
    footprints["2026-10-02.100000"] = {"files": {
        str(app / "server.py"): {"writes": 2, "reads": 0, "creates": 1,
                                 "last": "2026-10-02T10:00:00Z"}}}
    store.write("bot_chats/footprints", footprints)
    _add(client, project)

    report = client.get("/api/observatory/terrain/report").get_json()

    assert [c["subject"] for c in report["commits"]] == ["Vault work", "App work"]
    assert (report["summary"]["commits"], report["summary"]["days"]) == (2, 2)
    assert report["summary"]["added"] == 3
    assert [(s["title"], s["files"], s["writes"]) for s in report["sessions"]] == [
        ("App session", 1, 2)]


def test_the_main_maps_report_never_reaches_a_visitor(roots, monkeypatch):
    monkeypatch.setattr(terrain, "_visitor", lambda: True)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain_builds.register(app)
    assert app.test_client().get("/api/observatory/terrain/report").status_code == 404


def test_a_builds_map_holds_only_that_build_and_the_main_map_never_holds_it(client, project):
    _seed_session(project)
    _add(client, project)

    build_map = client.get("/api/observatory/terrain?build=side-project&limit=all").get_json()

    assert build_map["build"] == {"id": "side-project", "name": "Side Project"}
    assert [r["id"] for r in build_map["repos"]] == ["side-project"]
    files = {f["path"]: f for f in build_map["repos"][0]["files"]}
    assert set(files) == {"README.md", "src/app.ts"}
    assert len(files["src/app.ts"]["touches"]) == 2
    # Only the session that touched it is on this map — not every open one.
    assert [s["title"] for s in build_map["sessions"]] == ["Side project build"]
    assert build_map["pond_days"] == [] and build_map["coils"] == []

    main_map = client.get("/api/observatory/terrain?limit=all")
    assert {r["id"] for r in main_map.get_json()["repos"]} == {"skeleton", "vault"}
    assert "src/app.ts" not in main_map.get_data(as_text=True)

    # A dot on the build's map opens like any other file.
    opened = client.get("/api/observatory/terrain/file?repo=side-project&path=src/app.ts")
    assert opened.status_code == 200 and "three" in opened.get_json()["content"]


def test_an_unknown_build_is_not_found(client):
    assert client.get("/api/observatory/terrain?build=nope").status_code == 404
    assert client.get("/api/observatory/terrain/builds/nope/report").status_code == 404
    assert client.delete("/api/observatory/terrain/builds/nope").status_code == 404


@pytest.mark.parametrize("mirror", [False, True])
def test_a_build_never_reaches_a_visitor(roots, project, monkeypatch, mirror):
    """Through the real app and its gate, both ways a stranger arrives: logged
    out on the private site, and on the public-only mirror."""
    if mirror:
        monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    else:
        monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    buildlist.add_folder(str(project))
    import server
    visitor = server.app.test_client()

    assert visitor.get("/api/observatory/terrain?build=side-project").status_code == 404
    assert visitor.get("/api/observatory/terrain/builds").status_code == 401
    assert visitor.get("/api/observatory/terrain/builds/side-project/report").status_code == 401
    assert visitor.post("/api/observatory/terrain/builds",
                        json={"source": str(project)}).status_code == 401
    # The file door knows the build (the owner opens its files there) and
    # still answers a stranger "private", with none of the text.
    opened = visitor.get("/api/observatory/terrain/file?repo=side-project&path=src/app.ts")
    assert opened.status_code == 403 and "three" not in opened.get_data(as_text=True)
    # And the map a visitor does get — the one the mirror publisher fetches —
    # has no trace of it.
    body = visitor.get("/api/observatory/terrain?limit=all").get_data(as_text=True)
    assert "side-project" not in body and "src/app.ts" not in body


def test_a_build_survives_a_rebuild_and_is_forgotten_when_removed(client, project):
    """The SQL lab's rebuild button wipes the code-history tables and re-walks
    them; a build has to come back with everything else. Removing one drops
    its rows and leaves the folder exactly as it was."""
    _add(client, project)
    codestore.rebuild()
    assert codestore.repo_summary("side-project")["commits"] == 3

    assert client.delete("/api/observatory/terrain/builds/side-project").status_code == 200

    assert buildlist.builds() == []
    assert codestore.repo_summary("side-project")["commits"] == 0
    assert codestore.touches("side-project") == {}
    assert (project / "src" / "app.ts").is_file()
    assert client.get("/api/observatory/terrain?build=side-project").status_code == 404


def test_only_a_separate_git_folder_or_a_github_address_can_be_added(client, roots, project):
    plain = roots / "not-a-repo"
    plain.mkdir()
    inside_the_vault = _make_repo(roots / "vault" / "nested")
    for source in (
        plain,                                   # no history to map
        roots / "missing",                       # nothing there
        inside_the_vault,                        # the main map already covers it
        roots,                                   # would swallow the app and the vault
        "side-project",                          # not a full path
        "https://gitlab.com/owner/repo",         # not GitHub
        "https://github.com/owner",              # not a repo
        "--upload-pack=touch /tmp/pwned",        # an option, not an address
        "https://github.com/owner/repo --mirror",
    ):
        refused = _add(client, source)
        assert refused.status_code == 400, source
        assert refused.get_json()["error"]
    assert buildlist.builds() == []

    # The same folder twice is one build, not two.
    assert _add(client, project).status_code == 200
    assert _add(client, project).status_code == 400
    assert len(buildlist.builds()) == 1


def test_a_github_address_becomes_a_clone_in_the_clone_folder(client, roots, monkeypatch):
    """The address is normalised and the clone is started for exactly that
    repo, into the configured folder — and the build reads as cloning until
    its folder appears."""
    started = []

    def fake_clone(source, dest):
        started.append((source, Path(dest)))
        buildlist._clone_files(dest)["log"].parent.mkdir(parents=True, exist_ok=True)
        buildlist._clone_files(dest)["log"].write_text("")

    monkeypatch.setattr(buildlist, "start_clone", fake_clone)

    added = _add(client, "git@github.com:Some-Owner/My.Repo.git")

    assert added.status_code == 200
    build = added.get_json()["build"]
    assert build["id"] == "my-repo" and build["state"] == "cloning"
    assert build["source"] == "https://github.com/Some-Owner/My.Repo"
    assert started == [("https://github.com/Some-Owner/My.Repo", roots / "clones" / "my-repo")]
    # Its map is an empty one rather than an error while the clone is arriving.
    arriving = client.get("/api/observatory/terrain?build=my-repo")
    assert arriving.status_code == 200
    assert arriving.get_json()["repos"][0]["files"] == []


def _wait_for(build, wanted, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        current = buildlist.state(build)
        if current["state"] == wanted:
            return current
        time.sleep(0.05)
    return buildlist.state(build)


def test_a_clone_arrives_on_its_own_and_a_failed_one_says_why(roots, project):
    """The real clone, against a local repo standing in for GitHub: it runs
    detached, lands whole, and can then be mapped. One that can't be fetched
    ends as "failed" with git's own words, and never as a half-made folder."""
    dest = roots / "clones" / "copy"
    build = {"id": "copy", "name": "Copy", "root": dest, "source": str(project)}
    buildlist.start_clone(str(project), dest)
    assert _wait_for(build, "ready")["state"] == "ready"
    assert (dest / "src" / "app.ts").is_file()
    assert codestore.update([build]) == {"copy": 3}

    gone = roots / "clones" / "gone"
    broken = {"id": "gone", "name": "Gone", "root": gone,
              "source": str(roots / "no-such-repo")}
    buildlist.start_clone(broken["source"], gone)
    failed = _wait_for(broken, "failed")
    assert failed["state"] == "failed" and failed["detail"]
    assert not gone.exists()
