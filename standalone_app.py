"""The desktop app's server: only the Observatory and Terrain, for one person
on their own computer.

**What this does, in plain English.** The live site is built by `server.py`,
which loads every page the app has, checks a password, and expects cron and a
system service around it. This file builds a much smaller app out of the same
route modules — just the agent chat (the Observatory) and the code map
(Terrain) — for a machine that has none of that:

  - no login. It listens on this computer only, and `_guard` below refuses
    anything that isn't this computer's own browser talking to it;
  - no password file, no proxy, no gunicorn;
  - projects (`project_*` below): each is one code folder with its own map —
    this app's own code (downloaded, a copy of its own) is offered as the
    first, the person's own folder is another. One is CURRENT: the main map draws it and new sessions stand in
    it. The rest are a tap away in Terrain's Builds room;
  - a few doors of its own under /api/standalone, which the first-run screen
    reads to learn whether Claude Code and git are there and to pick or
    download that folder.

It is only ever built when the standalone setting is on
(`config.standalone()`), which the start command `scripts/standalone.py` sets.
`server.py` never imports this file, so the live site is untouched.

Touches: `routes/*` (the modules registered in `ROUTE_MODULES`),
`buildlist.py` (the chosen folder is a "build"; it also does the download),
`codestore.py` (reads the folder's commit history into the database),
`routes/observatory.py` (asks `project_repos` / `project_cwd` here),
`standalone_jobs.py` (the timed jobs), `docs/standalone.md` (the whole design
and the list of what the desktop app keeps, replaces and drops).

Prompt that produced this file: "What would it take to turn the observatory
and terrain into a downloadable desktop app?" — and, for the download door: "I
will also need something to download a repo with their commit data so they can
visual something right off the bat".
"""
from pathlib import Path
from urllib.parse import urlsplit
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

from flask import Flask, jsonify, request

import buildlist
import codestore
import config
import features
import lanes
import schemas
import store
from routes import (
    branches, chat_search, creek, helpers, observatory, pond, run_queue,
    sandbox, spa, spinoff, sqlab, sudo, swarms, tabsets, terminal, terrain,
    terrain_builds, terrain_map, terrain_mirror, terrain_tables, token_burn,
    usage, worktree_map,
)

# Every route module the desktop app serves, in the order they are registered.
# The Observatory and Terrain themselves, then the smaller doors their pages
# read (the swarm view, the run queue's memory meter, the SQL room, usage).
# `terminal` is here for one door only, /api/sessions, which the roster polls.
# Anything not on this list answers 404.
ROUTE_MODULES = (
    spa, observatory, terrain, terrain_tables, terrain_builds, terrain_map,
    terrain_mirror, swarms, spinoff, run_queue, sudo, usage, token_burn,
    chat_search, sqlab, sandbox, creek, pond, tabsets, branches, worktree_map,
    helpers, terminal,
)

# The names this computer answers to. A request naming any other host, or sent
# by a page from any other site, is refused (see _guard).
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

# Where the choice of project is kept: a small JSON file in the data folder.
_SETTINGS = "standalone"

# How long a looked-up program version is remembered. Asking `claude
# --version` starts a process, and the first-run screen polls every 2 seconds.
_VERSION_TTL_SEC = 60
_version_cache = {}

# History loads in flight or finished, by build id: {"state": "loading" |
# "done" | "failed", "error": str | None}. In memory only — after a restart
# the database itself says whether a folder's history is in (see
# project_status).
_history_loads = {}
_history_lock = threading.Lock()


# --- the project: the one code folder the desktop app is about ---------------

def project():
    """The current project as a build ({id, name, root, source, …}), or None
    when nobody has chosen one yet or it has been taken off the list."""
    chosen = store.read(_SETTINGS, {}).get("project")
    return buildlist.find(chosen) if isinstance(chosen, str) else None


def project_repos():
    """The folders Terrain's main map draws in standalone mode: the chosen
    project alone, and only once its folder is there. Empty before that, so
    the map draws nothing rather than this app's own code."""
    build = project()
    if build is None or not Path(build["root"]).is_dir():
        return ()
    return ({"id": build["id"], "name": build["name"], "root": Path(build["root"])},)


def project_cwd():
    """Where a new session stands in standalone mode: the project folder, or —
    before one is chosen — an empty `workspace` folder in the data folder, so
    an agent is never started inside this app's own code."""
    repos = project_repos()
    if repos:
        return str(repos[0]["root"])
    workspace = store.DATA_DIR / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return str(workspace)


