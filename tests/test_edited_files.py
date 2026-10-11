"""The room helper's "Files being edited now" section (edited_files.py),
fed the way the live site feeds it: turns' log lines folded into tool_calls
by toolcallstore.live_ingest, and a real git checkout.

What this pins: a file two open sessions changed is flagged with both named —
whether the edit came through the Edit tool or a Bash heredoc — a Bash
command that only reads a file doesn't count as editing it, a finished
session is left out, and a changed file nobody open claims is named as such.
And, with the commands agents here really ran: a session that only runs,
copies, reads or names a file is not its editor, nor is one whose Edit call
failed or whose command names a file that hasn't changed since; while the
ways they really edit through the shell are all still caught.
"""
import json
import os
import subprocess
import time
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


def _changes(repo, *names):
    """The files a turn's commands changed, changed for real: the app checks
    a shell edit against the file itself."""
    for name in names:
        (repo / name).write_text(f"x = {time.monotonic_ns()}\n")


def _open_sessions(*convs):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    with store.mutate("bot_chats/index", {}) as index:
        for conv in convs:
            index[conv] = {"title": conv, "lane": "coding"}


def _edited(repo):
    """{session: the files it is counted as having edited, as shown}."""
    index = store.read("bot_chats/index", {})
    uncommitted, committed = edited_files.changed_in_git(repo, "2000-01-01")
    found = edited_files.edits(edited_files.open_lines("coding", index), "", repo,
                               uncommitted | committed)
    return {conv: {edited_files._shown(path, repo) for path in files}
            for conv, files in found.items()}


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
    _changes(repo, "pond.py")
    _turn(CLOSED, ("Write", {"file_path": str(repo / "garden.py"), "content": "x = 2\n"}))

    text = edited_files.section("coding", repo=repo)
    shared = text.split("## Touched by more than one open session")[1].split("## By session")[0]
    by_session = text.split("## By session")[1].split("## Uncommitted")[0]
    unclaimed = text.split("## Uncommitted in the app checkout, claimed by no open session")[1]

    assert "`pond.py`" in shared and OPEN_A in shared and OPEN_B in shared
    assert CLOSED not in text                                  # finished: not in view
    assert "notes.py" not in by_session                        # read, not edited
    assert "garden.py" in unclaimed and "notes.py" in unclaimed


def test_a_session_that_only_runs_copies_reads_or_names_a_file_is_not_its_editor(
        data_dir, tmp_path):
    """Each command is one an agent really ran, cut down, that was counted as
    an edit of a file it never changed (found 2026-10-07)."""
    repo = _repo(tmp_path)
    _open_sessions(OPEN_A, OPEN_B)
    _turn(OPEN_A, ("Edit", {"file_path": str(repo / "pond.py"), "old_string": "1",
                            "new_string": "2"}))
    _turn(OPEN_B,
          # A heredoc that ends, then a file is RUN — with an argument that looks like an assignment.
          ("Bash", {"command": "python3 - <<'E'\nimport json\nE\n"
                               "python3 pond.py \"select sum(kind='A') from mail\" | head"}),
          # A backup copy: the file is where the copy comes FROM.
          ("Bash", {"command": "mkdir -p /tmp/keep && cp pond.py notes.py /tmp/keep/ && sed -n 1,5p pond.py"}),
          # A script that edits another file, with these files' names in the text it puts there.
          ("Bash", {"command": "python3 - <<'E'\np='/tmp/list.json'; s=open(p).read()\n"
                               "a='        \"pond.py\",\\n'; s=s.replace(a,a+'        \"notes.py\",\\n')\n"
                               "open(p,'w').write(s)\nE"}),
          # A script that reads the file and writes somewhere else.
          ("Bash", {"command": "python3 - <<'E'\nwork=open('pond.py').read()\n"
                               "open('/tmp/staged.py','w').write(work)\nE"}),
          # A message and a search pattern: words, not commands.
          ("Bash", {"command": "scripts/peers.py send x \"I will run '<python> pond.py --port 0'; "
                               "rm notes.py is yours\"; grep -n \"import\\|rm\" pond.py | tee /tmp/out"}),
          # The same file's name inside a sed pattern aimed at another file.
          ("Bash", {"command": "sed -i 's/\"pond.py\", \"x.py\"/\"pond.py\", \"notes.py\"/' /tmp/list.json"}))
    # An Edit call that came back as an error changed nothing.
    path = store.DATA_DIR / "bot_chats" / f"{OPEN_B}.jsonl"
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": stamp, "message": {"content": [
            {"type": "tool_use", "id": "toolu_failed", "name": "Edit",
             "input": {"file_path": str(repo / "pond.py"), "old_string": "9", "new_string": "2"}}]}})
            + "\n" + json.dumps({"type": "user", "timestamp": stamp, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu_failed", "is_error": True,
                 "content": "String to replace not found in file."}]}}) + "\n")
    toolcallstore.live_ingest(path, OPEN_B)
    # A script that looks every bit like an edit of garden.py — but the file
    # has not changed since an hour before it ran, so it wasn't one.
    an_hour_ago = time.time() - 3600
    os.utime(repo / "garden.py", (an_hour_ago, an_hour_ago))
    _turn(OPEN_B, ("Bash", {"command": "python3 - <<'E'\np='garden.py'; s=open(p).read()\n"
                                       "open(p,'w').write(s)\nE"}))

    assert _edited(repo) == {OPEN_A: {"pond.py"}, OPEN_B: set()}
    assert "(none)" in edited_files.section("coding", repo=repo).split(
        "## Touched by more than one open session")[1].split("## By session")[0]


def test_the_ways_agents_really_edit_through_the_shell_are_caught(data_dir, tmp_path):
    repo = _repo(tmp_path)
    _open_sessions(OPEN_A, OPEN_B)
    _turn(OPEN_A,
          # A helper function the file's name is handed to, and a second file written after it.
          ("Bash", {"command": "python3 - <<'E'\ndef sub(p, old, new):\n"
                               "    s=open(p).read(); open(p,'w').write(s.replace(old,new))\n"
                               "sub('pond.py', '1', '2')\nE\n"
                               "cat > notes.py <<'E'\nx = 3\nE\npython3 -m pytest -q | tail -3"}))
    _turn(OPEN_B,
          # sed in place with a `;` in its pattern, a redirect, and a file moved away.
          ("Bash", {"command": "sed -i 's/x = 1/x = 2; y = 3/' pond.py && echo 'x = 4' >> notes.py"
                               " && git mv garden.py orchard.py"}))
    _changes(repo, "pond.py", "notes.py")
    (repo / "garden.py").rename(repo / "orchard.py")

    assert _edited(repo) == {OPEN_A: {"pond.py", "notes.py"},
                             OPEN_B: {"pond.py", "notes.py", "garden.py"}}
