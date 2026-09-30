"""The helpers' lookups-only gate (tools/helper_gate.py) and its wiring.

What these pin: a swarm or room helper can still do every lookup its
instructions point it at, and write a spinoff brief and start the session;
everything that builds — editing, a sed -i or heredoc rewrite, npm run build,
git commit, a reload, a sub-agent — is denied, including the exact commands a
helper once used to build and commit on its own. And the gate is attached to
every helper's turn, whatever room it's in, and to no one else's.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

import store
import tools.helper_gate as gate
from routes import observatory

GATE = Path(gate.__file__)

LOOKUPS = [
    "git log --oneline -8",
    "git -C /opt/exocortex/skeleton show --stat e242ad1",
    "git show e242ad1 -- frontend/src/features/observatory/swarmNetworkMath.ts",
    "git status --short && git log -3 --format='%h %ci %s'",
    "git branch", "git branch -a",
    "./venv/bin/python3 scripts/peers.py swarm 2>&1 | head -80",
    "./venv/bin/python3 scripts/peers.py show 2026-09-28.100130",
    "EXOCORTEX_CONV_ID=2026-09-27.174238 ./venv/bin/python3 scripts/peers.py send "
    "2026-09-28.100130 \"From the owner, verbatim: 'make it blue'\"",
    "EXOCORTEX_DATA_DIR=/x/data ./venv/bin/python3 scripts/exo_query.py query "
    "\"select at, from_conv from agent_messages where at > '2026-09-28' limit 5\"",
    "./venv/bin/python3 scripts/exo_query.py schema agent_messages",
    "./venv/bin/python3 scripts/request_input.py \"which colour?\"",
    "./venv/bin/python3 scripts/spinoff_open.py pond-colour",
    "./venv/bin/python3 scripts/room_moves.py list",
    "./venv/bin/python3 scripts/helper_watch.py add 2026-09-30.113857 --on done,committed"
    " --note \"tell her when the Linear board ships\"",
    "grep -il pond /x/bot_chats/*.jsonl | head",
    "grep -n \"retired\\|edges\" frontend/src/SwarmNetwork.tsx | head -80",
    "grep -rn 'a|b' . 2>/dev/null",
    "cd /opt/exocortex/skeleton && sed -n 1,64p SwarmNetwork.tsx; sed -n 80,200p x.ts",
    "wc -l helper_chat.py", "ls tests | grep -i helper", "find . -name '*.py'",
    "tail -c 6000 /x/bot_chats/a.jsonl | tail -n 5 | cut -c1-1500",
]

BUILDS = [
    # What the helper actually ran to build e242ad1 / e3d4c32.
    "sed -i '47s/} from/  withoutRetired,\\n} from/' SwarmNetwork.tsx",
    "cd /opt/exocortex/skeleton && python3 - <<'EOF'\np='x.ts'\nopen(p,'w').write('')\nEOF",
    "npm run build 2>&1 | tail -4 && cd .. && git add frontend/src/x.ts",
    "cd /opt/exocortex/skeleton && git commit -q -m \"Swarm network: counts\"",
    "npx vitest run src/x.test.ts",
    # Other ways to write, build or run code.
    "sudo systemctl reload exocortex.service",
    "./venv/bin/python3 scripts/sudo_request.py reload --reason x",
    "./venv/bin/python3 -m pytest tests/ -q",
    "./venv/bin/python3 -c \"import os; os.remove('x')\"",
    "echo x > routes/x.py", "cat a >> b", "tee x.py", "cp a b", "mv a b", "rm x",
    "find . -name '*.pyc' -delete", "find . -exec rm {} +", "sort -o x.txt y.txt",
    "rg --pre ./evil x", "git branch -D agent/x", "git diff --output=x.patch",
    "git -c core.pager='sh -c evil' log", "git push", "git checkout -- x.py",
    "git stash", "git reset --hard", "env rm x", "echo $(rm x)", "echo `rm x`",
    "grep x \"$(rm y)\"", "ls & rm x", "ls\nrm x", "echo \"unclosed",
    "./venv/bin/python3 scripts/peers.py send 2026-09-28.1 hi --interrupt",
    "./venv/bin/python3 scripts/spinoff_offer.py x", "sed -n '1w out.txt' x",
    "", "   ",
]


@pytest.mark.parametrize("command", LOOKUPS)
def test_a_helper_can_still_look_things_up(command):
    assert gate.classify_tool("Bash", {"command": command}) == ("allow", None)


@pytest.mark.parametrize("command", BUILDS)
def test_a_helper_cannot_build_from_bash(command):
    decision, reason = gate.classify_tool("Bash", {"command": command})
    assert decision == "deny" and "spinoff_open.py" in reason


@pytest.mark.parametrize("tool", ["Edit", "NotebookEdit", "Task", "Agent", "Skill",
                                  "mcp__claude_ai_Gmail__send_message", "WebFetch"])
def test_a_helper_cannot_use_any_other_tool(tool):
    assert gate.classify_tool(tool, {"file_path": "/x/y.py"})[0] == "deny"


@pytest.mark.parametrize("tool", ["Read", "Grep", "Glob"])
def test_the_reading_tools_pass(tool):
    assert gate.classify_tool(tool, {"file_path": "/x/y.py"}) == ("allow", None)


def test_write_reaches_only_a_spinoff_brief(tmp_path):
    spinoffs = tmp_path / "spinoffs"
    (spinoffs / "pond-colour").mkdir(parents=True)

    def verdict(path):
        return gate.classify_tool("Write", {"file_path": str(path)}, str(spinoffs))[0]

    assert verdict(spinoffs / "pond-colour" / "BRIEF.md") == "allow"
    assert verdict(spinoffs / "new-slug" / "BRIEF.md") == "allow"   # Write makes the folder
    assert verdict(spinoffs / "pond-colour" / "CONTEXT.md") == "deny"
    assert verdict(spinoffs / "BRIEF.md") == "deny"
    assert verdict(spinoffs / "Bad_Slug" / "BRIEF.md") == "deny"
    assert verdict(spinoffs / "pond-colour" / ".." / ".." / "BRIEF.md") == "deny"
    assert verdict(tmp_path / "routes" / "x.py") == "deny"
    assert gate.classify_tool("Write", {"file_path": str(spinoffs / "a" / "BRIEF.md")})[0] \
        == "deny"                                                   # no spinoff dir: no write


def _run_hook(event, *args):
    proc = subprocess.run([sys.executable, str(GATE), *args], input=json.dumps(event),
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def test_the_hook_denies_through_claude_codes_contract(tmp_path):
    denied = _run_hook({"tool_name": "Edit", "tool_input": {"file_path": "/x.py"}})
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert _run_hook({"tool_name": "Bash", "tool_input": {"command": "git log -3"}}) is None
    brief = tmp_path / "s" / "pond" / "BRIEF.md"
    assert _run_hook({"tool_name": "Write", "tool_input": {"file_path": str(brief)}},
                     "--spinoff-dir", str(tmp_path / "s")) is None
    unreadable = subprocess.run([sys.executable, str(GATE)], input="not json",
                                capture_output=True, text=True, timeout=30)
    assert json.loads(unreadable.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny"


# --- The wiring -----------------------------------------------------------------

def _gate_hooks(entry):
    config = observatory._conv_config(entry)
    settings = observatory._session_settings(config, config["allowed_tools"])
    return [h for group in settings.get("hooks", {}).get("PreToolUse", [])
            for h in group["hooks"] if "helper_gate.py" in h["command"]
            and group["matcher"] == "*"]


@pytest.mark.parametrize("role", ["swarm_helper", "room_helper"])
def test_every_helper_turn_carries_the_gate_in_any_room(data_dir, role):
    for lane in ("coding", "personal", "orchestra"):
        entry = {"role": role, "lane": lane, "act_gate": False,
                 "allowed_tools": ["Read", "Grep", "Glob", "Bash", "Write"]}
        [hook] = _gate_hooks(entry)
        assert f"--spinoff-dir {store.SPINOFF_DIR}" in hook["command"]


def test_an_ordinary_session_has_no_helper_gate(data_dir):
    assert _gate_hooks({"lane": "coding", "allowed_tools": ["Read", "Edit", "Bash"]}) == []


def test_the_helpers_instructions_say_it_never_builds(data_dir):
    import helper_chat
    prompt = helper_chat.CHAT_PROMPT.format(
        lead="", world_line="", repo="/repo", chats="/c", conv="c", data="/d",
        spinoffs="/d/spinoffs")
    assert "You never build" in prompt and "/d/spinoffs/<slug>/BRIEF.md" in prompt
    assert "scripts/spinoff_open.py <slug>" in prompt
