"""Terrain builds — the owner's other git folders, each read as its own map
and its own report (buildlist.py, routes/terrain_builds.py, and the `?build=`
door in routes/terrain.py).

What has to hold, and would break without anyone noticing:

  - A build reads as a report: its commits, its line counts, the sessions
    that worked in it — and its map carries only that folder.
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
