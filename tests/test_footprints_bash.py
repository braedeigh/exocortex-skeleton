"""The footprint extractor's Bash harvest (scripts/extract_footprints.py,
`bash_touches`).

A session under the harness's auto permission mode works through the shell,
so its files only reach the terrain map if the command text is read. The
owner's rule for what counts: only files the command actually opened,
changed, or ran — never the ones a search happened to name. Pure-data layer:
a temp tree, a command string, the list of touches it yields.
"""
import json

import pytest

import scripts.extract_footprints as extract_footprints
from scripts.extract_footprints import bash_touches, harvest_conversation


@pytest.fixture(autouse=True)
def _allow_tmp(monkeypatch):
    """The harvester drops /tmp as scratch; pytest's temp tree lives there.
    Lift that one guard for these tests so the fixture tree is visible."""
    monkeypatch.setattr(extract_footprints, "_BASH_SKIP_PREFIXES", ("/dev/", "/proc/"))


def _tree(tmp_path):
    (tmp_path / "routes").mkdir()
    (tmp_path / "routes" / "todos.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "routes" / "notes.py").write_text("y = 2\n", encoding="utf-8")
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "job.py").write_text("print(1)\n", encoding="utf-8")
    return tmp_path


def _kinds(touches):
    return sorted((kind, abspath.rsplit("/", 1)[-1]) for kind, abspath in touches)


def test_sed_in_place_is_a_write(tmp_path):
    root = _tree(tmp_path)
    got = bash_touches("sed -i 's/x = 1/x = 2/' routes/todos.py", str(root))
    assert _kinds(got) == [("write", "todos.py")]


def test_sed_print_range_is_a_read(tmp_path):
    root = _tree(tmp_path)
    got = bash_touches("sed -n '1,40p' routes/todos.py", str(root))
    assert _kinds(got) == [("read", "todos.py")]


def test_searches_contribute_nothing_even_on_a_real_file(tmp_path):
    root = _tree(tmp_path)
    assert bash_touches("grep -rn todos routes/", str(root)) == []
    assert bash_touches("grep -n 'x = 1' routes/todos.py", str(root)) == []
    assert bash_touches("git log -- routes/todos.py && ls routes", str(root)) == []


def test_sed_pipe_delimiters_do_not_split_the_command(tmp_path):
    """A pattern like s|a|b| must stay one token, or the file after it is lost."""
    root = _tree(tmp_path)
    cmd = "sed -i 's|x = 1|x = 3|' routes/todos.py && grep -n 'x = 3' routes/todos.py"
    assert _kinds(bash_touches(cmd, str(root))) == [("write", "todos.py")]


def test_variable_set_earlier_in_the_command_is_substituted(tmp_path):
    root = _tree(tmp_path)
    cmd = "f=routes/todos.py && sed -i '1s/x/z/' $f && g=routes/notes.py && cat $g"
    assert _kinds(bash_touches(cmd, str(root))) == [("read", "notes.py"), ("write", "todos.py")]


def test_redirect_target_is_a_write_and_heredoc_content_is_not_parsed(tmp_path):
    root = _tree(tmp_path)
    cmd = "cat > routes/notes.py <<'EOF'\ncat routes/todos.py\nEOF"
    assert _kinds(bash_touches(cmd, str(root))) == [("write", "notes.py")]


def test_python_heredoc_reads_and_writes_the_paths_it_names(tmp_path):
    root = _tree(tmp_path)
    reader = ("python3 - <<'PY'\nimport pathlib\n"
              "s = pathlib.Path('routes/todos.py').read_text()\nprint(len(s))\nPY")
    assert _kinds(bash_touches(reader, str(root))) == [("read", "todos.py")]
    writer = ("python3 - <<'PY'\nimport pathlib\np = pathlib.Path('routes/todos.py')\n"
              "p.write_text(p.read_text().replace('1', '2'))\nPY")
    assert _kinds(bash_touches(writer, str(root))) == [("write", "todos.py")]


def test_running_a_file_counts_as_using_it(tmp_path):
    root = _tree(tmp_path)
    assert _kinds(bash_touches("./venv/bin/python3 scripts/job.py --flag", str(root))) == [
        ("read", "job.py")]
    assert _kinds(bash_touches("bash scripts/job.py", str(root))) == [("read", "job.py")]


def test_cd_moves_the_base_for_later_pieces(tmp_path):
    root = _tree(tmp_path)
    assert _kinds(bash_touches("cd routes && cat todos.py", str(root))) == [("read", "todos.py")]


def test_scratch_and_missing_files_are_dropped(tmp_path):
    root = _tree(tmp_path)
    (tmp_path / "gone.py")  # never created
    assert bash_touches("cat gone.py routes/*.py", str(root)) == []
    assert bash_touches("cat /dev/null", str(root)) == []


def test_bash_touches_reach_the_harvest(tmp_path):
    """End to end: a transcript whose only tool is Bash yields a footprint."""
    root = _tree(tmp_path)
    log = tmp_path / "conv.jsonl"
    events = [
        {"type": "user", "ts": "2026-09-17T18:00:00"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "Bash",
             "input": {"command": "sed -i '1s/x/q/' routes/todos.py && cat routes/notes.py"}},
        ]}},
        {"type": "user", "timestamp": "2026-09-17T23:00:05.000Z", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": ""},
        ]}},
    ]
    log.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    files = harvest_conversation(str(log), str(root))
    todos = files[str(root / "routes" / "todos.py")]
    notes = files[str(root / "routes" / "notes.py")]
    assert (todos["writes"], todos["reads"]) == (1, 0)
    assert (notes["writes"], notes["reads"]) == (0, 1)
    assert todos["last"] is not None
