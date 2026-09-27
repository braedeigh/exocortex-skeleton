"""toolcallstore.py — the tool-call ledger read out of the agent logs.

Same two layers as test_commandstore.py: `parse_line` is pure and asserted on
hand-built lines, and the ingest path runs against a real tmp database with a
fake bot_chats dir and a fake ~/.claude/projects tree.

The cases that earn a test: a call read from both records counting once, a
result landing on its call (with a duration), a subagent's call keeping its
parent, a turn result being dated by the clock before it even across a
resumed scan, and the watermark resuming rather than skipping.
"""
import json

import pytest

import sqlstore
import toolcallstore


def call_line(tool_id="toolu_1", name="Bash", inp=None, ts="2026-09-24T16:56:29.403Z",
              parent=None, session="s1", **top):
    d = {"type": "assistant", "uuid": "u-" + tool_id, "timestamp": ts,
         "session_id": session, "parent_tool_use_id": parent, "cwd": "/opt/x",
         "message": {"model": "claude-fable-5-1", "role": "assistant",
                     "content": [{"type": "tool_use", "id": tool_id, "name": name,
                                  "input": inp if inp is not None else {"command": "ls"}}]}}
    d.update(top)
    return json.dumps(d)


def result_line(tool_id="toolu_1", content="a\nb", ts="2026-09-24T16:56:30.903Z",
                is_error=False):
    block = {"type": "tool_result", "tool_use_id": tool_id, "content": content}
    if is_error:
        block["is_error"] = True
    return json.dumps({"type": "user", "uuid": "r-" + tool_id, "timestamp": ts,
                       "session_id": "s1", "message": {"role": "user", "content": [block]}})


def turn_line(cost=0.5):
    return json.dumps({"type": "result", "subtype": "success", "session_id": "s1",
                       "stop_reason": "end_turn", "duration_ms": 1200, "duration_api_ms": 1000,
                       "num_turns": 3, "total_cost_usd": cost,
                       "usage": {"input_tokens": 10, "cache_read_input_tokens": 20,
                                 "cache_creation_input_tokens": 5, "output_tokens": 7,
                                 "output_tokens_details": {"thinking_tokens": 2}},
                       "modelUsage": {"claude-fable-5-1": {}}})


def test_parse_call_keeps_target_and_input():
    rows = toolcallstore.parse_line(call_line(inp={"file_path": "/a/b.py"}, name="Edit"),
                                    "observatory", "conv1")
    call = [r for r in rows if r["kind"] == "call"][0]
    assert call["name"] == "Edit"
    assert call["target"] == "/a/b.py"
    assert json.loads(call["input"]) == {"file_path": "/a/b.py"}
    assert call["conv"] == "conv1"
    assert call["at"] == toolcallstore._local("2026-09-24T16:56:29.403Z")
    assert call["day"] == call["at"][:10]


def test_parse_input_is_capped_and_flagged():
    big = {"command": "x" * 10000}
    call = [r for r in toolcallstore.parse_line(call_line(inp=big), "claude")
            if r["kind"] == "call"][0]
    assert call["input_truncated"] == 1
    assert len(call["input"]) == toolcallstore._INPUT_CAP


def test_parse_result_measures_never_copies():
    rows = toolcallstore.parse_line(result_line(content="hello world", is_error=True), "claude")
    res = [r for r in rows if r["kind"] == "result"][0]
    assert res["result_chars"] == len("hello world")
    assert res["is_error"] == 1
    assert "hello world" not in json.dumps(res)


def test_grep_target_names_where_it_looked():
    assert toolcallstore.target_of("Grep", {"pattern": "foo", "path": "/src"}) == "foo in /src"


def test_unrelated_lines_are_cheap_and_empty():
    assert toolcallstore.parse_line('{"type":"system","subtype":"status"}', "claude") == []
    assert toolcallstore.parse_line("not json {", "claude") == []


@pytest.fixture
def roots(tmp_path, data_dir, monkeypatch):
    """A fake bot_chats dir (inside the isolated data dir) and a fake
    ~/.claude/projects tree."""
    chats = data_dir / "bot_chats"
    chats.mkdir()
    (chats / "index.json").write_text(json.dumps(
        {"2026-09-24.115556": {"claude_session_id": "s1", "lane": "coding"}}))
    projects = tmp_path / "projects"
    (projects / "-opt-x").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(projects))
    return chats, projects


def write(path, lines):
    path.write_text("\n".join(lines) + "\n")
    return path


def rows(sql):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def test_same_call_in_both_records_counts_once(roots):
    chats, projects = roots
    write(chats / "2026-09-24.115556.jsonl", [call_line(), result_line()])
    write(projects / "-opt-x" / "s1.jsonl", [call_line(), result_line()])
    stats = toolcallstore.ingest()
    assert stats["calls"] == 1
    got = rows("SELECT source, conv, duration_ms, result_chars FROM tool_calls")
    assert got == [("observatory", "2026-09-24.115556", 1500, 3)]


def test_terminal_only_call_is_claude_sourced_and_joins_by_session(roots):
    chats, projects = roots
    write(projects / "-opt-x" / "s1.jsonl", [call_line()])
    toolcallstore.ingest()
    # Known session id -> the index maps it back to its conversation.
    assert rows("SELECT source, conv FROM tool_calls") == [("claude", "2026-09-24.115556")]


