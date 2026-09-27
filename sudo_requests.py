"""sudo_requests.py — agents ask, the owner types her password, the command runs.

What this is, in plain English: an agent that needs something run as root (most
often reloading the web server after a Python edit) can't type a sudo password,
so it files a *request* here instead. The request shows up on the owner's page —
an orange box on the Observatory roster and a popup at the bottom of every other
page — with a password box. When she approves, the server hands the password to
`sudo` on its standard input, runs the command, and wakes every session that
asked with the result.

The safety rule the whole file is built around: an agent never names a command,
only the KEY of one in config.SUDO_ACTIONS. The command line is looked up from
that list at approve time, so nothing an agent writes — and nothing a poisoned
web page talks an agent into writing — can put a new command in front of her
password. The password is never stored, logged, or put in a command line; it
exists only in the approve request and sudo's stdin.

Requests live in the data dir as `sudo_requests.json` through store.mutate (the
locked read-modify-write path), so the two gunicorn workers and the CLI see one
queue. Two sessions asking for the same action while one is open share it: one
approval, both woken.

Touches: config.py (SUDO_ACTIONS), store.py, routes/sudo.py (the endpoints),
scripts/sudo_request.py (the agents' door), routes/observatory.py
(queue_followup, to wake the asking sessions).

Prompt that produced it: "i want for there to be a popup for me to be able to
approve and enter my password if necessary. like a notification at the bottom
and the ability to put in password both there and on the front page where it
would be orange and with a sudo request and an input box"
"""
import shlex
import subprocess
import uuid
from datetime import datetime

import config
import store

NAME = "sudo_requests"
# How many finished requests are kept, so the page can say what just happened.
KEEP_CLOSED = 30
SOURCE = "sudo_request"
SUDO_TIMEOUT_SEC = 90


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _empty():
    return {"requests": []}


def action_command(action):
    """The command line an action runs, shown to her exactly as sudo gets it."""
    return shlex.join(["sudo", *config.SUDO_ACTIONS[action]["argv"]])


# File a request, or join the open one for the same action.
# Validation happens here, before anything is written: an unknown action is refused
# loudly so the agent learns the list, rather than queuing something she can't run.
def file_request(action, conv_id, reason="", now=None):
    if action not in config.SUDO_ACTIONS:
        known = ", ".join(sorted(config.SUDO_ACTIONS)) or "(none configured)"
        raise ValueError(f"unknown action {action!r} — known: {known}")
    now = now or _now()
    asker = {"conv": conv_id or "", "reason": (reason or "").strip()[:500], "at": now}
    with store.mutate(NAME, _empty()) as data:
        for req in data["requests"]:
            if req["action"] == action and req["status"] in ("open", "running"):
                if not any(a["conv"] == asker["conv"] for a in req["askers"]):
                    req["askers"].append(asker)
                return dict(req, joined=True)
        req = {"id": uuid.uuid4().hex[:12], "action": action, "askers": [asker],
               "created": now, "status": "open", "result": None, "closed_at": None}
        data["requests"].append(req)
        return dict(req, joined=False)


def _titles():
    index = store.read("bot_chats/index", {}) or {}
    return {k: (v.get("title") or k) for k, v in index.items() if isinstance(v, dict)}


def _view(req, titles):
    """A request as the page sees it: the action's label and exact command, and
    each asking session's title."""
    spec = config.SUDO_ACTIONS.get(req["action"])
    return {
        **{k: req[k] for k in ("id", "action", "created", "status", "result", "closed_at")},
        "label": spec["label"] if spec else req["action"],
        "command": action_command(req["action"]) if spec else None,
        "askers": [dict(a, title=titles.get(a["conv"], a["conv"] or "an agent"))
                   for a in req["askers"]],
    }


def listing():
    """Open requests (oldest first) and the last few closed ones."""
    data = store.read(NAME, _empty()) or _empty()
    titles = _titles()
    reqs = data.get("requests", [])
    return {
        "open": [_view(r, titles) for r in reqs if r["status"] in ("open", "running")],
        "recent": [_view(r, titles) for r in reqs if r["status"] not in ("open", "running")][-5:],
    }


