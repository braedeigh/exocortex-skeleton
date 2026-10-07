"""The desktop app's server (standalone_app.py, standalone_jobs.py,
scripts/standalone.py): started on an empty folder it answers the Observatory
and Terrain, refuses other sites, points the map and new sessions at the
person's project, and runs its timed jobs without cron — and with the setting
off, the live site's behaviour is what it was.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

import buildlist
import standalone_app
import standalone_jobs
import standalone_journal
import store
from routes import observatory
from scripts import run_detached

ROOT = Path(__file__).resolve().parents[1]
LOCAL = {"Host": "127.0.0.1:5123"}


@pytest.fixture
def standalone(data_dir, monkeypatch):
    """Standalone mode on, over an empty data folder, with nothing remembered
    from an earlier test."""
    monkeypatch.setenv("EXOCORTEX_STANDALONE", "1")
    monkeypatch.delenv("EXOCORTEX_STANDALONE_HELPERS", raising=False)
    monkeypatch.setattr(store, "CONTENT_DIR", data_dir / "content")
    # The interrupted-jobs sweep reads a module-level folder; without this the
    # heartbeat would read (and wake the sessions of) the machine's real jobs.
    monkeypatch.setattr(run_detached, "JOBS_DIR", data_dir / "jobs")
    standalone_app._history_loads.clear()
    standalone_app._version_cache.clear()
    return data_dir


@pytest.fixture
def client(standalone):
    return standalone_app.create_app().test_client()


@pytest.fixture
def code(tmp_path_factory):
    """Somewhere for the person's code that is not inside the data folder."""
    return tmp_path_factory.mktemp("code")