def journal_cwd():
    """Where a session in the Personal room stands: the journal's own folder
    (the content folder inside the data folder), made if it isn't there. It
    is where the Keeper lives, so the journal's files are right at hand —
    and, like every room here, it is never this app's own code."""
    folder = Path(store.CONTENT_DIR)
    folder.mkdir(parents=True, exist_ok=True)
    return str(folder)


# --- rooms: the person's own list ---------------------------------------------

# A room's id: short, lower-case, safe in a web address.
_ROOM_ID_RE = re.compile(r"[^a-z0-9]+")
_ROOM_NAME_MAX = 40


def rooms():
    """The rooms, in the order they are shown: [{id, name}] (lanes.py reads
    the same list, so the routes accept exactly these)."""
    return lanes.standalone_rooms()


def _room_name(name):
    """A room's name as it will be kept, or ValueError with a sentence."""
    name = " ".join(str(name).split()) if isinstance(name, str) else ""
    if not name:
        raise ValueError("a room needs a name")
    if len(name) > _ROOM_NAME_MAX:
        raise ValueError(f"a room's name can be at most {_ROOM_NAME_MAX} characters")
    return name


def add_room(name):
    """Add a room on the end of the list and return the list. The id is made
    from the name, with a number on the end when that id is taken — by
    another room, or by one of the live site's fixed rooms, whose ids carry
    behaviour of their own there (lanes.LANES)."""
    name = _room_name(name)
    with store.mutate(_SETTINGS, {}) as settings:
        current = rooms()
        taken = {room["id"] for room in current} | set(lanes.LANES)
        base = _ROOM_ID_RE.sub("-", name.lower()).strip("-")[:30] or "room"
        room_id, number = base, 2
        while room_id in taken:
            room_id, number = f"{base}-{number}", number + 1
        settings["rooms"] = current + [{"id": room_id, "name": name}]
    return rooms()


def rename_room(room_id, name):
    """Give a room a new name (its id, and so its sessions, stay) and return
    the list. ValueError when there is no such room."""
    name = _room_name(name)
    with store.mutate(_SETTINGS, {}) as settings:
        current = rooms()
        if not any(room["id"] == room_id for room in current):
            raise ValueError("there is no room with that id")
        settings["rooms"] = [{**room, "name": name} if room["id"] == room_id else room
                             for room in current]
    return rooms()


def remove_room(room_id):
    """Take a room off the list and return the list. Its sessions move to the
    first room left — they keep the folder they were started in, only the
    room they are shown in changes. ValueError for the last room, or one
    that isn't there."""
    with store.mutate(_SETTINGS, {}) as settings:
        current = rooms()
        if not any(room["id"] == room_id for room in current):
            raise ValueError("there is no room with that id")
        kept = [room for room in current if room["id"] != room_id]
        if not kept:
            raise ValueError("the last room can't be removed")
        settings["rooms"] = kept
    if store.read("bot_chats/index", {}):
        with store.mutate("bot_chats/index", {}) as index:
            for entry in index.values():
                if isinstance(entry, dict) and entry.get("lane") == room_id:
                    entry["lane"] = kept[0]["id"]
    return rooms()


def _load_history(build):
    """Read one folder's whole commit history into the database, and write
    down how it went. Runs in a thread of its own: a big repo takes longer
    than the first-run screen should wait on one request."""
    repo = {"id": build["id"], "name": build["name"], "root": build["root"]}
    try:
        codestore.update([repo])
        outcome = {"state": "done", "error": None}
    except Exception as error:   # the screen shows the sentence; nothing else is listening
        outcome = {"state": "failed", "error": f"could not read its history: {error}"}
    with _history_lock:
        _history_loads[build["id"]] = outcome


def _start_history_load(build):
    """Start the history load for a build unless one is already running."""
    with _history_lock:
        if _history_loads.get(build["id"], {}).get("state") == "loading":
            return
        _history_loads[build["id"]] = {"state": "loading", "error": None}
    threading.Thread(target=_load_history, args=(build,), daemon=True).start()


