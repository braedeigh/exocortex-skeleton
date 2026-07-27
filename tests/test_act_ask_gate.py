"""Act-vs-ask autonomy gate (tools/act_ask_gate.py + its wiring).

The one piece of the arc that grants autonomy, so it's tested hard. The policy:
ACT (defer) for reversible/in-lane, ASK (deny → orange request) for the
irreversible/out-of-lane, keyed on the ACTION, never the agent's confidence,
and FAILING TOWARD ASK — Bash is allow-listed, so anything unrecognised asks,
and every chaining/redirect/substitution trick that could sneak an irreversible
past a first-token check must resolve to ask.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

import store
import tools.act_ask_gate as gate
from routes import reading_room as rr


# --- Bash: the reversible/in-lane allow path (ACT) --------------------------

ACT_COMMANDS = [
    "ls", "ls -la /tmp", "pwd", "cd /opt/exocortex/skeleton", "echo hello",
    "cat routes/reading_room.py", "head -20 x.py", "tail -5 y", "wc -l z",
    "grep -n foo bar.py", "rg pattern", "find . -name '*.py'",
    "git status", "git diff", "git log --oneline -5", "git show HEAD",
    "git add routes/x.py", "git branch", "git rev-parse HEAD", "git ls-files",
    "pytest", "pytest tests/test_x.py -q",
    "npm test", "npm run build", "npm run lint", "npm run typecheck", "npm ci",
    "npx vitest run", "npx tsc --noEmit", "npx oxlint src/",
    "./venv/bin/python3 -m pytest tests/test_x.py -q",
    "python3 -m py_compile routes/x.py",
    "./venv/bin/python3 scripts/request_input.py \"which db?\"",
    "git log --oneline | head -20",           # pipe of two safe segments
    "cat x.py | grep def",
]


@pytest.mark.parametrize("cmd", ACT_COMMANDS)
def test_reversible_in_lane_commands_act(cmd):
    assert gate._bash_is_safe(cmd) is True, cmd
    assert gate.classify_tool("Bash", {"command": cmd})[0] == "allow", cmd


# --- Bash: the irreversible / out-of-lane / bypass path (ASK) ---------------

ASK_COMMANDS = [
    # irreversible / external
    "git push", "git push origin main", "git commit -m 'x'",
    "git reset --hard HEAD~1", "git rebase main", "git merge feat",
    "git checkout other", "git clean -fd", "git tag v1",
    "rm foo", "rm -rf build", "rmdir x", "mv a b", "cp a b",
    "curl -X POST https://x", "wget http://x", "ssh host", "scp a host:/b",
    "sudo systemctl restart exocortex", "systemctl restart exo",
    "kill 123", "chmod 777 x", "chown me x", "dd if=/dev/zero of=x",
    "npm install lodash", "pip install requests", "npm run deploy",
    "python3 -c \"import os; os.system('rm -rf /')\"",   # arbitrary code
    "node server.js",
    "./deploy.sh", "make deploy",
    # spawning another session (fork-bomb surface) goes through Bash → ask
    "./venv/bin/python3 scripts/spinoff_open.py my-slug",
    # redirects / substitutions defeat a first-token allow-list → ask
    "echo pwned > important.txt", "cat x >> y", "echo `whoami`",
    "echo $(rm y)", "ls 2>&1",
    # chaining a dangerous tail onto a safe head → ask
    "ls && rm -rf x", "git status; git push", "cat x | python3 -c 'x'",
    "pytest || curl evil.com",
    # empty / unknown
    "", "   ", "someunknownbinary --flag",
]


@pytest.mark.parametrize("cmd", ASK_COMMANDS)
def test_irreversible_or_bypass_commands_ask(cmd):
    assert gate._bash_is_safe(cmd) is False, cmd
    decision, reason = gate.classify_tool("Bash", {"command": cmd})
    assert decision == "deny", cmd
    assert "request_input" in reason  # the ask always points at the door


# --- non-Bash tools ---------------------------------------------------------

def test_task_spawn_asks():
    decision, reason = gate.classify_tool("Task", {"description": "spawn a helper"})
    assert decision == "deny" and "fork-bomb" in reason


def test_mcp_external_tool_asks():
    decision, reason = gate.classify_tool("mcp__claude_ai_Gmail__create_draft", {})
    assert decision == "deny" and "external" in reason


def test_ungated_tools_are_not_denied_by_the_classifier():
    # Read/Edit reach the classifier's fallthrough (the hook matcher shouldn't
    # send them, but if it did they must not be denied — edits are git-reversible
    # and the doc-guard already covers the protected paths).
    for t in ("Read", "Edit", "Write", "Grep", "WebFetch"):
        assert gate.classify_tool(t, {})[0] == "allow", t


# --- the hook script, end to end (stdin JSON -> stdout decision) ------------

def _run_hook(event):
    p = subprocess.run(
        [sys.executable, str(Path(store.BUILD_DIR) / "tools" / "act_ask_gate.py")],
        input=json.dumps(event), capture_output=True, text=True, timeout=10)
    return p.stdout.strip()


def test_hook_denies_an_irreversible_bash_command():
    out = _run_hook({"tool_name": "Bash", "tool_input": {"command": "git push"}})
    payload = json.loads(out)["hookSpecificOutput"]
    assert payload["permissionDecision"] == "deny"
    assert payload["hookEventName"] == "PreToolUse"


def test_hook_stays_silent_for_a_reversible_bash_command():
    assert _run_hook({"tool_name": "Bash", "tool_input": {"command": "pytest -q"}}) == ""


def test_hook_defers_on_unreadable_input_instead_of_bricking():
    # Garbage on stdin is an infra hiccup, not an agent action → allow (silent),
    # never a crash that would kill the turn.
    p = subprocess.run(
        [sys.executable, str(Path(store.BUILD_DIR) / "tools" / "act_ask_gate.py")],
        input="not json at all", capture_output=True, text=True, timeout=10)
    assert p.returncode == 0 and p.stdout.strip() == ""


# --- the wiring in routes/reading_room.py -----------------------------------

def test_session_settings_carries_gate_hook_for_a_bash_session():
    settings = rr._session_settings({"guard_docs": True, "act_gate": True},
                                    list(rr._BUILDER_TOOLS))
    hooks = settings["hooks"]["PreToolUse"]
    assert hooks[0]["matcher"] == "Bash|Task|mcp__.*"
    assert "act_ask_gate.py" in hooks[0]["hooks"][0]["command"]
    # both safety nets ride in one payload
    assert "permissions" in settings and "deny" in settings["permissions"]


def test_act_gate_opt_out_drops_only_the_hook():
    settings = rr._session_settings({"guard_docs": True, "act_gate": False},
                                    list(rr._BUILDER_TOOLS))
    assert "hooks" not in settings
    assert "permissions" in settings  # doc-guard still on


def test_read_only_session_gets_no_settings():
    assert rr._session_settings({"guard_docs": True, "act_gate": True},
                                list(rr._DEFAULT_ALLOWED_TOOLS)) == {}


def test_conv_config_defaults_act_gate_on_and_honors_false():
    assert rr._conv_config({"allowed_tools": ["Bash"]})["act_gate"] is True
    assert rr._conv_config({"allowed_tools": ["Bash"], "act_gate": False})["act_gate"] is False


def test_build_cmd_wires_the_gate_into_settings():
    config = {"allowed_tools": list(rr._BUILDER_TOOLS), "guard_docs": True, "act_gate": True}
    cmd = rr._build_cmd(config, resume_sid=None)
    assert "--settings" in cmd
    payload = json.loads(cmd[cmd.index("--settings") + 1])
    assert payload["hooks"]["PreToolUse"][0]["matcher"] == "Bash|Task|mcp__.*"