def make_repo(folder, files):
    """A real git repo with one commit per file, so there is history to load."""
    folder.mkdir(parents=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    subprocess.run(["git", "init", "-q", str(folder)], check=True, env=env)
    for name in files:
        (folder / name).write_text(f"{name}\n")
        subprocess.run(["git", "-C", str(folder), "add", name], check=True, env=env)
        subprocess.run(["git", "-C", str(folder), "commit", "-q", "-m", f"add {name}"],
                       check=True, env=env)
    return folder


def wait_for_project(client, seconds=30):
    """Poll the status door the way the first-run screen does, until the
    project is ready or failed."""
    deadline = time.time() + seconds
    while True:
        project = client.get("/api/standalone", headers=LOCAL).get_json()["project"]
        if project["state"] in ("ready", "failed") or time.time() > deadline:
            return project
        time.sleep(0.1)


def test_pages_and_data_answer_on_an_empty_folder_with_no_login(client):
    pages = ["/", "/observatory", "/terrain", "/terrain/files"]
    data = ["/api/observatory", "/api/observatory/terrain", "/api/observatory/flow",
            "/api/observatory/terrain/growth", "/api/observatory/terrain/builds",
            "/api/sessions", "/api/tabsets", "/api/spinoff/tree", "/api/sudo/requests",
            "/api/runqueue/headroom", "/api/features", "/api/standalone"]
    assert {path: client.get(path, headers=LOCAL).status_code
            for path in pages + data} == {path: 200 for path in pages + data}
    assert "window.STANDALONE = true" in client.get("/", headers=LOCAL).get_data(as_text=True)
    # What the desktop app leaves out isn't there: no login page, no service
    # worker, and a door from the rest of the app answers a JSON 404.
    assert client.get("/login", headers=LOCAL).status_code == 404
    assert client.get("/sw.js", headers=LOCAL).status_code == 404
    missing = client.get("/api/habits", headers=LOCAL)
    assert missing.status_code == 404 and "error" in missing.get_json()
    # An empty map and an empty roster, not this app's own code.
    assert client.get("/api/observatory/terrain", headers=LOCAL).get_json()["repos"] == []
    assert client.get("/api/tabsets", headers=LOCAL).get_json()["sets"][1]["sections"] == [
        "terrain", "activity"]


def test_a_page_on_another_site_cannot_reach_it(client):
    refused = [
        client.get("/api/observatory", headers={"Host": "evil.example"}),
        client.post("/api/standalone/stop-turns",
                    headers={**LOCAL, "Origin": "https://evil.example"}),
        client.post("/api/standalone/stop-turns", headers={**LOCAL, "Origin": "null"}),
        client.get("/api/observatory", headers={**LOCAL, "Sec-Fetch-Site": "cross-site"}),
    ]
    assert [response.status_code for response in refused] == [403, 403, 403, 403]
    own_page = client.post("/api/standalone/stop-turns",
                           headers={**LOCAL, "Origin": "http://127.0.0.1:5123"})
    assert own_page.status_code == 200 and own_page.get_json() == {"stopped": 0}


def test_the_chosen_folder_is_what_the_map_draws_and_where_sessions_stand(client, code):
    repo = make_repo(code / "my-project", ["one.py", "two.py"])
    chosen = client.post("/api/standalone/project", json={"path": str(repo)}, headers=LOCAL)
    assert chosen.status_code == 200
    project = wait_for_project(client)
    assert (project["state"], project["detail"], project["path"]) == (
        "ready", "2 commits", str(repo))
    drawn = client.get("/api/observatory/terrain?limit=all", headers=LOCAL).get_json()["repos"]
    assert [r["id"] for r in drawn] == [project["id"]]
    assert {f["path"] for f in drawn[0]["files"]} == {"one.py", "two.py"}
    # A new session stands in that folder and just acts, until the person
    # turns "ask first" on.
    profile = observatory._lane_profile("coding")
    assert (profile["cwd"], profile["act_gate"]) == (str(repo), False)
    changed = client.post("/api/standalone/settings", json={"ask_first": True}, headers=LOCAL)
    assert changed.get_json()["settings"] == {"ask_first": True, "idle_check": True}
    assert observatory._lane_profile("coding")["act_gate"] is True


def test_projects_are_separate_and_the_current_one_can_be_switched(client, code):
    first = make_repo(code / "first", ["a.py"])
    second = make_repo(code / "second", ["b.py"])
    for repo in (first, second):
        client.post("/api/standalone/project", json={"path": str(repo)}, headers=LOCAL)
        assert wait_for_project(client)["state"] == "ready"
    listed = client.get("/api/standalone", headers=LOCAL).get_json()["projects"]
    assert [(p["id"], p["current"]) for p in listed] == [("first", False), ("second", True)]
    # Choosing the same folder again reuses it, and switching back by id works.
    client.post("/api/standalone/project", json={"path": str(second)}, headers=LOCAL)
    switched = client.post("/api/standalone/project", json={"id": "first"}, headers=LOCAL)
    assert [(p["id"], p["current"]) for p in switched.get_json()["projects"]] == [
        ("first", True), ("second", False)]
    assert observatory._lane_profile("coding")["cwd"] == str(first)
    # Each keeps its own map.
    other = client.get("/api/observatory/terrain?build=second&limit=all", headers=LOCAL)
    assert {f["path"] for f in other.get_json()["repos"][0]["files"]} == {"b.py"}


def test_rooms_are_a_list_the_person_edits_and_sessions_follow_it(client, code):
    repo = make_repo(code / "roomy", ["a.py"])
    client.post("/api/standalone/project", json={"path": str(repo)}, headers=LOCAL)

    def ids(answer):
        return [room["id"] for room in answer.get_json()["rooms"]]

    assert client.get("/api/standalone/rooms", headers=LOCAL).get_json()["rooms"] == [
        {"id": "personal", "name": "Personal"}, {"id": "coding", "name": "Code"}]
    # A new room gets an id of its own — never one of the live site's fixed
    # rooms, even when it is named after one.
    added = client.post("/api/standalone/rooms", json={"name": "Fairy"}, headers=LOCAL)
    assert ids(added) == ["personal", "coding", "fairy-2"]
    renamed = client.post("/api/standalone/rooms/fairy-2", json={"name": "Garden"}, headers=LOCAL)
    assert renamed.get_json()["rooms"][2] == {"id": "fairy-2", "name": "Garden"}
    # A session can be started in it; it stands in the project. Personal
    # stands in the journal's folder, and neither is this app's own code.
    made = client.post("/api/observatory/conversations",
                       json={"lane": "fairy-2", "title": "in the garden"}, headers=LOCAL)
    assert made.status_code == 200, made.get_json()
    conv_id = made.get_json()["id"]
    index = store.read("bot_chats/index", {})
    assert (index[conv_id]["lane"], index[conv_id]["cwd"]) == ("fairy-2", str(repo))
    assert observatory._lane_profile("personal")["cwd"] == str(store.CONTENT_DIR)
    refused = client.post("/api/observatory/conversations", json={"lane": "nowhere"},
                          headers=LOCAL)
    assert refused.status_code == 400
    # Removing the room moves its session to the first room left; the last
    # room can't go.
    assert ids(client.delete("/api/standalone/rooms/fairy-2", headers=LOCAL)) == [
        "personal", "coding"]
    assert store.read("bot_chats/index", {})[conv_id]["lane"] == "personal"
    client.delete("/api/standalone/rooms/personal", headers=LOCAL)
    last = client.delete("/api/standalone/rooms/coding", headers=LOCAL)
    assert last.status_code == 400 and ids(
        client.get("/api/standalone/rooms", headers=LOCAL)) == ["coding"]


def test_a_download_goes_from_downloading_to_loading_to_ready(client, code, monkeypatch):
    source = make_repo(code / "upstream", ["readme.md", "app.py", "more.py"])

    def clone_by_hand(address, destination):
        # Stand in for the network: leave the marks a running clone leaves.
        buildlist._clone_files(destination)["log"].parent.mkdir(parents=True, exist_ok=True)
        buildlist._clone_files(destination)["log"].write_text("")

    monkeypatch.setattr(buildlist, "start_clone", clone_by_hand)
    started = client.post("/api/standalone/project",
                          json={"url": "https://github.com/someone/sample-repo"}, headers=LOCAL)
    project = started.get_json()["project"]
    assert (project["state"], project["ok"]) == ("downloading", False)
    # Downloads land inside the data folder, never beside the app's code.
    assert Path(project["path"]).parent == store.DATA_DIR / "projects"
    # The clone finishes: its folder appears, and asking again reads the history in.
    subprocess.run(["git", "clone", "-q", str(source), project["path"]], check=True)
    finished = wait_for_project(client)
    assert (finished["state"], finished["detail"]) == ("ready", "3 commits")


def test_the_apps_own_code_is_a_separate_download_never_the_running_copy(client, monkeypatch):
    asked = []
    monkeypatch.setattr(buildlist, "start_clone",
                        lambda address, destination: asked.append((address, destination)))
    offer = client.get("/api/standalone", headers=LOCAL).get_json()["own"]
    assert offer["available"] is True
    started = client.post("/api/standalone/project", json={"own": True}, headers=LOCAL)
    project = started.get_json()["project"]
    # This test runs from a git checkout of the app — the case where using the
    # running copy in place would be possible. It still downloads its own.
    assert [address for address, _ in asked] == [standalone_app.config.standalone_sample_repo()]
    assert Path(project["path"]).parent == store.DATA_DIR / "projects"
    assert Path(project["path"]) != Path(store.BUILD_DIR).resolve()
    # Asking twice doesn't download twice.
    client.post("/api/standalone/project", json={"own": True}, headers=LOCAL)
    assert len(asked) == 1 and len(buildlist.builds()) == 1


def test_a_persons_github_repos_can_be_listed_and_one_downloaded(client, monkeypatch):
    import urllib.error
    asked = []

    def github(url, timeout=15):
        asked.append(url)
        if "/users/nobody/" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
        return [{"name": "garden", "html_url": "https://github.com/someone/garden",
                 "description": None, "pushed_at": "2026-01-02T03:04:05Z"},
                {"name": "odd", "html_url": "https://elsewhere.example/someone/odd"}]

    monkeypatch.setattr(standalone_app, "_fetch_json", github)
    monkeypatch.setattr(buildlist, "start_clone", lambda address, destination: None)
    listed = client.get("/api/standalone/github-repos?user=@someone", headers=LOCAL).get_json()
    # Only addresses the download door will take are offered.
    assert listed == {"user": "someone", "repos": [{
        "name": "garden", "url": "https://github.com/someone/garden",
        "description": "", "updated": "2026-01-02T03:04:05Z"}]}
    picked = client.post("/api/standalone/project", json={"url": listed["repos"][0]["url"]},
                         headers=LOCAL)
    assert picked.status_code == 200 and picked.get_json()["project"]["id"] == "garden"
    # A name that can't be an account never reaches the network; a missing
    # account comes back as a sentence.
    bad = client.get("/api/standalone/github-repos?user=../etc", headers=LOCAL)
    missing = client.get("/api/standalone/github-repos?user=nobody", headers=LOCAL)
    assert (bad.status_code, missing.status_code) == (400, 400)
    assert "no account called nobody" in missing.get_json()["error"]
    assert len(asked) == 2


def test_refusals_come_back_as_a_sentence_not_a_crash(client, tmp_path, monkeypatch):
    plain_folder = tmp_path / "not-a-repo"
    plain_folder.mkdir()
    monkeypatch.setattr(standalone_app, "_program",
                        lambda name, binary=None: {"found": False, "bin": None, "version": None})
    bodies = [{"path": str(tmp_path / "nowhere")}, {"path": str(plain_folder)},
              {"url": "https://github.com/someone/sample-repo"}, {"id": "no-such"}, {}]
    answers = [client.post("/api/standalone/project", json=body, headers=LOCAL)
               for body in bodies]
    assert [a.status_code for a in answers] == [400] * len(bodies)
    assert all(isinstance(a.get_json()["error"], str) for a in answers)
    assert "git isn't installed" in answers[2].get_json()["error"]


def test_with_the_setting_off_the_live_site_is_unchanged(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_STANDALONE", raising=False)
    with pytest.raises(RuntimeError):
        standalone_app.create_app()
    assert [repo["id"] for repo in observatory._terrain_repos()] == ["skeleton", "vault"]
    profile = observatory._lane_profile("coding")
    assert (profile["cwd"], profile["act_gate"]) == (str(store.BUILD_DIR), False)
    from flask import Flask
    from routes import spa, tabsets
    app = Flask(__name__)
    spa.register(app)
    tabsets.register(app)
    assert "window.STANDALONE = false" in app.test_client().get("/").get_data(as_text=True)
    assert [s["id"] for s in app.test_client().get("/api/tabsets").get_json()["sets"]] == [
        "work", "life", "spare"]


# --- the journal and its Keeper --------------------------------------------------

def test_the_journal_works_from_an_empty_folder(client, standalone):
    today = time.strftime("%Y-%m-%d")
    assert 'window.STANDALONE_EXTRAS = ["journal"]' in client.get(
        "/", headers=LOCAL).get_data(as_text=True)
    # A card written from the page goes through the real card engine, which
    # the app finds at the journal folder's own path.
    added = client.post("/api/cards/add", headers=LOCAL,
                        json={"date": today, "position": "bottom", "body": "first words"})
    assert added.status_code == 200, added.get_json()
    cards = client.get(f"/api/cards/{today}", headers=LOCAL).get_json()["cards"]
    assert [card["body"].strip() for card in cards] == ["first words"]
    # Editing it works too (the engine is the app's current one, not a copy).
    edited = client.post("/api/cards/update", headers=LOCAL,
                         json={"id": cards[0]["id"], "body": "first words, corrected"})
    assert edited.status_code == 200, edited.get_json()
    # The day page is the rendered view of that card, and the day is listed.
    assert client.get("/api/journal/dates", headers=LOCAL).get_json()["dates"] == [today]
    page = client.get(f"/api/journal/{today}", headers=LOCAL).get_json()
    assert "first words, corrected" in page["content"] and page["next"] is None
    # The rest of what the Journal page reads answers on a new folder.
    doors = ["/journal", "/api/journal/search?q=words", "/api/people", "/api/threads",
             "/api/threads/tree", "/api/keeper/tree", f"/api/todos/cleared?date={today}",
             "/api/devnotes/journal", "/api/data"]
    assert {door: client.get(door, headers=LOCAL).status_code for door in doors} == {
        door: 200 for door in doors}
    # And the hourly job that copies cards into the database runs clean.
    assert standalone_jobs.run_job(["scripts/update_cards.py"]) == 0


def test_waking_the_keeper_opens_one_journaling_session_that_starts_with_setup(
        client, standalone, monkeypatch):
    sent = []
    monkeypatch.setattr(observatory, "begin_turn",
                        lambda conv_id, text, **_: sent.append((conv_id, text)) or {"ok": True})
    content = Path(store.CONTENT_DIR)
    wake_command = content / ".claude" / "commands" / "journalstart.md"
    before = client.get("/api/standalone/keeper", headers=LOCAL).get_json()
    assert before == {"folder": str(content), "setup_done": False, "keeper": None}

    woken = client.post("/api/standalone/keeper", headers=LOCAL).get_json()
    assert woken["created"] is True and sent == [(woken["keeper"], "/journalstart")]
    entry = store.read("bot_chats/index", {})[woken["keeper"]]
    # It journals, it is pinned in the Personal room, and it stands in the
    # journal's folder — where its manifest and its commands are.
    assert (entry["journal"], entry["pinned"], entry["lane"], entry["cwd"]) == (
        True, True, "personal", str(content))
    assert (content / "CLAUDE.md").is_file() and (content / "_system" / "stream.py").is_file()
    # On a new install the wake command carries the setup conversation.
    assert "First session: setup" in wake_command.read_text()
    # Waking again gives the same Keeper and sends nothing.
    again = client.post("/api/standalone/keeper", headers=LOCAL).get_json()
    assert (again["keeper"], again["created"]) == (woken["keeper"], False) and len(sent) == 1

    # Once the Keeper has written down who it is keeping for, setup is over:
    # the next start takes the section off, and never touches the manifest.
    manifest = (content / "CLAUDE.md").read_text().replace(
        standalone_journal.UNFILLED_HEADING, "## Who you're keeping for\n\nSomeone real.")
    (content / "CLAUDE.md").write_text(manifest)
    standalone_app.create_app()
    assert client.get("/api/standalone/keeper", headers=LOCAL).get_json()["setup_done"] is True
    assert "First session: setup" not in wake_command.read_text()
    assert (content / "CLAUDE.md").read_text() == manifest


# --- the timed jobs ------------------------------------------------------------

def test_each_job_runs_soon_after_start_and_then_on_its_own_interval():
    now = [0.0]
    asked = []
    scheduler = standalone_jobs.Scheduler(
        clock=lambda: now[0], runner=lambda command: asked.append(command) or 0)
    names = [job["name"] for job in scheduler.jobs]
    # The job that spends Claude usage unasked waits behind the helpers switch.
    assert "session titles" not in names
    assert "session titles" in [job["name"] for job in
                                standalone_jobs.Scheduler(helpers=True, clock=lambda: 0.0).jobs]
    assert scheduler.run_pending() == []          # nothing in the first instant
    now[0] = 60.0
    assert scheduler.run_pending() == names       # every job once, soon after start
    now[0] = 60.0 + standalone_jobs.MINUTE
    assert scheduler.run_pending() == ["heartbeat", "run queue"]   # the minute jobs only
    now[0] = 60.0 + standalone_jobs.HOUR
    assert scheduler.run_pending() == names       # the hourly ones come round again
    assert scheduler.runs["footprints"] == 2 and len(asked) == sum(scheduler.runs.values())


def test_only_one_server_per_data_folder_runs_the_jobs(tmp_path):
    first, second = standalone_jobs.Scheduler(), standalone_jobs.Scheduler()
    try:
        assert first.start(tmp_path) is True
        assert second.start(tmp_path) is False
    finally:
        first.stop()
        second.stop()
    third = standalone_jobs.Scheduler()
    try:
        assert third.start(tmp_path) is True      # the lock went with the first
    finally:
        third.stop()


def test_the_heartbeat_and_a_cron_script_run_on_an_empty_folder(standalone, monkeypatch):
    for _name, _every, command, _helpers in standalone_jobs.JOBS:
        script = [part for part in command if part.endswith(".py")]
        assert all((ROOT / part).is_file() for part in script), command
    outcome = standalone_jobs.minute_tick()
    assert not [step for step, result in outcome.items()
                if isinstance(result, str) and result.startswith("failed")], outcome
    assert "room helper" not in outcome           # helpers are off by default
    # The day-idle check is the other way round: on until the person turns it off.
    assert "idle check" in outcome
    standalone_app.create_app().test_client().post(
        "/api/standalone/settings", json={"idle_check": False}, headers=LOCAL)
    assert "idle check" not in standalone_jobs.minute_tick()
    # A real cron script, run the way the scheduler runs it: its own process,
    # finding the data folder through the environment, with no cron involved.
    monkeypatch.setenv("EXOCORTEX_DATA_DIR", str(standalone))
    assert standalone_jobs.run_job(["scripts/extract_footprints.py"]) == 0
    assert (standalone / "bot_chats" / "footprints.json").is_file()


# --- the start command -----------------------------------------------------------

def test_one_command_starts_it_on_a_folder_it_makes_and_stops_with_its_window(tmp_path):
    data = tmp_path / "fresh" / "data"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("EXOCORTEX_") or key in (
               "EXOCORTEX_STORE_STATS_OFF", "EXOCORTEX_CLAUDE_BIN")}
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts" / "standalone.py"), "--port", "0",
         "--data", str(data), "--exit-with-stdin", "--no-jobs"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=env, text=True)
    try:
        ready = json.loads(server.stdout.readline())
        assert ready["ready"] is True and ready["data_dir"] == str(data)
        assert ready["url"] == f"http://127.0.0.1:{ready['port']}"
        with urllib.request.urlopen(ready["url"] + "/api/standalone", timeout=30) as answer:
            status = json.load(answer)
        assert (status["standalone"], status["data_dir"], status["project"]["state"]) == (
            True, str(data), "none")
        # Everything it wrote is inside the folder it was given.
        assert (data / "content").is_dir() and (data / "jobs").is_dir()
        # The window goes away: its end of stdin closes, and the server stops.
        server.stdin.close()
        assert server.wait(timeout=20) == 0
    finally:
        if server.poll() is None:
            server.kill()


