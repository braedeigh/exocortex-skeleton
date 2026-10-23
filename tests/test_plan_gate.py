"""The planning session's plan-only gate (tools/plan_gate.py).

What these pin: a spinoff's planning session can do everything planning needs
— read, search, run the existing tests, ask the owner, save the plan as a
brief and put up the Go button — and nothing that builds: no edit, no rewrite
through the shell, no commit, no build, no sub-agent, and no starting the builder
itself. The wiring (which sessions get the gate) is pinned in
tests/test_spinoff_routes.py, beside the door that sets it.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

import tools.plan_gate as gate

PLANNING = [
    ("Read", {"file_path": "/x/routes/spinoff.py"}),
    ("Grep", {"pattern": "open_spinoff"}),
    ("Glob", {"pattern": "tests/*.py"}),
    ("WebFetch", {"url": "https://example.com"}),
    ("Skill", {"skill": "spark"}),
    ("Bash", {"command": "git log --oneline -8 && git status --short"}),
    ("Bash", {"command": "grep -rn plan_gate routes | head -20"}),
    ("Bash", {"command": "sed -n 20,80p routes/spinoff.py"}),
    # Running the tests that exist, to check its reading of the code.
    ("Bash", {"command": "./venv/bin/python3 -m pytest tests/test_spinoff_routes.py -q 2>&1 | tail -20"}),
    ("Bash", {"command": "pytest -k offer"}),
    ("Bash", {"command": "cd frontend && npx vitest run src/features/observatory"}),
    ("Bash", {"command": "cd frontend && npm test"}),
    ("Bash", {"command": "./venv/bin/python3 scripts/request_input.py \"blue or green?\""}),
    ("Bash", {"command": "./venv/bin/python3 scripts/exo_query.py schema spinoff_briefs"}),
    ("Bash", {"command": "EXOCORTEX_DATA_DIR=/x/data ./venv/bin/python3 "
                         "scripts/spinoff_offer.py pond-colour"}),
    # Closing itself, once its builder exists and nothing is left to do.
    ("Bash", {"command": "./venv/bin/python3 scripts/session_done.py 'builder is running'"}),
    ("Bash", {"command": "EXOCORTEX_DATA_DIR=/x/data ./venv/bin/python3 "
                         "scripts/spinoff_brief.py pond-colour <<'BRIEF'\n"
                         "# Spinoff: paint the pond\n\nRun `npm run build` after; "
                         "costs $0.\nBRIEF"}),
]

BUILDING = [
    ("Edit", {"file_path": "/x/routes/spinoff.py", "old_string": "a", "new_string": "b"}),
    ("Write", {"file_path": "/x/new.py", "content": "x"}),
    ("NotebookEdit", {"notebook_path": "/x/n.ipynb"}),
    ("Agent", {"prompt": "build it"}),
    ("Task", {"prompt": "build it"}),
    ("mcp__linear__save_issue", {"title": "x"}),
    ("Bash", {"command": "git commit -am 'done'"}),
    ("Bash", {"command": "git add -A && git push"}),
    ("Bash", {"command": "sed -i s/a/b/ routes/spinoff.py"}),
    ("Bash", {"command": "echo x > routes/spinoff.py"}),
    ("Bash", {"command": "cat > new.py <<'EOF'\nprint(1)\nEOF"}),
    ("Bash", {"command": "cd frontend && npm run build"}),
    ("Bash", {"command": "npm install left-pad"}),
    ("Bash", {"command": "npx prettier --write src"}),
    ("Bash", {"command": "./venv/bin/python3 -m pytest tests/x.py > tests/x.py"}),
    ("Bash", {"command": "sudo systemctl reload exocortex.service"}),
    ("Bash", {"command": "./venv/bin/python3 -c \"open('x','w').write('y')\""}),
    # Starting the builder is the owner's Go, never the planner's.
    ("Bash", {"command": "./venv/bin/python3 scripts/spinoff_open.py pond-colour"}),
    # A brief whose text closes early would run what follows as commands.
    ("Bash", {"command": "./venv/bin/python3 scripts/spinoff_brief.py x <<'BRIEF'\n"
                         "hi\nBRIEF\ngit commit -am sneaky"}),
]


@pytest.mark.parametrize("tool,tool_input", PLANNING)
def test_a_planning_session_can_do_what_planning_needs(tool, tool_input):
    assert gate.classify_tool(tool, tool_input) == ("allow", None)


@pytest.mark.parametrize("tool,tool_input", BUILDING)
def test_a_planning_session_cannot_build(tool, tool_input):
    decision, reason = gate.classify_tool(tool, tool_input)
    assert decision == "deny" and "PLAN GATE" in reason


def _run_hook(event):
    done = subprocess.run([sys.executable, str(Path(gate.__file__))], input=event,
                          capture_output=True, text=True, timeout=30)
    return json.loads(done.stdout) if done.stdout.strip() else None


def test_the_hook_denies_an_edit_and_stays_silent_on_a_read():
    """Run the way Claude Code runs it: the event on stdin, as its own process."""
    denied = _run_hook(json.dumps({"tool_name": "Edit", "tool_input": {}}))
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert _run_hook(json.dumps({"tool_name": "Read", "tool_input": {}})) is None


def test_the_hook_denies_what_it_cannot_read():
    assert _run_hook("not json")["hookSpecificOutput"]["permissionDecision"] == "deny"
