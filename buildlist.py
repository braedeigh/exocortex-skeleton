"""The builds list — the other folders Terrain can map, beside the app code
and the vault.

Terrain's main map covers two folders that are part of this system. A BUILD is
any other git folder the owner wants to read the same way: a project built in
its own directory, or a repo cloned from GitHub. Each build gets its own map
and its own report (routes/terrain_builds.py); it never joins the main map.

WHICH FOLDERS IS THE OWNER'S, not the app's. The list lives in
`terrain_builds.json` in the data dir, so adding a build is a data change —
through the Builds room, or by editing the file — and nothing about one
install's projects is written into this shareable repo:

    {"clone_dir": "/somewhere/terrain-builds",      (optional)
     "builds": [
       {"id": "my-project", "name": "My Project", "root": "/path/to/my-project"},
       {"id": "some-repo", "name": "Some Repo", "root": "/somewhere/terrain-builds/some-repo",
        "source": "https://github.com/owner/some-repo"}
     ]}

An entry with a `source` is a CLONE this module made: `git clone` runs in its
own detached process (a big repo takes longer than a web request may), and the
entry's state is read off the disk — the folder is there, or a status file
says the clone failed, or it is still running. An entry without one is a folder
that was already on this machine, and is only ever read.

Touches: `store.py` (the data file, and the two core roots a build may not
overlap), `codestore.py` (indexes each build's git history under its id),
`routes/terrain.py` (builds one build's map, and lets the owner open its
files), `routes/terrain_builds.py` (the HTTP doors).

Prompt that produced this file: "I want to be able to view other folders in my
terrain view so I can basically see a report of what happened … ideally this
becomes something where I can port any repo into it from GitHub and see when
it was built or edited. And I can view all my builds in here separately."
"""
from datetime import datetime
from pathlib import Path
import os
import re
import shutil
import subprocess

import store

# The ids the main map's two folders already wear. A build may not take one:
# the code-history tables and the file door are both keyed by this id.
RESERVED_IDS = ("skeleton", "vault")

# What a build id may look like: lowercase letters, digits and dashes. It is
# used in URLs, in node ids on the map (which are split on ':'), and as a
# folder name under the clone directory, so it is kept to what is safe in all
# three.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")

# The two ways a GitHub repo is usually written: the https address (with or
# without `.git`, with or without a trailing slash) and the ssh one.
_GITHUB_HTTPS_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?/?$")
_GITHUB_SSH_RE = re.compile(
    r"^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+?)(?:\.git)?$")

_PULL_TIMEOUT_SEC = 100      # under gunicorn's 120s request timeout
_LOG_TAIL_CHARS = 600        # how much of a failed clone's output is shown


def _config():
    """The data file as a dict, whatever is on disk. A missing or malformed
    file reads as no builds — a typo there must not take the Builds room down."""
    configured = store.read("terrain_builds", {})
    return configured if isinstance(configured, dict) else {}


def clone_dir():
    """Where clones from GitHub are kept. The data file's `clone_dir` when it
    names one; otherwise a `terrain-builds` folder beside the app checkout.

    Deliberately outside both the app repo and the data dir: a clone is a git
    repo of its own, and a repo nested inside another one gets swept into the
    outer repo's commits."""
    configured = _config().get("clone_dir")
    if isinstance(configured, str) and configured.strip():
        return Path(configured).expanduser()
    return Path(store.BUILD_DIR).parent / "terrain-builds"


def _clean(raw):
    """One entry from the data file as a build, or None if it can't be one.
    Malformed entries are skipped rather than raised on, so one bad line costs
    one build and not the list."""
    if not isinstance(raw, dict):
        return None
    build_id = raw.get("id")
    root = raw.get("root")
    if not isinstance(build_id, str) or not _ID_RE.match(build_id):
        return None
    if build_id in RESERVED_IDS or not isinstance(root, str) or not root.strip():
        return None
    source = raw.get("source") if isinstance(raw.get("source"), str) else None
    return {"id": build_id,
            "name": str(raw.get("name") or display_name(build_id)),
            "root": Path(root).expanduser(),
            "source": source or None,
            "added": raw.get("added") if isinstance(raw.get("added"), str) else None}


def builds():
    """Every build on the list, in the order it was added. Two entries with
    the same id keep only the first — the id is what everything is keyed by."""
    out, seen = [], set()
    for raw in _config().get("builds") or []:
        build = _clean(raw)
        if build is None or build["id"] in seen:
            continue
        seen.add(build["id"])
        out.append(build)
    return out


def find(build_id):
    """The build with this id, or None."""
    return next((build for build in builds() if build["id"] == build_id), None)


