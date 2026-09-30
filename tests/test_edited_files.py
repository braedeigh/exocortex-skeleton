"""The room helper's "Files being edited now" section (edited_files.py),
fed the way the live site feeds it: turns' log lines folded into tool_calls
by toolcallstore.live_ingest, and a real git checkout.

What this pins: a file two open sessions changed is flagged with both named —
whether the edit came through the Edit tool or a Bash heredoc — a Bash
command that only reads a file doesn't count as editing it, a finished
session is left out, and a changed file nobody open claims is named as such.
"""
import json
import subprocess
from datetime import datetime, timezone

import edited_files
import store
import toolcallstore

OPEN_A, OPEN_B, CLOSED = "2026-09-30.090000", "2026-09-30.091000", "2026-09-30.092000"


def _repo(tmp_path):
    """A checkout with three committed files, all three then changed."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git = ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    for name in ("pond.py", "notes.py", "garden.py"):
        (repo / name).write_text("x = 1\n")
    subprocess.run(git + ["add", "."], check=True)
    subprocess.run(git + ["commit", "-qm", "start"], check=True)
    for name in ("pond.py", "notes.py", "garden.py"):
        (repo / name).write_text("x = 2\n")
    return repo


def _turn(conv, *tool_uses):
    """One turn's log, folded into tool_calls the way a running turn does it."""
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    path = store.DATA_DIR / "bot_chats" / f"{conv}.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        for n, (name, inp) in enumerate(tool_uses):
            f.write(json.dumps({"type": "assistant", "timestamp": stamp, "message": {
                "content": [{"type": "tool_use", "id": f"toolu_{conv}_{n}",
                             "name": name, "input": inp}]}}) + "\n")
    toolcallstore.live_ingest(path, conv)


def test_the_section_flags_a_file_two_open_sessions_edit_and_leaves_out_a_closed_one(
        data_dir, tmp_path):
    repo = _repo(tmp_path)
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        index[OPEN_A] = {"title": "pond page", "lane": "coding"}
        index[OPEN_B] = {"title": "pond refactor", "lane": "coding"}
        index[CLOSED] = {"title": "garden", "lane": "coding", "done_at": "2026-09-30T09:30:00"}
    # A edits with the Edit tool; B through a Bash heredoc, after only reading notes.py.
    _turn(OPEN_A, ("Edit", {"file_path": str(repo / "pond.py"), "old_string": "1",
                            "new_string": "2"}))
    _turn(OPEN_B, ("Bash", {"command": "grep -n x notes.py; python3 - <<'EOF'\n"
                                       "p='pond.py'; s=open(p).read()\n"
                                       "open(p,'w').write(s.replace('1','2'))\nEOF"}))
    _turn(CLOSED, ("Write", {"file_path": str(repo / "garden.py"), "content": "x = 2\n"}))

    text = edited_files.section("coding", repo=repo)
    shared = text.split("## Touched by more than one open session")[1].split("## By session")[0]
    by_session = text.split("## By session")[1].split("## Uncommitted")[0]
    unclaimed = text.split("## Uncommitted in the app checkout, claimed by no open session")[1]

    assert "`pond.py`" in shared and OPEN_A in shared and OPEN_B in shared
    assert CLOSED not in text                                  # finished: not in view
    assert "notes.py" not in by_session                        # read, not edited
    assert "garden.py" in unclaimed and "notes.py" in unclaimed