def test_a_seeded_install_has_its_first_project_ready_with_no_download(tmp_path, code):
    upstream = make_repo(code / "app-source", ["server.py", "page.tsx"])
    seed, data = tmp_path / "seed", tmp_path / "data"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("EXOCORTEX_") or key in (
               "EXOCORTEX_STORE_STATS_OFF", "EXOCORTEX_CLAUDE_BIN")}
    # Packaging time: the seed is made once, from a clone that needs no network.
    made = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "standalone_seed.py"),
         "--out", str(seed), "--from", str(upstream)],
        capture_output=True, text=True, env=env)
    assert made.returncode == 0, made.stderr
    described = json.loads(made.stdout)
    assert described["commits"] == 2 and (seed / "projects" / described["id"] / ".git").is_dir()

    def first_status():
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts" / "standalone.py"), "--port", "0",
             "--data", str(data), "--exit-with-stdin", "--no-jobs"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**env, "EXOCORTEX_STANDALONE_SEED": str(seed)}, text=True)
        try:
            url = json.loads(server.stdout.readline())["url"]
            with urllib.request.urlopen(url + "/api/standalone", timeout=30) as answer:
                return json.load(answer)
        finally:
            server.stdin.close()
            server.wait(timeout=20)

    # First start on a new folder: the very first ask finds the project
    # current and ready, standing inside the data folder.
    status = first_status()
    assert (status["project"]["state"], status["project"]["detail"]) == ("ready", "2 commits")
    assert status["project"]["path"] == str(data / "projects" / described["id"])
    assert [(p["id"], p["current"]) for p in status["projects"]] == [(described["id"], True)]
    # A second start leaves a used folder alone: still one project, and the
    # database was not copied over.
    (data / "marker").write_text("mine")
    database = (data / "exo.db").stat().st_ino
    again = first_status()
    assert len(again["projects"]) == 1 and (data / "exo.db").stat().st_ino == database
