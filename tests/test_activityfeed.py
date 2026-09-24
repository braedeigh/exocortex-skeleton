"""The Activity pane's feed: a transcript read back as steps, outputs included.

Two layers. The parser (activityfeed.parse_line) is pure, so the rules for
what counts as a step are tested line by line. The route
(/api/observatory/conversation/<id>/activity) is tested for its contract
with the polling client: resume by byte offset, never hand over half a
line, and say when the read had to start over.
"""
import json

import pytest
from flask import Flask

import activityfeed
import store
from routes import observatory


def line(obj):
    return json.dumps(obj)


def call_line(tool_id, name="Bash", inp=None, parent=None):
    return line({"type": "assistant", "timestamp": "2026-09-24T12:00:00Z",
                 "parent_tool_use_id": parent,
                 "message": {"content": [{"type": "tool_use", "id": tool_id,
                                          "name": name,
                                          "input": inp or {"command": "ls"}}]}})


def result_line(tool_id, content="ok", is_error=False):
    return line({"type": "user", "timestamp": "2026-09-24T12:00:02Z",
                 "message": {"content": [{"type": "tool_result",
                                          "tool_use_id": tool_id,
                                          "content": content,
                                          "is_error": is_error}]}})


# ---------- the parser ----------

def test_tool_call_carries_name_target_and_input():
    [event] = activityfeed.parse_line(call_line("toolu_1", inp={"command": "git status"}))
    assert (event["kind"], event["id"], event["name"], event["target"]) == (
        "call", "toolu_1", "Bash", "git status")
    assert '"git status"' in event["input"]


def test_tool_output_is_kept_as_text_and_matched_by_id():
    [event] = activityfeed.parse_line(result_line("toolu_1", "hello\nworld"))
    assert (event["kind"], event["id"], event["output"], event["is_error"]) == (
        "result", "toolu_1", "hello\nworld", False)


def test_failed_tool_is_flagged_as_error():
    [event] = activityfeed.parse_line(result_line("toolu_1", "boom", is_error=True))
    assert event["is_error"] is True


def test_long_output_is_cut_and_says_so():
    big = "x" * (activityfeed._TEXT_CAP + 10)
    [event] = activityfeed.parse_line(result_line("toolu_1", big))
    assert (len(event["output"]), event["output_cut"], event["chars"]) == (
        activityfeed._TEXT_CAP, True, len(big))


def test_block_list_output_becomes_text_with_image_placeholder():
    content = [{"type": "text", "text": "seen:"}, {"type": "image", "source": {}}]
    [event] = activityfeed.parse_line(result_line("toolu_1", content))
    assert event["output"] == "seen:\n[image]"


def test_subagent_call_names_its_parent():
    [event] = activityfeed.parse_line(call_line("toolu_2", parent="toolu_agent"))
    assert event["parent"] == "toolu_agent"


def test_api_retry_is_a_step():
    [event] = activityfeed.parse_line(line({
        "type": "system", "subtype": "api_retry", "attempt": 2, "max_retries": 10,
        "error": "overloaded", "error_status": 529, "retry_delay_ms": 900}))
    assert (event["kind"], event["error"], event["status"]) == ("retry", "overloaded", 529)


def test_permission_denied_keeps_the_reason():
    [event] = activityfeed.parse_line(line({
        "type": "system", "subtype": "permission_denied", "tool_name": "Bash",
        "tool_use_id": "toolu_3", "decision_reason": "[Production Deploy]",
        "message": "denied"}))
    assert (event["kind"], event["id"], event["reason"]) == (
        "denied", "toolu_3", "[Production Deploy]")


def test_turn_end_reports_error_and_reason():
    [event] = activityfeed.parse_line(line({
        "type": "result", "subtype": "success", "is_error": True,
        "terminal_reason": "api_error", "result": "Failed to authenticate",
        "duration_ms": 176, "num_turns": 1, "total_cost_usd": 0}))
    assert (event["kind"], event["is_error"], event["reason"], event["text"]) == (
        "end", True, "api_error", "Failed to authenticate")


