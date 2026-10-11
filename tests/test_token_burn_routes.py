"""The Token burn page's route (routes/token_burn.py), end to end: logs are
written the way the harness writes them, toolcallstore ingests them, and the
route adds them up.

What earns a test here is the page's one promise — every grouping splits the
same spending, so every view adds up to the same total, and the windows cut
where they say — plus the drill-down finding the calls inside a turn.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

import toolcallstore

NOW = datetime.now(timezone.utc)


def stamp(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def call(message_id, model, hours_ago, read, write_, out, tool=None):
    """One model call as the log has it, with its final output count."""
    content = [{"type": "tool_use", "id": f"toolu_{message_id}", "name": tool,
                "input": {"command": "ls"}}] if tool else [{"type": "text", "text": "ok"}]
    return [
        json.dumps({"type": "assistant", "timestamp": stamp(hours_ago), "session_id": "s",
                    "message": {"id": message_id, "model": model, "content": content,
                                "usage": {"input_tokens": 1, "cache_creation_input_tokens": write_,
                                          "cache_read_input_tokens": read, "output_tokens": 1}}}),
        json.dumps({"type": "call-usage", "message_id": message_id, "output_tokens": out}),
    ]


def result(cost, model_usage):
    """A turn's end, fresh process: its figures are its own. `usage` counts
    the main (first) model only, as the harness's does."""
    main = next(iter(model_usage.values()))
    return json.dumps({
        "type": "result", "subtype": "success", "total_cost_usd": cost,
        "usage": {"input_tokens": main[0], "cache_creation_input_tokens": main[1],
                  "cache_read_input_tokens": main[2], "output_tokens": main[3]},
        "modelUsage": {m: {"inputTokens": f[0], "cacheCreationInputTokens": f[1],
                           "cacheReadInputTokens": f[2], "outputTokens": f[3],
                           "costUSD": f[4]} for m, f in model_usage.items()},
    })


@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    """Two sessions, two rooms, two models, and one turn three days old."""
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(tmp_path / "projects"))
    chats = data_dir / "bot_chats"
    chats.mkdir()
    (chats / "index.json").write_text(json.dumps({
        "conv-a": {"title": "Build the page", "lane": "coding"},
        "conv-b": {"title": "Morning pages", "lane": "personal", "pinned": True},
    }))
    lines_a = (call("m3", "opus", 72, 5000, 0, 100)
               + [result(1.00, {"opus": (1, 0, 5000, 100, 1.00)})]
               + call("m1", "opus", 2, 1000, 100, 40, tool="Bash")
               + call("m2", "opus", 2, 1100, 50, 20)
               + [result(0.50, {"opus": (2, 150, 2100, 60, 0.45),
                                "haiku": (10, 0, 0, 10, 0.05)})])
    lines_b = call("m4", "sonnet", 1, 400, 400, 200) + [
        result(0.30, {"sonnet": (1, 400, 400, 200, 0.30)})]
    (chats / "conv-a.jsonl").write_text("\n".join(lines_a) + "\n")
    (chats / "conv-b.jsonl").write_text("\n".join(lines_b) + "\n")
    toolcallstore.ingest()

    from flask import Flask
    from routes import token_burn
    app = Flask(__name__)
    app.config.update(TESTING=True)
    token_burn.register(app)
    return app.test_client()


def get(client, group, range_key):
    res = client.get(f"/api/token-burn?group={group}&range={range_key}")
    assert res.status_code == 200
    return res.get_json()


@pytest.mark.parametrize("range_key", ["24h", "7d", "all"])
def test_every_grouping_adds_up_to_the_same_total(client, range_key):
    views = {g: get(client, g, range_key) for g in ("model", "session", "room", "kind")}
    totals = views["model"]["totals"]
    for group, view in views.items():
        assert view["totals"] == totals
        assert sum(r["tokens"] for r in view["rows"]) == totals["tokens"], group
        assert sum(r["cost_usd"] for r in view["rows"]) == pytest.approx(totals["cost_usd"]), group
        assert sum(r["share"] for r in view["rows"]) == pytest.approx(1.0), group
    # the timeline is the same spending again, spread over time
    timeline = views["model"]["timeline"]
    assert sum(b["cache_read"] for b in timeline) == totals["cache_read"]
    assert sum(b["turns"] for b in timeline) == totals["turns"]


def test_the_window_cuts_where_it_says(client):
    day = get(client, "session", "24h")
    week = get(client, "session", "7d")
    # the three-day-old turn is in the week and not the day
    assert day["totals"]["turns"] == 2 and week["totals"]["turns"] == 3
    assert week["totals"]["cache_read"] - day["totals"]["cache_read"] == 5000
    assert week["totals"]["cost_usd"] == pytest.approx(1.80)
    assert day["totals"]["cost_usd"] == pytest.approx(0.80)


def test_rows_group_the_way_the_page_names_them(client):
    by_model = {r["key"]: r for r in get(client, "model", "7d")["rows"]}
    assert set(by_model) == {"opus", "haiku", "sonnet"}
    assert by_model["opus"]["turns"] == 2 and by_model["opus"]["sessions"] == 1
    by_room = {r["label"]: r["turns"] for r in get(client, "room", "7d")["rows"]}
    # a pinned session is the Keeper's, whatever lane it sits in
    assert by_room == {"Coding": 2, "Keeper": 1}
    sessions = {r["conv"]: r for r in get(client, "session", "7d")["rows"]}
    assert sessions["conv-a"]["label"] == "Build the page"
    kinds = {r["key"]: r["tokens"] for r in get(client, "kind", "7d")["rows"]}
    assert kinds == {"input": 14, "cache_write": 550, "cache_read": 7500, "output": 370}


def test_session_drill_down_puts_each_call_in_its_turn(client):
    res = client.get("/api/token-burn/session/conv-a")
    assert res.status_code == 200
    turns = res.get_json()["turns"]
    assert [len(t["calls"]) for t in turns] == [1, 2]
    recent = turns[1]
    assert [c["cache_read"] for c in recent["calls"]] == [1000, 1100]
    assert recent["calls"][0]["tools"] == "Bash"
    assert client.get("/api/token-burn/session/nope").status_code == 404


def test_unknown_group_or_range_is_refused(client):
    assert client.get("/api/token-burn?group=provider").status_code == 400
    assert client.get("/api/token-burn?range=90d").status_code == 400
