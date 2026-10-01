#!/usr/bin/env python3
"""file_alert_hook.py — warn a session as it starts to change a file another
open session has changed (PreToolUse hook).

**What this is, in plain English.** The app alerts two open sessions when
they are in the same file (file_alerts.py). Its minute check finds that out
after the fact. This hook finds it out as the edit begins: every Edit, Write
and Bash call of a session in a watched room passes through here first, and
when the file it's about to change was changed by another open session
lately, the agent is handed a warning along with the edit — which file, which
session, what to do. The other session is sent its notice at the same
moment. It happens once per pair of sessions per file; after that this hook
says nothing about them.

It only ever ADDS a note. It never blocks, changes or delays an edit: any
error, a slow database, an unreadable event — it prints nothing and the call
goes ahead as if the hook weren't there.

Most calls leave at once: a Bash command with no sign of writing anything
(no redirect, no `sed -i`, no `mv`/`cp`/`rm`, no script that opens a file to
write) is passed before any of the app's own code is loaded, since this runs
on every Bash call a session makes.

Contract: reads Claude Code's PreToolUse event as JSON on stdin; prints
either nothing or `{"hookSpecificOutput": {"hookEventName": "PreToolUse",
"additionalContext": "<the warning>"}}`. Checked against Claude Code 2.1.285:
the agent sees the added context and the tool still runs. Who the session is
comes from EXOCORTEX_CONV_ID, which every Observatory turn carries.

Touches: file_alerts.py (before_edit does the work), routes/observatory.py
(`_session_settings` wires it in), tests/test_file_alerts.py.

Prompt that produced this: "identifies when 2 agents are working nearby or on
the same files and alert them when they are" — and, from the brief built on
it: "catch it before the edit if it is cheap to."
"""
import json
import os
import re
import sys
from pathlib import Path

_EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
# The signs that a Bash command might write a file — the same ones
# edited_files.py looks for. Redirects of errors (`2>&1`, `> /dev/null`) are
# taken out first: nearly every command has one and none of them is an edit.
_NOT_A_WRITE = re.compile(r"\d*>&\d|\d*>\s*/dev/null")
_MAY_WRITE = re.compile(r">|\btee\b|\bsed\s.*-i|\bperl\s+-\w*i|\b(mv|cp|rm|touch|patch)\b"
                        r"|open\(|write_(text|bytes)\(")


def main():
    conv = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv:
        return
    event = json.load(sys.stdin)
    tool = event.get("tool_name")
    tool_input = event.get("tool_input") or {}
    # Pass a call that can't be an edit, before loading anything.
    if tool == "Bash":
        if not _MAY_WRITE.search(_NOT_A_WRITE.sub("", str(tool_input.get("command") or ""))):
            return
    elif tool not in _EDIT_TOOLS:
        return
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import file_alerts
    # `--repo <path>` names the checkout to match Bash commands against;
    # without it, the app's own (what every live session uses).
    repo = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--repo" else None
    warning = file_alerts.before_edit(conv, tool, tool_input, cwd=event.get("cwd"), repo=repo)
    if warning:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "additionalContext": warning}}))


if __name__ == "__main__":
    # Never let this hook's own trouble touch the edit: say nothing and leave.
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