def repos():
    """The builds in the shape the code-history walker and the map take a repo
    in: {id, name, root}."""
    return tuple({"id": build["id"], "name": build["name"], "root": build["root"]}
                 for build in builds())


def display_name(slug):
    """A readable name from a folder or repo name: "my-project" → "My Project"."""
    words = re.split(r"[-_.\s]+", slug)
    return " ".join(word.capitalize() for word in words if word) or slug


def slug(text):
    """A build id from a folder or repo name: lowercase, anything that isn't a
    letter or digit turned into a dash. None when nothing usable is left."""
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:63].strip("-")
    return cleaned if cleaned and _ID_RE.match(cleaned) else None


def parse_github(url):
    """(owner, repo) from a GitHub address, or None when it isn't one.

    Only GitHub repo addresses are accepted. The clone runs `git` on this
    machine with whatever the owner pasted, so the shape is checked against a
    strict pattern rather than handed over as written — no other hosts, no
    local paths, nothing that could be read as an option."""
    text = (url or "").strip()
    match = _GITHUB_HTTPS_RE.match(text) or _GITHUB_SSH_RE.match(text)
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    if repo in (".", ".."):
        return None
    return owner, repo


def _core_roots():
    """The main map's two folders — the app checkout and the vault."""
    return (Path(store.BUILD_DIR), Path(store.CONTENT_DIR).parent)


def _overlaps_core(root):
    """True when `root` is, is inside, or contains one of the main map's two
    folders. Such a build would draw the app or the vault a second time, and a
    file in it would belong to two maps at once."""
    try:
        resolved = Path(root).resolve()
    except (OSError, RuntimeError):
        return True
    for core in _core_roots():
        try:
            core = core.resolve()
        except (OSError, RuntimeError):
            continue
        if resolved == core or core in resolved.parents or resolved in core.parents:
            return True
    return False


def _free_id(candidates, taken):
    """The first candidate id that is usable and not already on the list."""
    for candidate in candidates:
        if candidate and candidate not in RESERVED_IDS and candidate not in taken:
            return candidate
    return None


def _append(entry):
    """Add one entry to the data file. Raises ValueError if its id or its
    folder is already on the list — checked under the file's own lock, so two
    adds at once can't both land."""
    with store.mutate("terrain_builds", {}) as configured:
        entries = configured.get("builds")
        if not isinstance(entries, list):
            entries = configured["builds"] = []
        for raw in entries:
            if not isinstance(raw, dict):
                continue
            if raw.get("id") == entry["id"]:
                raise ValueError("a build with that name is already on the list")
            if raw.get("root") == entry["root"]:
                raise ValueError("that folder is already on the list")
        entries.append(entry)


def add_folder(path, name=None):
    """Put a folder that is already on this machine on the list. Returns the
    new build. Raises ValueError with a sentence the Builds room can show.

    The folder is only ever read. It has to be a git repo: a build's map is
    drawn from its commit history, and a folder without one would show
    nothing but the files agent sessions happened to touch."""
    root = Path(str(path).strip()).expanduser()
    if not root.is_absolute():
        raise ValueError("give the folder's full path, starting with /")
    if not root.is_dir():
        raise ValueError("no folder at that path")
    if _overlaps_core(root):
        raise ValueError("that folder overlaps the app code or the vault, which the main map already covers")
    if not is_git_repo(root):
        raise ValueError("that folder isn't a git repo, so there is no history to map")
    taken = {build["id"] for build in builds()}
    build_id = _free_id((slug(root.name), slug(f"{root.parent.name}-{root.name}")), taken)
    if build_id is None:
        raise ValueError("a build with that name is already on the list")
    entry = {"id": build_id, "name": (name or "").strip() or display_name(root.name),
             "root": str(root), "added": datetime.now().isoformat(timespec="seconds")}
    _append(entry)
    return find(build_id)


def add_github(url, name=None):
    """Clone a GitHub repo and put the clone on the list. Returns the new
    build straight away; the clone itself runs on in the background and the
    build reads as "cloning" until its folder appears (see `state`)."""
    parsed = parse_github(url)
    if parsed is None:
        raise ValueError("that isn't a GitHub repo address (https://github.com/owner/repo)")
    owner, repo = parsed
    taken = {build["id"] for build in builds()}
    build_id = _free_id((slug(repo), slug(f"{owner}-{repo}")), taken)
    if build_id is None:
        raise ValueError("a build with that name is already on the list")
    source = f"https://github.com/{owner}/{repo}"
    dest = clone_dir() / build_id
    if dest.exists():
        raise ValueError(f"there is already a folder at {dest}")
    entry = {"id": build_id, "name": (name or "").strip() or display_name(repo),
             "root": str(dest), "source": source,
             "added": datetime.now().isoformat(timespec="seconds")}
    _append(entry)
    start_clone(source, dest)
    return find(build_id)


