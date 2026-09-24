#!/usr/bin/env python3
"""Apply a batch-worker's research result back to research.json.

The worker Claude session calls this script (via the APPLY command the route
hands it) once it has produced a digest of its findings:

    EXOCORTEX_DATA_DIR=/path/to/data \\
        python3 worker_apply_result.py \\
            --session <session_id> \\
            --text   "Short one-paragraph digest." \\
            [--file  "relative/path/to/report.md"]

The script can also be imported and called directly:
    from scripts.worker_apply_result import apply_result
    apply_result(session_id, "digest text", file="optional/report.md")

What it does (all inside one store.mutate):
  - Finds the session record (raises ValueError if missing).
  - If session.entry_ids is non-empty: finds the question entry referenced
    by entry_ids[0], appends a reply entry (author "llm") threaded under it
    via reply_to, marks the question processed=True/flagged=False (status
    unchanged), and sets session report to "Researched → research/<file>"
    (or "Answered." with no file).
  - If session.entry_ids is EMPTY (a distill session — see
    routes/research.py's /api/research/topic/distill): appends a reply entry
    with reply_to=None and topics copied straight from the session (no
    question to inherit topics from, nothing to mark processed/unflagged),
    and sets session report to "Distilled → research/<file>" (or
    "Distilled." with no file).
  - Either way: sets session status="done", and copies the session's
    `conv_id` (the Observatory conversation a room worker ran as — stamped by
    scripts/research_dispatcher.py at spawn) onto the reply entry, so a reply
    in research.json points straight back at the conversation that wrote it.

Once the mutate closes, it also kicks scripts/research_dispatcher.py (fire
and forget) so the next queued worker gets admitted right away instead of
waiting for cron — see _kick_dispatcher below. The tmux terminal-tab cleanup
runs only for a LEGACY session (no `conv_id`): a room worker never had a tab.
"""
import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Make the skeleton root importable regardless of where the script is invoked from.
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from routes.research import _new_entry_id  # noqa: E402
from scripts import claude_transcripts  # noqa: E402


def _kick_dispatcher(session_id):
    """Fire scripts/research_dispatcher.py once, detached, right after this
    worker's result has been applied — so the memory this session is about
    to free (once it closes its own tmux session) goes straight to the next
    queued worker instead of waiting for cron. --ending is this worker's own
    tmux name (rw-<session_id>, sanitized the same way
    research_dispatcher.spawn_worker names it) so the dispatcher doesn't
    undercount the headroom this session is about to free. Fire-and-forget;
    the caller wraps this in try/except so a dispatcher hiccup never breaks
    a successful apply."""
    tmux_name = re.sub(r"[^A-Za-z0-9-]", "-", f"rw-{session_id}")[:40]
    subprocess.Popen(
        [f"{SKELETON}/venv/bin/python3", f"{SKELETON}/scripts/research_dispatcher.py",
         "--ending", tmux_name],
        env={**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _deregister_terminal_tab(session_id):
    """Drop this worker's tmux name from sessions.json (the terminal UI's tab
    list, registered by ensure_claude_session). Workers self-destruct when
    done — a lingering tab for a dead worker invites a tap, and the terminal's
    attach path would otherwise squat the name with a bare shell that the
    dispatcher then mistakes for a live worker."""
    tmux_name = re.sub(r"[^A-Za-z0-9-]", "-", f"rw-{session_id}")[:40]
    with store.mutate("sessions.json", []) as names:
        names[:] = [n for n in names if n != tmux_name]


def apply_result(session_id, text, file=None):
    """Apply a worker result to research.json under an flock-safe mutate.

    Args:
        session_id: The session id to look up.
        text: The digest text for the llm reply entry.
        file: Optional relative path to a written report file (e.g. "gut.md").
              If given, stored on the reply entry and referenced in the session report.

    Returns:
        The newly created reply entry dict.

    Raises:
        ValueError: if the session is not found, or (for a session WITH
            entry_ids) its question entry is not found. A session with no
            entry_ids (a distill session) has no question to look up.
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
        sessions = data.setdefault("sessions", [])
        session = next((s for s in sessions if s["id"] == session_id), None)
        if session is None:
            raise ValueError(f"Session not found: {session_id!r}")

        entries = data.setdefault("entries", [])
        entry_ids = session.get("entry_ids") or []

        question = None
        reply_to = None
        topics = list(session.get("topics") or [])
        if entry_ids:
            question_id = entry_ids[0]
            question = next((e for e in entries if e["id"] == question_id), None)
            if question is None:
                raise ValueError(f"Question entry not found: {question_id!r}")
            reply_to = question_id
            topics = list(question.get("topics") or [])

        # Create the llm reply entry
        reply = {
            "id": _new_entry_id(entries),
            "kind": "note",
            "text": text,
            "topics": topics,
            "url": "",
            "verdict": "",
            "status": "",
            "reply_to": reply_to,
            "created": now,
            "author": "llm",
            "reviewed": False,
            "session": session_id,
        }
        if file:
            reply["file"] = file
        # Close the trace from the reply's side: a room worker's reply names
        # the conversation it was written in. Legacy tmux sessions have no
        # conv_id and get no field — absent, never null.
        if session.get("conv_id"):
            reply["conv_id"] = session["conv_id"]
        entries.append(reply)

        if question is not None:
            # Mark the question as processed; leave status unchanged
            question["processed"] = True
            question["flagged"] = False

        # Close the session with a one-line report
        session["status"] = "done"
        if entry_ids:
            session["report"] = (
                f"Researched → research/{file}" if file else "Answered."
            )
        else:
            session["report"] = (
                f"Distilled → research/{file}" if file else "Distilled."
            )
        # Best-effort token/duration receipt, same swallow-all guard as
        # research_ctl.close() — a worker is a clean 1:1 tmux/process, so if
        # the dispatcher's spawn_worker managed to capture its sessionId,
        # this is a whole-run (not time-sliced) sum.
        try:
            receipt = claude_transcripts.session_receipt(session)
            if receipt:
                session.update(receipt)
        except Exception:
            pass

    # Only a legacy tmux worker has a terminal tab to drop; a room worker ran
    # as an Observatory conversation and has nothing in sessions.json.
    if not session.get("conv_id"):
        try:
            _deregister_terminal_tab(session_id)
        except Exception:
            pass  # a stale tab is cosmetic; never fail a successful apply over it
    try:
        _kick_dispatcher(session_id)
    except Exception:
        pass  # a dispatcher hiccup must never break a successful apply

    return reply


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    parser = argparse.ArgumentParser(
        description="Apply a batch-worker research result to research.json.",
    )
    parser.add_argument("--session", required=True, help="Session id")
    parser.add_argument("--text", required=True, help="Digest text for the reply entry")
    parser.add_argument(
        "--file", default=None,
        help="Optional relative path to the written report file (e.g. 'gut.md')",
    )
    args = parser.parse_args()

    try:
        reply = apply_result(args.session, args.text, file=args.file)
        print(f"OK: reply entry {reply['id']!r} added for session {args.session!r}")
        sys.exit(0)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