def project_status(build="current"):
    """Where a project stands (the current one unless handed another), in the
    one shape the first-run screen reads: {path, ok, state, detail, error,
    id, name}.

    state is none (nothing chosen), downloading (git clone is running),
    loading (its commit history is being read in), ready (Terrain will draw
    it) or failed (`error` says why). Asking is what moves it along: the
    first ask after a download finishes starts the history load."""
    if build == "current":
        build = project()
    if build is None:
        return {"path": None, "ok": False, "state": "none", "detail": "",
                "error": None, "id": None, "name": None}
    out = {"path": str(build["root"]), "ok": False, "state": "failed", "detail": "",
           "error": None, "id": build["id"], "name": build["name"]}
    on_disk = buildlist.state(build)
    if on_disk["state"] == "cloning":
        return {**out, "state": "downloading",
                "detail": f"Downloading {build.get('source') or build['name']}"}
    if on_disk["state"] != "ready":
        return {**out, "error": on_disk["detail"] or "the folder is not there"}
    out["ok"] = True
    # The folder is there. Its history is in when a load finished in this
    # process, or when the database already holds commits for it (a restart).
    with _history_lock:
        load = dict(_history_loads.get(build["id"]) or {})
    if load.get("state") == "failed":
        return {**out, "error": load["error"]}
    commits = codestore.repo_summary(build["id"])["commits"]
    if load.get("state") == "done" or (not load and commits):
        return {**out, "state": "ready", "detail": f"{commits:,} commits"}
    if not load:
        _start_history_load(build)
    return {**out, "state": "loading", "detail": "Reading its commit history"}


def projects():
    """Every project, in the order it was added, each as project_status gives
    it plus `current`. The list is the builds list (buildlist.py): a project
    and a build are the same thing, so each has its own map in Terrain."""
    current = project()
    return [{**project_status(build), "current": bool(current and build["id"] == current["id"])}
            for build in buildlist.builds()]


def choose_existing(build_id):
    """Make a project already on the list the current one. Raises ValueError
    when there is no such project."""
    build = buildlist.find(build_id) if isinstance(build_id, str) else None
    if build is None:
        raise ValueError("there is no project with that id")
    _choose(build)


def ask_first():
    """Do new sessions ask before anything they can't undo? Off unless the
    person turned it on (POST /api/standalone/settings): the owner's call is
    that the desktop app's agents just act, and people are told so and can
    change it. routes/observatory.py reads this when it makes a session."""
    return store.read(_SETTINGS, {}).get("ask_first") is True


def idle_check():
    """Is a session that has sat idle for a day asked whether it is done? On
    unless the person turned it off (POST /api/standalone/settings). The
    question starts a short turn of its own, which is why it has a switch.
    The heartbeat reads this (standalone_jobs.minute_tick)."""
    return store.read(_SETTINGS, {}).get("idle_check") is not False


def _choose(build):
    """Make `build` the project and start reading its history if it's there."""
    with store.mutate(_SETTINGS, {}) as settings:
        settings["project"] = build["id"]
    if Path(build["root"]).is_dir():
        _start_history_load(build)


def choose_folder(path):
    """Make a folder already on this computer the project. Raises ValueError
    with a sentence the screen can show. A folder chosen before is reused, not
    added twice."""
    root = Path(str(path).strip()).expanduser()
    existing = next((build for build in buildlist.builds()
                     if Path(build["root"]) == root), None)
    _choose(existing or buildlist.add_folder(root))


def choose_download(url):
    """Download a repo from its address, with its full commit history, and
    make it the project. Raises ValueError with a sentence the screen can
    show. The download runs on in its own process (buildlist.start_clone);
    project_status reports it."""
    if not _program("git")["found"]:
        raise ValueError("git isn't installed on this computer, so nothing can be downloaded")
    # Keep downloads in the data folder. buildlist's own default is a folder
    # beside the app's code, which a packaged app can't write to.
    with store.mutate("terrain_builds", {}) as configured:
        configured.setdefault("clone_dir", str(store.DATA_DIR / "projects"))
    source = None
    parsed = buildlist.parse_github(str(url).strip())
    if parsed:
        source = f"https://github.com/{parsed[0]}/{parsed[1]}"
    existing = next((build for build in buildlist.builds()
                     if source and build.get("source") == source), None)
    _choose(existing or buildlist.add_github(url))


# A GitHub account name: letters, digits and single hyphens, up to 39 long.
_GITHUB_USER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")
_GITHUB_API = "https://api.github.com"


def _fetch_json(url, timeout=15):
    """GET one address and read the answer as JSON. Its own function so a
    test can stand in for the network."""
    asked = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "exocortex-desktop"})
    with urllib.request.urlopen(asked, timeout=timeout) as answer:
        return json.load(answer)