def test_heartbeat_points_at_the_real_call():
    [event] = activityfeed.parse_line(line({
        "type": "tool_progress", "tool_use_id": "toolu_4-heartbeat-0",
        "parent_tool_use_id": "toolu_4", "elapsed_time_seconds": 30}))
    assert (event["kind"], event["id"], event["elapsed"]) == ("progress", "toolu_4", 30)


@pytest.mark.parametrize("subtype", ["thinking_tokens", "status", "task_progress"])
def test_constant_chatter_is_skipped(subtype):
    assert activityfeed.parse_line(line({"type": "system", "subtype": subtype})) == []


def test_unknown_system_event_is_named_not_hidden():
    [event] = activityfeed.parse_line(line({"type": "system", "subtype": "compact_boundary"}))
    assert event == {"kind": "note", "subtype": "compact_boundary"}


def test_allowed_rate_limit_is_not_a_step():
    assert activityfeed.parse_line(line({
        "type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}})) == []


def test_her_message_is_a_prompt():
    [event] = activityfeed.parse_line(line({"type": "user", "text": "hi", "ts": "2026-09-24T12:00:00"}))
    assert (event["kind"], event["text"]) == ("prompt", "hi")


def test_torn_line_is_ignored():
    assert activityfeed.parse_line('{"type": "assistant", "mess') == []


# ---------- the route ----------

@pytest.fixture
def activity_client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    observatory.register(app)
    return app.test_client()


def write_log(conv_id, lines, partial=None, running=False):
    folder = store.DATA_DIR / "bot_chats"
    folder.mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {conv_id: {"running": running, "title": "A session"}})
    path = folder / f"{conv_id}.jsonl"
    with path.open("w") as fh:
        for text in lines:
            fh.write(text + "\n")
        if partial is not None:
            fh.write(partial)
    return path


def test_route_returns_events_and_where_to_resume(activity_client):
    path = write_log("c1", [call_line("toolu_1"), result_line("toolu_1")])
    body = activity_client.get("/api/observatory/conversation/c1/activity").get_json()
    assert ([e["kind"] for e in body["events"]], body["start"], body["next"]) == (
        ["call", "result"], 0, path.stat().st_size)


def test_route_resumes_from_offset_with_only_new_events(activity_client):
    path = write_log("c1", [call_line("toolu_1")])
    first = activity_client.get("/api/observatory/conversation/c1/activity").get_json()
    with path.open("a") as fh:
        fh.write(result_line("toolu_1") + "\n")
    second = activity_client.get(
        f"/api/observatory/conversation/c1/activity?from={first['next']}").get_json()
    assert [e["kind"] for e in second["events"]] == ["result"]


def test_route_leaves_a_half_written_line_for_next_time(activity_client):
    write_log("c1", [call_line("toolu_1")], partial='{"type": "user", "mess')
    body = activity_client.get("/api/observatory/conversation/c1/activity").get_json()
    assert [e["kind"] for e in body["events"]] == ["call"]


def test_route_starts_over_when_the_file_shrank(activity_client):
    write_log("c1", [call_line("toolu_1")])
    body = activity_client.get("/api/observatory/conversation/c1/activity?from=999999").get_json()
    assert (body["start"], len(body["events"])) == (0, 1)


def test_route_clips_a_long_first_read_to_whole_lines(activity_client, monkeypatch):
    monkeypatch.setattr(observatory, "_ACTIVITY_WINDOW_BYTES", 400)
    write_log("c1", [call_line(f"toolu_{i}") for i in range(20)])
    body = activity_client.get("/api/observatory/conversation/c1/activity").get_json()
    assert body["clipped"] and body["start"] > 0 and body["events"][-1]["id"] == "toolu_19"


def test_route_unknown_conversation_is_404(activity_client):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {})
    assert activity_client.get("/api/observatory/conversation/nope/activity").status_code == 404


def test_full_output_returns_the_uncut_text(activity_client):
    big = "y" * (activityfeed._TEXT_CAP * 2)
    write_log("c1", [call_line("toolu_1"), result_line("toolu_1", big)])
    body = activity_client.get(
        "/api/observatory/conversation/c1/activity/output?id=toolu_1").get_json()
    assert body["output"] == big
