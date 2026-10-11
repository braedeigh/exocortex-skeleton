"""file_edits.py — the owner edits a file in the browser, and a session can ask her to.

What this is, in plain English: the /code page shows one file from the app
code, the vault or one of her builds. This is what lets her change it there:
read the whole file as it is on disk, and save her edit back. It is also the
queue behind "open this file for me": a session that needs her to fill
something in (a setting in a settings file, say) files a request naming the
file; an orange card on her page opens it in the editor; when she saves, every
session that asked is woken with "saved" and nothing else.

Two rules the whole file is built around:

  - Only files that already exist inside a folder Terrain can read (the app
    code, the vault, her builds list) can be opened. A path is checked twice,
    on its spelling and on where it really lands, so neither '../' nor a
    symlink reaches anything else.
  - What she types is written to the file and nowhere else. It is never put in
    the queue, a log, a wake-up message or an answer to an agent. An agent
    names a file; it is never handed the file's text by this module.

This door opens files the read-only one (routes/terrain.py's deny-list) won't,
such as `.env`: that one is also open to visitors, this one is the owner's
alone (routes/file_edit.py checks). Agents run as the same user as the app, so
this is no fence around the file itself; it keeps the value out of the chat
and the records.

A save carries the `version` the editor was opened on (the file's size and
last-changed time). If the file has changed since, the save is refused, so her
edit never silently replaces one an agent made meanwhile.

Requests live in the data dir as `file_requests.json` through store.mutate
(the locked read-modify-write path), the same shape as sudo_requests.py. Two
sessions asking for the same file share one request.

Touches: routes/terrain.py (`_readable_repos`, which folders count),
routes/file_edit.py (the endpoints), scripts/open_file.py (the agents' door),
routes/observatory.py (queue_followup, to wake the asking sessions), store.py.

Prompt that produced it: "i want for the LLM to be able to pop out a file for
me to edit in the browser, or for me to be able to open it from the files list
in activity or something"
"""
import os
import stat
import tempfile
import uuid
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path

import store

NAME = "file_requests"
# How many finished requests are kept, so the page can say what just happened.
KEEP_CLOSED = 30
SOURCE = "file_request"
# The largest file the editor opens or saves, in bytes. A text box holding more
# than this is slow on a phone, and nothing she edits by hand is this big.
EDIT_MAX_BYTES = 1024 * 1024
# Never opened for editing: git's own files. Changing one by hand breaks the repo.
EDIT_DENYLIST = ("*.git/*", ".git/*")