def github_repos(user):
    """The public repos of one GitHub account, most recently changed first:
    [{name, url, description, updated}] — the person's "library" to pick a
    project from. No sign-in, so only what GitHub shows anyone, and at most
    the first hundred. Raises ValueError with a sentence the screen can show.

    Prompt that produced it: "paste an address or point to one in your
    library maybe" — the library being their own GitHub repos, listed after
    they type their username."""
    user = str(user or "").strip().lstrip("@")
    if not _GITHUB_USER_RE.match(user):
        raise ValueError("that isn't a GitHub username")
    try:
        listed = _fetch_json(f"{_GITHUB_API}/users/{user}/repos?per_page=100&sort=pushed&type=owner")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise ValueError(f"GitHub has no account called {user}") from None
        if error.code in (403, 429):
            raise ValueError("GitHub is refusing more lookups for now — try again in a "
                             "few minutes, or paste the repo's address") from None
        raise ValueError(f"GitHub answered with an error ({error.code})") from None
    except (OSError, ValueError):
        raise ValueError("couldn't reach GitHub — check the connection, "
                         "or paste the repo's address") from None
    return [{"name": repo["name"], "url": repo["html_url"],
             "description": repo.get("description") or "",
             "updated": repo.get("pushed_at") or ""}
            for repo in listed if isinstance(repo, dict)
            and isinstance(repo.get("name"), str) and isinstance(repo.get("html_url"), str)
            and buildlist.parse_github(repo["html_url"])]


def adopt_seed():
    """Put the seeded project on the list and make it current, once. True
    when it did.

    The start command copies the seed's files into a new data folder
    (scripts/standalone.py place_seed) and leaves seed.json beside them; this
    is the half that needs the app: the folder becomes a project like any
    other, with the published address as its source, so "start with this
    app's own code" finds it already here instead of downloading it again.
    Its history is already in the database, so it reads as ready at once.
    seed.json is renamed afterwards so this happens one time only."""
    note = store.DATA_DIR / "seed.json"
    try:
        seed = json.loads(note.read_text())
        entry = {"id": seed["id"], "name": seed["name"], "source": seed["source"],
                 "root": str(store.DATA_DIR / "projects" / seed["id"]),
                 "added": observatory._now()}
    except (OSError, ValueError, KeyError, TypeError):
        return False
    if not Path(entry["root"]).is_dir():
        return False
    with store.mutate("terrain_builds", {}) as configured:
        configured.setdefault("clone_dir", str(store.DATA_DIR / "projects"))
    if buildlist.find(entry["id"]) is None:
        buildlist._append(entry)
    with store.mutate(_SETTINGS, {}) as settings:
        settings.setdefault("project", entry["id"])
    note.replace(note.with_name("seed.adopted.json"))
    return True


def own_code():
    """Whether "start with this app's own code" can be offered, and how:
    {available, name, how}. It is always a download of the published repo
    (config.standalone_sample_repo) into a project folder of its own — never
    the copy of the app that is running, even when that copy is a git
    checkout — so every project is separate and an agent working on "the
    app's code" can't change the app underneath itself. `how` is "download",
    or None when the address has been blanked."""
    name = config.get_profile()["app_name"]
    if config.standalone_sample_repo():
        return {"available": True, "name": name, "how": "download"}
    return {"available": False, "name": name, "how": None}


def choose_own():
    """Make this app's own code the project, by downloading it. Raises
    ValueError with a sentence the screen can show when it can't be offered
    or the download can't start."""
    if not own_code()["available"]:
        raise ValueError("this copy of the app has no address to download its own code from")
    choose_download(config.standalone_sample_repo())


# --- what the first-run screen asks about this computer ----------------------

def _program(name, binary=None):
    """Is a program installed, and which version: {found, bin, version}.

    A cache that expires after a minute — finding the version means starting
    the program, and the screen asks every two seconds."""
    binary = binary or name
    cached = _version_cache.get(name)
    if cached and time.monotonic() - cached["at"] < _VERSION_TTL_SEC and cached["binary"] == binary:
        return cached["value"]
    path = shutil.which(binary)
    version = None
    if path:
        try:
            done = subprocess.run([path, "--version"], capture_output=True, text=True,
                                  timeout=10, stdin=subprocess.DEVNULL)
            version = (done.stdout or done.stderr).strip().splitlines()[0][:80] or None
        except (OSError, subprocess.SubprocessError, IndexError):
            version = None
    value = {"found": bool(path), "bin": path, "version": version}
    _version_cache[name] = {"at": time.monotonic(), "binary": binary, "value": value}
    return value


