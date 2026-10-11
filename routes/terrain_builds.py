"""Terrain builds API — the doors behind the Builds room: the list of the
owner's other git folders, adding and removing one, and one build's report.

A build is a git folder that isn't part of this system — a project built in
its own directory, or a repo cloned from GitHub (buildlist.py owns the list and
the cloning). Terrain reads each one the way it reads the app code: its own
map, served by routes/terrain.py at `GET /api/observatory/terrain?build=<id>`,
and beside the map a written REPORT of what happened in it — a few summary
numbers, the sessions that worked in it, and its commits newest first. That
report is what this module builds.

The endpoints:
  GET    /api/observatory/terrain/builds               every build, with its state and summary
  POST   /api/observatory/terrain/builds               add one: {source: a folder path or a GitHub address}
  DELETE /api/observatory/terrain/builds/<id>          take one off the list (the folder stays)
  POST   /api/observatory/terrain/builds/<id>/refresh  pull a clone up to date
  GET    /api/observatory/terrain/builds/<id>/report   summary, sessions, commits
  GET    /api/observatory/terrain/report               the same report for the main map's own folders

OWNER ONLY, all of it. None of these paths is in public_config.PUBLIC_PATHS,
so the site's gate answers a visitor 401 before a handler runs; each handler
also refuses a visitor itself, so the answer doesn't rest on one list staying
right.

Touches: `buildlist.py` (the list, clone state, pull), `codestore.py` (each
build's commits, indexed under its id), `sqlstore.py` (the
`session_last_summary` view each session's summary is read from), `routes/terrain.py` (the per-build map
payload this report's session list is read from, and its cache).

Prompt that produced this file: "I want to be able to view other folders in my
terrain view so I can basically see a report of what happened … port any repo
into it from GitHub and see when it was built or edited. And I can view all my
builds in here separately."
"""
from flask import jsonify, request

import buildlist
import codestore
import config
import sqlstore
from routes import observatory, terrain

# The most commits one report carries. A build with more says so through
# `commits_total`, and the list holds the newest.
_REPORT_COMMITS_MAX = 2000


def _repo(build):
    """A build in the {id, name, root} shape the code-history walker takes."""
    return {"id": build["id"], "name": build["name"], "root": build["root"]}


def _summary(build):
    """One build's summary numbers, or None when the tables can't say. The
    report and the list are derived data — a database hiccup is an empty
    line on a card, never a 500."""
    try:
        return codestore.repo_summary(build["id"])
    except Exception:
        return None


def _describe(build):
    """A build as the Builds room draws it: the list entry, where it stands
    (ready / cloning / failed / missing), and its summary numbers."""
    return {"id": build["id"], "name": build["name"], "root": str(build["root"]),
            "source": build["source"], "added": build["added"],
            **buildlist.state(build),
            "summary": _summary(build)}


def _catch_up(builds):
    """Index any commits the tables don't have yet for these builds. Failure
    is swallowed: an old summary beats no list."""
    try:
        codestore.update([_repo(build) for build in builds])
    except Exception:
        pass


def _report_sessions(build):
    """The sessions that touched a folder, most recent first:
    [{id, title, lane, running, last, files, writes, reads, creates,
      summary, summary_at, summary_source}]. `build` is one build, or None for
    the main map's own folders.

    Read from the same payload the map draws (`terrain._build_terrain`), so
    the report and the map can't disagree about who was here. Each file there
    lists the sessions that touched it; this turns that inside out — per
    session, how many files and how many writes."""
    payload = terrain._build_terrain(None, repos=[_repo(build)] if build else None)
    roster = {session["id"]: session for session in payload.get("sessions") or []}
    totals = {}
    for repo in payload.get("repos") or []:
        for entry in repo.get("files") or []:
            for touch in entry.get("sessions") or []:
                known = roster.get(touch["id"], {})
                total = totals.setdefault(touch["id"], {
                    "id": touch["id"], "title": touch.get("title") or "Untitled",
                    "lane": known.get("lane"), "running": bool(known.get("running")),
                    "last": None, "files": 0, "writes": 0, "reads": 0, "creates": 0})
                total["files"] += 1
                for count in ("writes", "reads", "creates"):
                    total[count] += int(touch.get(count) or 0)
                # `last` is when this session last touched a file HERE, not
                # when it last did anything anywhere.
                if touch.get("last") and (total["last"] is None or touch["last"] > total["last"]):
                    total["last"] = touch["last"]
    # Each session's last generated summary rides along, so the report can
    # print it the moment she taps a session — no second request.
    summaries = _last_summaries(list(totals))
    for session_id, total in totals.items():
        found = summaries.get(session_id)
        total["summary"] = found["summary"] if found else None
        total["summary_at"] = found["at"] if found else None
        total["summary_source"] = found["source"] if found else None
    return sorted(totals.values(), key=lambda total: total["last"] or "", reverse=True)


def _last_summaries(session_ids):
    """The newest helper-written summary of each of these sessions:
    {session id: {summary, at, source}}. A session no helper ever summarised
    is simply absent.

    One query against the `session_last_summary` view (sqlstore rung 48),
    which already picks the newest per session out of the two tables the
    helpers write. Asked for in batches, because SQLite caps how many `?` one
    statement may carry. A database hiccup is a report without summaries,
    never a 500."""
    found = {}
    try:
        conn = sqlstore.open_db()
    except Exception:
        return found
    try:
        for start in range(0, len(session_ids), 500):
            batch = session_ids[start:start + 500]
            marks = ",".join("?" * len(batch))
            for conv, summary, at, source in conn.execute(
                    "SELECT conv, summary, summary_at, source FROM session_last_summary"
                    f" WHERE conv IN ({marks})", batch):
                found[conv] = {"summary": summary, "at": at, "source": source}
    except Exception:
        pass
    finally:
        conn.close()
    return found