def test_subagent_call_keeps_its_parent(roots):
    chats, projects = roots
    write(chats / "2026-09-24.115556.jsonl",
          [call_line(tool_id="toolu_agent", name="Agent", inp={"description": "look"}),
           call_line(tool_id="toolu_child", parent="toolu_agent")])
    toolcallstore.ingest()
    assert rows("SELECT parent_tool_use_id FROM tool_calls WHERE tool_use_id='toolu_child'") \
        == [("toolu_agent",)]


def test_turn_result_is_dated_by_the_clock_before_it(roots):
    chats, projects = roots
    write(chats / "2026-09-24.115556.jsonl", [call_line(), result_line(), turn_line()])
    stats = toolcallstore.ingest()
    assert stats["turns"] == 1
    got = rows("SELECT seq, at, cost_usd, thinking_tokens, model FROM turn_results")
    assert got == [(1, toolcallstore._local("2026-09-24T16:56:30.903Z"), 0.5, 2,
                    "claude-fable-5-1")]


def test_resumed_scan_still_dates_and_numbers_turns(roots):
    """The result event has no timestamp; a scan that resumes right before
    it must still date it (from the stored clock) and number it (from the
    stored count)."""
    chats, projects = roots
    p = write(chats / "2026-09-24.115556.jsonl", [call_line(), result_line(), turn_line()])
    toolcallstore.ingest()
    with p.open("a") as fh:
        fh.write(turn_line(cost=0.25) + "\n")
    stats = toolcallstore.ingest()
    assert stats["turns"] == 1
    got = rows("SELECT seq, at, cost_usd FROM turn_results ORDER BY seq")
    assert [g[0] for g in got] == [1, 2]
    assert got[1][1] == got[0][1]
    assert got[1][2] == 0.25


def test_rerun_adds_nothing_and_appended_lines_are_picked_up(roots):
    chats, projects = roots
    p = write(chats / "2026-09-24.115556.jsonl", [call_line()])
    toolcallstore.ingest()
    again = toolcallstore.ingest()
    assert again["calls"] == 0 and again["skipped"] == 1
    with p.open("a") as fh:
        fh.write(result_line() + "\n")
    more = toolcallstore.ingest()
    assert more["results"] == 1
    assert rows("SELECT duration_ms FROM tool_calls") == [(1500,)]


def test_rebuild_and_summary(roots):
    chats, projects = roots
    write(chats / "2026-09-24.115556.jsonl",
          [call_line(), result_line(is_error=True), call_line(tool_id="toolu_2", name="Read",
                                                              inp={"file_path": "/f"})])
    toolcallstore.ingest()
    assert toolcallstore.rebuild()["calls"] == 2
    summary = {r["name"]: r for r in toolcallstore.summary()}
    assert summary["Bash"]["errors"] == 1
    assert summary["Read"]["unanswered"] == 1


# --- model calls: token accounting per call to the model (docs/swarms.md) ----

def _assistant(message_id, blocks, usage, ts="2026-09-24T16:56:29.403Z"):
    return json.dumps({"type": "assistant", "timestamp": ts, "session_id": "s1",
                       "parent_tool_use_id": None,
                       "message": {"id": message_id, "model": "claude-opus-5-5",
                                   "content": blocks, "usage": usage}})


USAGE = {"input_tokens": 2, "cache_creation_input_tokens": 100,
         "cache_read_input_tokens": 5000, "output_tokens": 7}   # 7 = partial


def test_one_model_call_split_over_lines_is_one_row_with_final_output(roots):
    chats, _ = roots
    write(chats / "2026-09-24.115556.jsonl", [
        _assistant("msg_1", [{"type": "tool_use", "id": "toolu_a", "name": "Read",
                              "input": {"file_path": "/x"}}], USAGE),
        _assistant("msg_1", [{"type": "tool_use", "id": "toolu_b", "name": "Read",
                              "input": {"file_path": "/y"}}], USAGE),
        json.dumps({"type": "call-usage", "message_id": "msg_1",
                    "output_tokens": 640, "thinking_tokens": 500}),
    ])
    toolcallstore.ingest()
    [(conv, context, output, thinking, tools)] = rows(
        "SELECT conv, context_tokens, output_tokens, thinking_tokens, tool_use_ids"
        " FROM model_calls")
    assert conv == "2026-09-24.115556"
    assert context == 5102
    # the partial 7 in the assistant lines is never kept
    assert (output, thinking) == (640, 500)
    assert sorted(json.loads(tools)) == ["toolu_a", "toolu_b"]


def test_final_usage_read_before_the_call_still_lands(roots):
    chats, _ = roots
    write(chats / "2026-09-24.115556.jsonl", [
        json.dumps({"type": "call-usage", "message_id": "msg_2", "output_tokens": 9}),
        _assistant("msg_2", [{"type": "text", "text": "hi"}], USAGE),
    ])
    toolcallstore.ingest()
    assert rows("SELECT output_tokens, context_tokens FROM model_calls") == [(9, 5102)]
