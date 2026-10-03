"""The helpers' lookups-only gate (tools/helper_gate.py) and its wiring.

What these pin: a swarm or room helper can still do every lookup its
instructions point it at, and save a spinoff brief (through its one script,
fed on standard input) and start the session;
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
    "./venv/bin/python3 scripts/spinoff_brief.py pond-colour --show",
    "./venv/bin/python3 scripts/room_moves.py list",
    "./venv/bin/python3 scripts/helper_watch.py add 2026-09-30.113857 --on done,committed"
    " --note \"tell her when the Linear board ships\"",
    "./venv/bin/python3 scripts/helper_rule.py add \"don't move a session I saved for later\"",
    "./venv/bin/python3 scripts/helper_rule.py list",
    "./venv/bin/python3 scripts/linear_feed.py issue BAS-5",
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

# A brief as a helper really writes one: backticks, quotes, `$`, shell-looking
# lines. Inside a quoted here-document none of it is run.
BRIEF = """# Spinoff: paint the pond

## The task
She said: "make it `blue`, don't ask" — costs $5; rm -rf / is just words here.
$(rm x) and `rm y` too.

## Where to look
- routes/no_such_file.py
"""
SAVE = "./venv/bin/python3 scripts/spinoff_brief.py pond-colour"

SAVES = [
    f"{SAVE} <<'BRIEF'\n{BRIEF}BRIEF",
    f"{SAVE} --room coding <<'EOF'\n{BRIEF}EOF\n",
    f"cd /opt/exocortex/skeleton && EXOCORTEX_DATA_DIR=/x/data {SAVE} <<'BRIEF'\n{BRIEF}BRIEF",
]

NOT_SAVES = [
    # The text would be expanded by the shell: the word isn't quoted.
    f"{SAVE} <<BRIEF\n{BRIEF}BRIEF",
    f'{SAVE} <<"BRIEF"\n{BRIEF}BRIEF',
    # The closing word early: everything after it would run as commands.
    f"{SAVE} <<'BRIEF'\nhello\nBRIEF\nrm -rf x\nBRIEF",
    f"{SAVE} <<'BRIEF'\nhello\nBRIEF\nrm -rf x",
    # More on the opening line, or a different command reading the text.
    f"{SAVE} <<'BRIEF' && rm x\n{BRIEF}BRIEF",
    f"{SAVE} <<'BRIEF' | sh\n{BRIEF}BRIEF",
    f"{SAVE} && rm x <<'BRIEF'\n{BRIEF}BRIEF",
    f"python3 - <<'BRIEF'\nopen('x','w')\nBRIEF",
    f"sh <<'BRIEF'\nrm x\nBRIEF",
    f"./venv/bin/python3 scripts/spinoff_open.py x <<'BRIEF'\n{BRIEF}BRIEF",
    f"$(rm x){SAVE} <<'BRIEF'\n{BRIEF}BRIEF",
    f"{SAVE} > out.txt <<'BRIEF'\n{BRIEF}BRIEF",
    f"{SAVE} < /etc/passwd",
]


@pytest.mark.parametrize("command", LOOKUPS)
def test_a_helper_can_still_look_things_up(command):
    assert gate.classify_tool("Bash", {"command": command}) == ("allow", None)


@pytest.mark.parametrize("command", BUILDS)
def test_a_helper_cannot_build_from_bash(command):
    decision, reason = gate.classify_tool("Bash", {"command": command})
    assert decision == "deny" and "spinoff_open.py" in reason


@pytest.mark.parametrize("command", SAVES)
def test_a_helper_can_save_a_brief_by_feeding_it_to_the_brief_script(command):
    assert gate.classify_tool("Bash", {"command": command}) == ("allow", None)


@pytest.mark.parametrize("command", NOT_SAVES)
def test_no_other_fed_text_gets_through(command):
    assert gate.classify_tool("Bash", {"command": command})[0] == "deny"


def test_a_brief_a_helper_saves_through_the_gate_really_lands(data_dir, monkeypatch):
    """The allowed command, run for real through a shell: the brief arrives in
    the database word for word, with nothing in it run."""
    import briefstore
    assert gate.bash_is_lookup(SAVES[0])
    repo = Path(gate.__file__).resolve().parents[1]
    command = SAVES[0].replace("./venv/bin/python3", sys.executable)
    done = subprocess.run(["bash", "-c", command], cwd=repo, capture_output=True, text=True,
                          timeout=120, env={"PATH": "/usr/bin:/bin",
                                            "EXOCORTEX_DATA_DIR": str(data_dir),
                                            "EXOCORTEX_RUNTIME_SENSOR": "0",
                                            "EXOCORTEX_STORE_STATS_OFF": "1"})
    assert done.returncode == 0, done.stdout + done.stderr
    reply = json.loads(done.stdout)
    assert reply["ok"] and reply["missing"] == ["routes/no_such_file.py"]
    assert briefstore.latest("pond-colour")["body"] == BRIEF


@pytest.mark.parametrize("tool", ["Write", "Edit", "NotebookEdit", "Task", "Agent", "Skill",
                                  "mcp__claude_ai_Gmail__send_message",
                                  "mcp__linear__save_issue", "RemoteTrigger"])
def test_a_helper_cannot_use_any_other_tool(tool):
    assert gate.classify_tool(tool, {"file_path": "/x/y.py"})[0] == "deny"


@pytest.mark.parametrize("tool", ["Read", "Grep", "Glob", "WebFetch", "WebSearch"])
def test_the_reading_tools_pass(tool):
    assert gate.classify_tool(tool, {"file_path": "/x/y.py"}) == ("allow", None)


def test_a_helper_writes_no_files_not_even_an_old_style_brief(tmp_path):
    brief = tmp_path / "spinoffs" / "pond-colour" / "BRIEF.md"
    decision, reason = gate.classify_tool("Write", {"file_path": str(brief)})
    assert decision == "deny" and "spinoff_brief.py" in reason


def _run_hook(event, *args):
    proc = subprocess.run([sys.executable, str(GATE), *args], input=json.dumps(event),
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def test_the_hook_denies_through_claude_codes_contract(tmp_path):
    denied = _run_hook({"tool_name": "Edit", "tool_input": {"file_path": "/x.py"}})
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert _run_hook({"tool_name": "Bash", "tool_input": {"command": "git log -3"}}) is None
    assert _run_hook({"tool_name": "Bash", "tool_input": {"command": SAVES[0]}}) is None
    # A helper turn started before the gate lost its --spinoff-dir flag still
    # passes it; the flag is ignored.
    assert _run_hook({"tool_name": "Bash", "tool_input": {"command": "git log -3"}},
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
        assert hook["command"].endswith("helper_gate.py")


def test_a_helper_made_before_the_web_tools_still_gets_them(data_dir):
    import swarm_helper
    # The owner's room helper was stored with ['Read', 'Grep', 'Glob', 'Bash'].
    entry = {"role": "room_helper", "lane": "coding", "allowed_tools": ["Read", "Bash"]}
    config = observatory._conv_config(entry)
    assert config["allowed_tools"] == swarm_helper.HELPER_TOOLS
    command = observatory._build_cmd(config, None)
    allowed = command[command.index("--allowedTools") + 1].split(",")
    assert {"WebFetch", "WebSearch", "Write"} <= set(allowed)


def test_an_ordinary_session_has_no_helper_gate(data_dir):
    assert _gate_hooks({"lane": "coding", "allowed_tools": ["Read", "Edit", "Bash"]}) == []


def test_the_helpers_instructions_say_it_never_builds(data_dir):
    import helper_chat
    prompt = helper_chat.CHAT_PROMPT.format(
        lead="", wake="", world_line="", repo="/repo", chats="/c", conv="c", data="/d",
        exchanges=15)
    assert "You never build" in prompt and "BRIEF.md" not in prompt
    assert "scripts/spinoff_brief.py <slug> <<'BRIEF'" in prompt
    assert "scripts/spinoff_open.py <slug>" in prompt