def _claude_signed_in():
    """True, False, or None when it can't be told.

    Claude Code keeps its login in a file on Linux, so there a missing file
    means signed out. On a Mac the login is in the system keychain instead,
    which this doesn't read — the honest answer there is "can't tell". An API
    key in the environment counts as signed in on either."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    try:
        saved = json.loads((home / ".credentials.json").read_text())
        return bool(isinstance(saved, dict) and saved.get("claudeAiOauth"))
    except FileNotFoundError:
        return False if os.uname().sysname == "Linux" else None
    except (OSError, ValueError):
        return None


def live_turns():
    """The conversations with a turn running right now."""
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        return []
    return [conv_id for conv_id, entry in index.items()
            if isinstance(entry, dict) and observatory._effective_running(conv_id, entry)]


def stop_turns():
    """Ask every running turn to stop, the way the Stop button does: the flag
    goes in the index and each turn's own process (scripts/turn_host.py) sees
    it within a couple of seconds. Returns how many were asked."""
    running = live_turns()
    if not running:
        return 0     # and on a brand-new folder there is no index to open yet
    with store.mutate("bot_chats/index", {}) as index:
        for conv_id in running:
            entry = index.get(conv_id)
            if isinstance(entry, dict) and entry.get("running"):
                entry["stop_requested"] = observatory._now()
    return len(running)


def status():
    """Everything GET /api/standalone answers. `ready` is the first-run
    screen's "all set": a project Terrain can draw, Claude Code installed,
    and not known to be signed out."""
    claude = {**_program("claude", observatory.CLAUDE_BIN), "signed_in": _claude_signed_in()}
    chosen = project_status()
    return {
        "standalone": True,
        "version": config.APP_VERSION,
        "data_dir": str(store.DATA_DIR),
        "claude": claude,
        "git": _program("git"),
        "project": chosen,
        "projects": projects(),
        "settings": {"ask_first": ask_first(), "idle_check": idle_check()},
        "rooms": rooms(),
        "own": {key: own_code()[key] for key in ("available", "name")},
        "live_turns": len(live_turns()),
        "helpers": config.standalone_helpers(),
        "ready": (chosen["state"] == "ready" and claude["found"]
                  and claude["signed_in"] is not False),
    }


# --- the app ------------------------------------------------------------------

def _loopback(host):
    """Is this host name (from a Host or Origin header) this computer?"""
    return (host or "").strip("[]").lower() in _LOOPBACK_HOSTS


def _guard():
    """Refuse any request that isn't this computer's own page talking to it.

    There is no login here, and these doors can start an agent that runs
    commands, so the server must not be reachable by a web page the person
    merely visits. Two checks, both on headers a page cannot forge:
      - the Host must be this computer's name. That stops "DNS rebinding",
        where an outside site's name is pointed at 127.0.0.1;
      - a request a browser marks as coming from another site (its Origin, or
        Sec-Fetch-Site: cross-site) is refused. That stops a page on another
        site posting to these doors ("cross-site request forgery").
    Everything that passes is the owner: view_mode is always "authed"."""
    if not _loopback(urlsplit(f"//{request.host}").hostname):
        return jsonify({"error": "this server only answers on this computer"}), 403
    origin = request.headers.get("Origin")
    if origin and origin != "null" and not _loopback(urlsplit(origin).hostname):
        return jsonify({"error": "cross-site request refused"}), 403
    if origin == "null" and request.method not in ("GET", "HEAD", "OPTIONS"):
        return jsonify({"error": "cross-site request refused"}), 403
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        return jsonify({"error": "cross-site request refused"}), 403
    request.view_mode = "authed"
    return None


def create_app():
    """Build the desktop app's Flask app. Refuses to unless the standalone
    setting is on, so nothing can serve these unguarded-by-password doors by
    importing this file on the live site."""
    if not config.standalone():
        raise RuntimeError("standalone_app is only for EXOCORTEX_STANDALONE=1")
    adopt_seed()
    app = Flask(__name__)
    app.before_request(_guard)
    for module in ROUTE_MODULES:
        module.register(app)
    schemas.install_error_handler(app)

    @app.errorhandler(404)
    def not_found(error):
        # An /api/ door this app doesn't have answers in JSON, so the page's
        # fetch code reads a plain "not here" instead of choking on HTML.
        if request.path.startswith("/api/"):
            return jsonify({"error": "not part of the desktop app"}), 404
        return "Not found", 404

    @app.route("/api/features")
    def features_snapshot():
        # Same read-only answer server.py gives: which surfaces are on.
        return jsonify(features.snapshot())

    @app.route("/api/standalone")
    def standalone_status():
        return jsonify(status())

    @app.route("/api/standalone/project", methods=["POST"])
    def standalone_project():
        """Choose the project: {"path": "/abs/folder"} for one already here,
        {"url": "https://github.com/owner/repo"} to download one, or
        {"own": true} for this app's own code, or {"id": "…"} to switch to
        one already on the list. Answers
        with the same payload as GET /api/standalone, or 400 and a sentence."""
        data = request.get_json(silent=True) or {}
        path, url = data.get("path"), data.get("url")
        try:
            if data.get("own") is True:
                choose_own()
            elif data.get("id"):
                choose_existing(data["id"])
            elif isinstance(url, str) and url.strip():
                choose_download(url)
            elif isinstance(path, str) and path.strip():
                choose_folder(path)
            else:
                raise ValueError("give a folder's path or a repo's address")
        except ValueError as refusal:
            return jsonify({"error": str(refusal)}), 400
        return jsonify(status())

    @app.route("/api/standalone/settings", methods=["POST"])
    def standalone_settings():
        """Change the desktop app's own settings, one or both at a time:
        {"ask_first": bool} — whether NEW sessions ask before anything they
        can't undo; {"idle_check": bool} — whether a session idle for a day
        is asked if it is done. Answers with the same payload as
        GET /api/standalone."""
        data = request.get_json(silent=True) or {}
        changes = {key: data[key] for key in ("ask_first", "idle_check") if key in data}
        if not changes or not all(isinstance(value, bool) for value in changes.values()):
            return jsonify({"error": "ask_first and idle_check must be true or false"}), 400
        with store.mutate(_SETTINGS, {}) as settings:
            settings.update(changes)
        return jsonify(status())

    @app.route("/api/standalone/rooms", methods=["GET", "POST"])
    def standalone_rooms():
        """The rooms, as {"rooms": [{id, name}]} in the order they are shown.
        POST {"name": "…"} adds one. A refusal is 400 and a sentence."""
        if request.method == "POST":
            try:
                add_room((request.get_json(silent=True) or {}).get("name"))
            except ValueError as refusal:
                return jsonify({"error": str(refusal)}), 400
        return jsonify({"rooms": rooms()})

    @app.route("/api/standalone/rooms/<room_id>", methods=["POST", "DELETE"])
    def standalone_room(room_id):
        """POST {"name": "…"} renames a room; DELETE removes it and moves its
        sessions to the first room left. Both answer {"rooms": […]}."""
        try:
            if request.method == "DELETE":
                remove_room(room_id)
            else:
                rename_room(room_id, (request.get_json(silent=True) or {}).get("name"))
        except ValueError as refusal:
            return jsonify({"error": str(refusal)}), 400
        return jsonify({"rooms": rooms()})

    @app.route("/api/standalone/folders")
    def standalone_folders():
        """The folders inside ?path= (the home folder when it's left out), so
        the page can offer a folder picker — a web page can't get a full path
        out of the browser's own. Names only, hidden folders left out."""
        raw = (request.args.get("path") or "").strip()
        folder = Path(raw).expanduser() if raw else Path.home()
        if not folder.is_absolute() or not folder.is_dir():
            return jsonify({"error": "no folder at that path"}), 400
        try:
            names = sorted((child.name for child in folder.iterdir()
                            if child.is_dir() and not child.name.startswith(".")),
                           key=str.lower)
        except OSError:
            return jsonify({"error": "that folder can't be read"}), 400
        return jsonify({"path": str(folder),
                        "parent": str(folder.parent) if folder.parent != folder else None,
                        "folders": names,
                        "git": buildlist.is_git_repo(folder)})

    @app.route("/api/standalone/github-repos")
    def standalone_github_repos():
        """?user=NAME → {"user", "repos": [{name, url, description, updated}]}:
        that account's public repos, for picking one to download. Each `url`
        is what POST /api/standalone/project takes as {"url"}."""
        try:
            return jsonify({"user": (request.args.get("user") or "").strip().lstrip("@"),
                            "repos": github_repos(request.args.get("user"))})
        except ValueError as refusal:
            return jsonify({"error": str(refusal)}), 400

    @app.route("/api/standalone/stop-turns", methods=["POST"])
    def standalone_stop_turns():
        """Stop every running agent turn — what the window calls before it
        quits, if the person chose to stop their agents."""
        return jsonify({"stopped": stop_turns()})

    return app