def remove(build_id):
    """Take a build off the list. True when it was there. The folder itself is
    left alone — a build that was a local project is someone's working copy,
    and a clone is cheap to keep and slow to fetch again."""
    with store.mutate("terrain_builds", {}) as configured:
        entries = configured.get("builds")
        if not isinstance(entries, list):
            return False
        kept = [raw for raw in entries
                if not (isinstance(raw, dict) and raw.get("id") == build_id)]
        if len(kept) == len(entries):
            return False
        configured["builds"] = kept
        return True


# --- reading a folder ----------------------------------------------------------

def _git_env():
    """The environment git runs in: never stop to ask for a password. With no
    terminal to answer, a prompt would hang the clone until it timed out."""
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def is_git_repo(root):
    """True when `root` is the top of a git working tree."""
    try:
        proc = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    try:
        return Path(proc.stdout.strip()).resolve() == Path(root).resolve()
    except (OSError, RuntimeError):
        return False


# --- cloning -------------------------------------------------------------------
#
# A clone leaves three hidden files beside the folder it is making, all named
# for the build: `.<id>.partial` (the clone while it is still arriving),
# `.<id>.clone.log` (git's own output) and `.<id>.clone.status` (git's exit
# code, written only when it FAILED). The folder is moved into place only when
# the clone finishes, so a half-arrived repo is never mistaken for a build.

def _clone_files(dest):
    dest = Path(dest)
    hidden = dest.parent / f".{dest.name}"
    return {"partial": Path(f"{hidden}.partial"),
            "log": Path(f"{hidden}.clone.log"),
            "status": Path(f"{hidden}.clone.status")}


def start_clone(source, dest):
    """Start `git clone source dest` in a process of its own and return at
    once. Clears whatever a previous attempt left behind first, so a retry
    starts clean.

    The addresses are handed to the shell as positional arguments ($1…$5),
    never pasted into the script text, so nothing in them can be run."""
    dest = Path(dest)
    files = _clone_files(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(files["partial"], ignore_errors=True)
    for leftover in (files["log"], files["status"]):
        leftover.unlink(missing_ok=True)
    files["log"].write_text("")
    script = ('git clone --quiet -- "$1" "$2" >"$3" 2>&1 && mv "$2" "$4"'
              ' || echo "$?" >"$5"')
    subprocess.Popen(
        ["sh", "-c", script, "sh", str(source), str(files["partial"]),
         str(files["log"]), str(dest), str(files["status"])],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, env=_git_env())


def state(build):
    """Where a build stands: {"state": ready | cloning | failed | missing,
    "detail": a sentence or None}. Read off the disk every time, so it is
    right after a restart and from any worker.

    ready   — the folder is there.
    cloning — a clone was started and hasn't finished.
    failed  — the clone ended in an error; `detail` is the end of git's output.
    missing — the folder isn't there and nothing is fetching it."""
    root = Path(build["root"])
    if root.is_dir():
        return {"state": "ready", "detail": None}
    if not build.get("source"):
        return {"state": "missing", "detail": f"no folder at {root}"}
    files = _clone_files(root)
    if files["status"].exists():
        try:
            tail = files["log"].read_text(errors="replace").strip()[-_LOG_TAIL_CHARS:]
        except OSError:
            tail = ""
        return {"state": "failed", "detail": tail or "git clone failed"}
    if files["log"].exists():
        return {"state": "cloning", "detail": None}
    return {"state": "missing", "detail": f"no folder at {root}"}


def refresh(build):
    """Bring a clone up to date with GitHub. Returns (ok, detail).

    A clone that is there is pulled, fast-forward only: this copy is for
    reading, so anything that would need a merge is reported rather than
    attempted. A clone that failed or went missing is started again. A build
    that was a local folder is left alone — it is a working copy, and pulling
    into it is not this app's business."""
    if not build.get("source"):
        return True, None
    root = Path(build["root"])
    current = state(build)["state"]
    if current == "cloning":
        return True, "still cloning"
    if current != "ready":
        start_clone(build["source"], root)
        return True, "clone started again"
    try:
        proc = subprocess.run(["git", "-C", str(root), "pull", "--quiet", "--ff-only"],
                              capture_output=True, text=True,
                              timeout=_PULL_TIMEOUT_SEC, env=_git_env())
    except (OSError, subprocess.SubprocessError) as error:
        return False, f"git pull did not finish: {error}"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout).strip()[-_LOG_TAIL_CHARS:] or "git pull failed"
    return True, None
