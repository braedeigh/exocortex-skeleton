#!/usr/bin/env python3
"""plan_gate.py — a planning session plans; it never builds (PreToolUse hook).

**What this is, in plain English.** A /spinoff starts with a planning session:
it reads the code, explains it, asks its questions and writes a plan for the
owner to correct (claude-commands/spinoff/plan_protocol.md). The building is
done by a different, fresh session, started only when the owner approves the
plan with the Go button. So a planning session must not be able to build, even
if it decides to. This hook checks every tool call it makes, and lets through
only:

  - the reading tools (Read, Grep, Glob, ToolSearch) and the web's reading
    tools (WebFetch, WebSearch);
  - Skill, which only loads a set of instructions;
  - Bash, only for lookups: the same reading and searching commands and git
    reading verbs a helper is allowed (tools/helper_gate.py owns that list and
    the command reader — this file borrows both), plus a planning session's
    own doors: peers.py, exo_query.py, request_input.py (ask the owner),
    spinoff_brief.py (save the plan as the builder's brief) and
    spinoff_offer.py (put up the Go button);
  - Bash, to run the tests: pytest, and the frontend's `npm test` / `npx
    vitest run`. A test run checks the planner's reading of the code. It
    changes no source file (it does write its own caches), and the planner
    can't write a test of its own to run.

Everything else — Write, Edit, a sub-agent, an outside service, any other
command, and spinoff_open.py (which would start a builder without the owner's
Go) — is denied, with a reason saying how to hand the plan over instead. It
FAILS TOWARD DENY: a command it can't read as a lookup is refused.

Same contract as tools/helper_gate.py: reads Claude Code's PreToolUse event as
JSON on stdin, prints a "deny" decision or nothing. Wired in
routes/observatory.py `_session_settings` for every session whose
`spinoff_stage` is "plan" (set at birth by routes/spinoff.py open_spinoff).
Tests: tests/test_plan_gate.py.

Prompt that produced this: "i want my /spinoff functionality to stop just
building without my permission. i want it to make a plan first that i approve."
And, on whether a planner may run tests: "let them run test suite I guess".
"""
import json
import re
import sys
from pathlib import Path

# The hook runs as a script and the tests import it as tools.plan_gate; either
# way the helper gate is the file beside this one.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import helper_gate  # noqa: E402

# The reading tools, the web's reading tools, and Skill.
_ALLOWED_TOOLS = helper_gate._LOOK_TOOLS + helper_gate._WEB_TOOLS + ("Skill",)

# The app's own doors for a planning session, run with the checkout's python.
# Not spinoff_open.py: the builder is started by the owner's Go, never by the
# planner.
# Beside them, the test runners: pytest (bare, or through a python), and the
# frontend's two. Nothing else `npm` or `npx` can do passes.
_SCRIPTS = re.compile(
    r"^(?:\S*python3? (?:\S*/)?scripts/"
    r"(peers|exo_query|request_input|spinoff_brief|spinoff_offer)\.py\b"
    r"|(?:\S*python3? -m )?pytest\b"
    r"|npm (?:run )?test\b"
    r"|npx vitest run\b)")

_HAND_OVER = (
    " You're a planning session: you read, explain, ask and plan; a fresh "
    "session builds once the owner approves. When the plan is agreed, save it "
    "as the builder's brief with `./venv/bin/python3 scripts/spinoff_brief.py "
    "<your slug> <<'BRIEF'` … `BRIEF`, then put up the Go button with "
    "`./venv/bin/python3 scripts/spinoff_offer.py <your slug>` and end your turn.")
_REASON_BASH = ("PLAN GATE — this command isn't a lookup or a test run (it "
                "could change files, build, commit or run code)." + _HAND_OVER)
_REASON_TOOL = "PLAN GATE — a planning session can't use this tool." + _HAND_OVER


def classify_tool(tool_name, tool_input):
    """(decision, reason): ("allow", None) or ("deny", why). The whole policy,
    as a pure function so the tests can hammer it."""
    if tool_name in _ALLOWED_TOOLS:
        return ("allow", None)
    if tool_name == "Bash":
        if helper_gate.bash_is_lookup((tool_input or {}).get("command", ""), _SCRIPTS):
            return ("allow", None)
        return ("deny", _REASON_BASH)
    return ("deny", _REASON_TOOL)


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
        decision, reason = classify_tool(data.get("tool_name") or "",
                                         data.get("tool_input") or {})
    except Exception:
        # Deny what can't be read: this gate's whole job is saying no.
        decision, reason = "deny", "PLAN GATE — couldn't read this tool call." + _HAND_OVER
    if decision == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))
    sys.exit(0)


if __name__ == "__main__":
    main()