def register(app):
    def _refuse_visitor():
        """Refuse a visitor: a 404 for anyone who isn't the owner, and on a
        public mirror. Builds are hers alone."""
        if terrain._visitor() or config.public_only():
            return jsonify({"error": "not found"}), 404
        return None

    @app.route("/api/observatory/terrain/builds")
    def terrain_builds_list():
        """Every build on the list, each with its state and summary. Catches
        the code-history tables up first, so a build that just finished
        cloning arrives with its numbers."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        builds = buildlist.builds()
        _catch_up(builds)
        return jsonify({"builds": [_describe(build) for build in builds],
                        "clone_dir": str(buildlist.clone_dir())})

    @app.route("/api/observatory/terrain/builds", methods=["POST"])
    def terrain_builds_add():
        """Add a build. Body: {source, name?}. `source` is either a GitHub
        repo address — cloned in the background, so the build comes back as
        "cloning" — or the full path of a git folder already on this machine.
        A refusal is a 400 carrying a sentence the room shows as written."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        body = request.get_json(silent=True) or {}
        source = body.get("source")
        name = body.get("name") if isinstance(body.get("name"), str) else None
        if not isinstance(source, str) or not source.strip():
            return jsonify({"error": "paste a GitHub repo address or a folder path"}), 400
        source = source.strip()
        try:
            if buildlist.parse_github(source) is not None:
                build = buildlist.add_github(source, name)
            elif source.startswith(("/", "~")):
                build = buildlist.add_folder(source, name)
            else:
                return jsonify({"error": "that is neither a GitHub repo address "
                                         "(https://github.com/owner/repo) nor a full folder path"}), 400
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        _catch_up([build])
        return jsonify({"ok": True, "build": _describe(build)})

    @app.route("/api/observatory/terrain/builds/<build_id>", methods=["DELETE"])
    def terrain_builds_remove(build_id):
        """Take a build off the list and drop its rows from the code-history
        tables. The folder on disk is left exactly as it is."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        if not buildlist.remove(build_id):
            return jsonify({"error": "no such build"}), 404
        try:
            codestore.forget(build_id)
        except Exception:
            pass   # the rows are derived; the next rebuild sweeps them
        terrain._build_cache_clear(build_id)
        return jsonify({"ok": True})

    @app.route("/api/observatory/terrain/builds/<build_id>/refresh", methods=["POST"])
    def terrain_builds_refresh(build_id):
        """Bring one build up to date: pull a clone from GitHub (or restart a
        clone that failed), then index whatever is new. A local folder is only
        re-indexed. A pull that fails answers 502 with git's own words."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        build = buildlist.find(build_id)
        if build is None:
            return jsonify({"error": "no such build"}), 404
        ok, detail = buildlist.refresh(build)
        if not ok:
            return jsonify({"error": detail}), 502
        _catch_up([build])
        terrain._build_cache_clear(build_id)
        return jsonify({"ok": True, "detail": detail, "build": _describe(build)})

    @app.route("/api/observatory/terrain/builds/<build_id>/report")
    def terrain_builds_report(build_id):
        """One build's report: what was built, by which sessions, when.

        `summary` is the handful of numbers (commits, files, first and last
        commit, lines, days worked); `sessions` is who touched it; `commits`
        is every commit newest first, cut to the newest
        _REPORT_COMMITS_MAX with `commits_total` saying how many there are.
        The page groups the commits by day itself — which day a commit falls
        on depends on the reader's clock."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        build = buildlist.find(build_id)
        if build is None:
            return jsonify({"error": "no such build"}), 404
        _catch_up([build])
        summary = _summary(build)
        try:
            commits = codestore.commit_log(build["id"], limit=_REPORT_COMMITS_MAX)
        except Exception:
            commits = []
        try:
            sessions = _report_sessions(build)
        except Exception:
            sessions = []
        return jsonify({"build": _describe(build),
                        "summary": summary,
                        "sessions": sessions,
                        "commits": commits,
                        "commits_total": (summary or {}).get("commits", len(commits))})

    @app.route("/api/observatory/terrain/report")
    def terrain_main_report():
        """The main map's report: the same three parts a build's report has,
        read over the folders this system is made of as one history.

        A door of its own rather than a build id, because the main map isn't
        on the Builds list — it has no id to ask for, and a reserved one could
        collide with a build she names the same. `build` is filled in with
        the map's name and its folders' names so the page draws it unchanged."""
        refusal = _refuse_visitor()
        if refusal is not None:
            return refusal
        repos = list(observatory._terrain_repos())
        repo_ids = [repo["id"] for repo in repos]
        terrain._terrain_refresh_history()
        try:
            summary = codestore.repo_summary(repo_ids)
        except Exception:
            summary = None
        try:
            commits = codestore.commit_log(repo_ids, limit=_REPORT_COMMITS_MAX)
        except Exception:
            commits = []
        try:
            sessions = _report_sessions(None)
        except Exception:
            sessions = []
        return jsonify({"build": {"id": "", "name": "Terrain",
                                  "root": " + ".join(repo["name"] for repo in repos),
                                  "source": None, "added": None, "state": "ready",
                                  "detail": None, "summary": summary},
                        "summary": summary,
                        "sessions": sessions,
                        "commits": commits,
                        "commits_total": (summary or {}).get("commits", len(commits))})