class Refused(Exception):
    """This file can't be opened or saved. `status` is the HTTP answer, and
    the message is safe to show: it never carries file text."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _empty():
    return {"requests": []}


def _repos():
    from routes import terrain
    return terrain._readable_repos()


def _roots():
    """(repo, resolved root) for every folder a file may be edited in."""
    found = []
    for repo in _repos():
        try:
            found.append((repo, Path(repo["root"]).resolve()))
        except (OSError, RuntimeError, ValueError):
            continue
    return found


def _version(path):
    """What a file looked like when it was read: its size and last-changed
    time. Two reads give the same answer only if nothing wrote in between."""
    info = path.stat()
    return f"{info.st_mtime_ns}-{info.st_size}"


# Refuse any path that escapes the readable folders.
# Two checks, the same two the read-only door makes (terrain._terrain_safe_path):
# the spelling must stay under the named repo, and the real file, symlinks
# followed, must land inside one of the readable folders.
def resolve(repo_id, relpath):
    if not repo_id or not relpath:
        raise Refused("repo and path are required")
    roots = _roots()
    root = next((resolved for repo, resolved in roots if repo["id"] == repo_id), None)
    if root is None:
        raise Refused("unknown repo", 404)
    if "\0" in relpath:
        raise Refused("not found", 404)
    rel = relpath.replace("\\", "/").lstrip("/")
    if any(fnmatch(rel, pattern) for pattern in EDIT_DENYLIST):
        raise Refused("git's own files can't be edited here", 403)
    lexical = os.path.normpath(os.path.join(str(root), rel))
    if not lexical.startswith(str(root) + os.sep):
        raise Refused("not found", 404)
    try:
        candidate = Path(lexical).resolve()
    except (OSError, RuntimeError, ValueError):
        raise Refused("not found", 404)
    if not any(allowed in candidate.parents for _, allowed in roots):
        raise Refused("not found", 404)
    if not candidate.is_file():
        raise Refused("not found", 404)
    return candidate


def locate(path):
    """Which repo an absolute path sits in, and its path inside it: the form
    the editor's address takes. The deepest matching folder wins, so a build
    inside another folder is named as itself."""
    try:
        target = Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        raise Refused(f"can't read the path {path!r}", 404)
    matches = [(repo, root) for repo, root in _roots() if root in target.parents]
    if not matches:
        names = ", ".join(str(root) for _, root in _roots()) or "(none)"
        raise Refused(f"{target} is outside every folder the editor can open: {names}. "
                      "A folder is added from Terrain's Builds room.", 404)
    repo, root = max(matches, key=lambda match: len(match[1].parts))
    relpath = target.relative_to(root).as_posix()
    resolve(repo["id"], relpath)   # the same checks the page will make
    return repo["id"], relpath


def read(repo_id, relpath):
    """The whole file as it is on disk, with the version a save must match."""
    path = resolve(repo_id, relpath)
    raw = path.read_bytes()
    if len(raw) > EDIT_MAX_BYTES:
        raise Refused("this file is too big to edit here", 413)
    if b"\0" in raw[:8000]:
        raise Refused("this isn't a text file", 415)
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("this isn't a text file", 415)
    return {"repo": repo_id, "path": relpath, "content": content,
            "version": _version(path)}


# Save her edit over the file, then wake any session that asked for it.
# Refused when the file changed since the editor opened it. The write is
# atomic (temp file beside it, then a rename), and the new file keeps the old
# one's permissions, so a settings file readable only by her stays that way.
def save(repo_id, relpath, content, version):
    if not isinstance(content, str):
        raise Refused("content must be text")
    data = content.encode("utf-8")
    if len(data) > EDIT_MAX_BYTES:
        raise Refused("this is too big to save here", 413)
    path = resolve(repo_id, relpath)
    if version != _version(path):
        raise Refused("the file changed on disk since you opened it", 409)
    mode = stat.S_IMODE(path.stat().st_mode)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".edit-", suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
    woken = _close_for(repo_id, relpath, "saved")
    return {"ok": True, "version": _version(path), "woken": woken}


# File a request, or join the open one for the same file.
# Validation happens here, before anything is written: a file the editor can't
# open is refused loudly so the agent learns why, rather than queuing a card
# that leads her to an error.
def file_request(path, conv_id, reason="", now=None):
    repo_id, relpath = locate(path)
    now = now or _now()
    asker = {"conv": conv_id or "", "reason": (reason or "").strip()[:500], "at": now}
    with store.mutate(NAME, _empty()) as data:
        for req in data["requests"]:
            if req["status"] == "open" and (req["repo"], req["path"]) == (repo_id, relpath):
                if not any(a["conv"] == asker["conv"] for a in req["askers"]):
                    req["askers"].append(asker)
                return dict(req, joined=True)
        req = {"id": uuid.uuid4().hex[:12], "repo": repo_id, "path": relpath,
               "askers": [asker], "created": now, "status": "open", "closed_at": None}
        data["requests"].append(req)
        return dict(req, joined=False)


def _titles():
    index = store.read("bot_chats/index", {}) or {}
    return {k: (v.get("title") or k) for k, v in index.items() if isinstance(v, dict)}


def listing():
    """Open requests (oldest first), each asking session named by its title."""
    data = store.read(NAME, _empty()) or _empty()
    titles = _titles()
    return {"open": [
        dict(req, askers=[dict(a, title=titles.get(a["conv"], a["conv"] or "an agent"))
                          for a in req["askers"]])
        for req in data.get("requests", []) if req["status"] == "open"]}


def dismiss(req_id):
    """She turned the request down without saving: close it and say so."""
    with store.mutate(NAME, _empty()) as data:
        req = next((r for r in data["requests"] if r["id"] == req_id), None)
        if req is None:
            raise KeyError(req_id)
        if req["status"] != "open":
            raise ValueError(f"already {req['status']}")
        req.update(status="dismissed", closed_at=_now())
        _trim(data)
        final = dict(req)
    _wake(final)
    return final


def _close_for(repo_id, relpath, status):
    """Close every open request for this file and wake its askers. Returns how
    many requests were closed. A save from anywhere answers the card: the
    card's own button, or the same file opened from a session's file list."""
    closed = []
    with store.mutate(NAME, _empty()) as data:
        for req in data["requests"]:
            if req["status"] == "open" and (req["repo"], req["path"]) == (repo_id, relpath):
                req.update(status=status, closed_at=_now())
                closed.append(dict(req))
        if closed:
            _trim(data)
    for req in closed:
        _wake(req)
    return len(closed)


def _trim(data):
    closed = [r for r in data["requests"] if r["status"] != "open"]
    drop = {r["id"] for r in closed[:-KEEP_CLOSED]} if len(closed) > KEEP_CLOSED else set()
    data["requests"] = [r for r in data["requests"] if r["id"] not in drop]


def wake_message(req):
    """What each asking session is told when its request closes: (text, system),
    shaped like run_detached's wake-up — `system` is the chat bubble + journal
    line. It names the file and the outcome, never what the file holds."""
    where = f"{req['repo']}:{req['path']}"
    if req["status"] == "saved":
        outcome = "the owner saved the file"
        after = ("Check what you needed is there without printing the file or any "
                 "secret in it (test for presence or length, never the value).")
    else:
        outcome = "the owner closed the request without saving"
        after = "Nothing was changed. Don't file it again unless she asks."
    summary = f"File request — {where}: {outcome}"
    text = (f"[File request answered — you filed it with scripts/open_file.py]\n"
            f"File: {where}\nResult: {outcome}\n\n{after}\n"
            "Pick up where you left off. If you already dealt with this, say so in a line.")
    return text, {"display": summary, "journal": summary, "source": SOURCE,
                  "item_id": req["id"]}


def _wake(req):
    text, system = wake_message(req)
    from routes import observatory
    for asker in req["askers"]:
        if not asker.get("conv"):
            continue
        try:
            observatory.queue_followup(asker["conv"], text, system=system)
        except Exception:  # one unwakeable session mustn't stop the others
            pass