def _run_sudo(argv, password):
    """Run argv under sudo. With a password: fed on stdin (-S), prompt silenced,
    cached credentials ignored (-k) so what she typed is what's checked. Without:
    non-interactive (-n), which only succeeds if sudo needs no password here."""
    if password:
        cmd, stdin = ["sudo", "-S", "-k", "-p", "", *argv], password + "\n"
    else:
        cmd, stdin = ["sudo", "-n", *argv], ""
    try:
        done = subprocess.run(cmd, input=stdin, capture_output=True, text=True,
                              timeout=SUDO_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {SUDO_TIMEOUT_SEC}s"
    return done.returncode, done.stdout, done.stderr


def _classify(code, stderr, had_password):
    """Read sudo's answer: ran, wrong password, needs one, or the command failed."""
    text = (stderr or "").lower()
    if code == 0:
        return "done"
    if not had_password and "password is required" in text:
        return "needs_password"
    if had_password and ("incorrect password" in text or "sorry, try again" in text):
        return "wrong_password"
    return "failed"


# Approve a request: claim it, run the command, record the outcome, wake the askers.
# Claiming ("running") first stops a double-tap running it twice. A wrong or missing
# password hands the request back to "open" so she can just try again.
def approve(req_id, password="", runner=None):
    runner = runner or _run_sudo
    with store.mutate(NAME, _empty()) as data:
        req = next((r for r in data["requests"] if r["id"] == req_id), None)
        if req is None:
            raise KeyError(req_id)
        if req["status"] != "open":
            raise ValueError(f"already {req['status']}")
        if req["action"] not in config.SUDO_ACTIONS:
            raise ValueError(f"action {req['action']!r} is no longer allowed")
        req["status"] = "running"
        argv = list(config.SUDO_ACTIONS[req["action"]]["argv"])

    try:
        code, out, err = runner(argv, password)
    except Exception as exc:  # the claim must never be left stuck on "running"
        code, out, err = 1, "", f"couldn't run sudo: {exc.__class__.__name__}"
    outcome = _classify(code, err, bool(password))
    tail = ((out or "") + (err or "")).strip()[-1500:]

    with store.mutate(NAME, _empty()) as data:
        req = next(r for r in data["requests"] if r["id"] == req_id)
        if outcome in ("wrong_password", "needs_password"):
            req["status"] = "open"
        else:
            req.update(status=outcome, closed_at=_now(),
                       result={"exit": code, "output": tail})
            _trim(data)
        final = dict(req)

    if outcome in ("done", "failed"):
        _wake(final)
    return {"status": outcome, "exit": code,
            "output": tail if outcome in ("done", "failed") else ""}


def deny(req_id):
    with store.mutate(NAME, _empty()) as data:
        req = next((r for r in data["requests"] if r["id"] == req_id), None)
        if req is None:
            raise KeyError(req_id)
        if req["status"] != "open":
            raise ValueError(f"already {req['status']}")
        req.update(status="denied", closed_at=_now())
        _trim(data)
        final = dict(req)
    _wake(final)
    return final


def _trim(data):
    closed = [r for r in data["requests"] if r["status"] not in ("open", "running")]
    drop = {r["id"] for r in closed[:-KEEP_CLOSED]} if len(closed) > KEEP_CLOSED else set()
    data["requests"] = [r for r in data["requests"] if r["id"] not in drop]


def wake_message(req):
    """What each asking session is told when its request closes: (text, system),
    shaped like run_detached's wake-up — `system` is the chat bubble + journal line."""
    label = config.SUDO_ACTIONS.get(req["action"], {}).get("label", req["action"])
    if req["status"] == "denied":
        outcome = "the owner declined it"
    elif req["status"] == "done":
        outcome = "the owner approved it and it ran (exit 0)"
    else:
        outcome = f"the owner approved it but it failed (exit {req['result']['exit']})"
    summary = f"Sudo request — {label}: {outcome}"
    output = (req.get("result") or {}).get("output") or ""
    text = (f"[Sudo request answered — you filed it with scripts/sudo_request.py]\n"
            f"Action: {req['action']} ({label})\nResult: {outcome}\n"
            + (f"\nOutput:\n{output}\n" if output else "")
            + "\nPick up where you left off. If you already dealt with this, say so in a line.")
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
