"""The Linear feed (linear_feed.py), driven the way the minute tick drives it.

What these pin: something another person does in Linear is written down once
and wakes the Linear helper once, as a System turn started from the helper's
seed; the same thing read again does nothing; what the owner did herself —
and so what her sessions did, under her name — is never news. The first look
ever lists old news without waking anyone. The helper is shown the sessions
that work in Linear, whatever room they are in. The page's route lists the
news without calling Linear.

A fake Linear stands in for linear_api._post, so no test reaches the network,
and the phone push is recorded instead of sent.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from flask import Flask

import config
import linear_api
import linear_feed
import recap_summary
import store
from routes import linear_room, observatory

ME = {"id": "user-me", "name": "me@example.com", "displayName": "me"}
THEM = {"id": "user-them", "name": "Them"}
KEY = "lin_api_good"


def _ago(minutes):
    """A time the way Linear writes it, this many minutes ago."""
    return linear_feed._utc(datetime.now(timezone.utc) - timedelta(minutes=minutes))


class FakeLinear:
    """A small Linear: one team, and whatever issues and comments a test puts
    in it. Answers the feed's queries the way Linear does — only what is newer
    than `since` — and counts the calls."""

    def __init__(self):
        self.issues, self.comments, self.calls = [], [], 0

    def issue(self, ident, updated, creator=ME, created=None, assignee=None, history=()):
        self.issues.append({
            "id": f"id-{ident}", "identifier": ident, "title": f"title {ident}",
            "url": f"https://linear.app/x/issue/{ident}",
            "createdAt": created or _ago(100000), "updatedAt": updated,
            "creator": creator, "assignee": assignee, "history": {"nodes": list(history)}})

    def comment(self, comment_id, ident, at, user, body):
        self.comments.append({
            "id": comment_id, "createdAt": at, "url": f"https://linear.app/x/issue/{ident}#c",
            "body": body, "user": user, "botActor": None,
            "issue": {"id": f"id-{ident}", "identifier": ident, "title": f"title {ident}",
                      "url": f"https://linear.app/x/issue/{ident}", "assignee": None}})

    def __call__(self, query, variables, key):
        if key != KEY:
            raise linear_api.LinearAuthError("Linear refused the API key.")
        self.calls += 1
        page = {"hasNextPage": False, "endCursor": None}
        if "query FeedIssues" in query:
            return {"issues": {"pageInfo": page, "nodes": [
                i for i in self.issues if i["updatedAt"] > variables["since"]]}}
        if "query FeedComments" in query:
            return {"comments": {"pageInfo": page, "nodes": [
                c for c in self.comments if c["createdAt"] > variables["since"]]}}
        return {"viewer": ME, "teams": {"nodes": [{
            "id": "team-1", "key": "BAS", "name": "Basedfoods",
            "states": {"nodes": []}, "members": {"nodes": []}}]}}


def _move(row_id, at, actor, before, after, **more):
    return {"id": row_id, "createdAt": at, "updatedAt": at, "actor": actor,
            "fromState": {"name": before}, "toState": {"name": after}, **more}


@pytest.fixture
def feed(data_dir, tmp_path, monkeypatch):
    """A saved key, a fake Linear, turn launches and phone pushes recorded,
    and a first look already taken — so what a test adds next is new."""
    fake, turns, pushes = FakeLinear(), [], []
    monkeypatch.setattr(linear_api, "_post", fake)
    monkeypatch.delenv("EXOCORTEX_LINEAR_API_KEY", raising=False)
    monkeypatch.setattr(config, "LINEAR_TEAM_KEY", "")
    monkeypatch.setattr(store, "LINEAR_ROOM_DIR", tmp_path / "linear-room")
    monkeypatch.setattr(recap_summary, "_spawn", lambda fn: None)
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv_id, log_path:
                        turns.append((conv_id, text, config)) or True)
    monkeypatch.setattr(linear_feed, "_push", lambda title, body: pushes.append((title, body)))
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    config.linear_api_key_path().write_text(KEY)
    return fake, turns, pushes


def _free(helper):
    """The helper's recorded turn never ends by itself: end it, so the next
    wake-up starts instead of waiting behind it."""
    with store.mutate("bot_chats/index", {}) as index:
        index[helper]["running"] = False


def test_someone_elses_comment_is_recorded_once_wakes_the_helper_once_and_hers_is_ignored(feed):
    fake, turns, pushes = feed
    assert linear_feed.tick() == 0 and turns == []          # the first look: nothing there

    fake.issue("BAS-5", _ago(1))
    fake.comment("c-theirs", "BAS-5", _ago(1), THEM, "Use the server. Why Hono?")
    fake.comment("c-hers", "BAS-5", _ago(1), ME, "A session wrote this in her name.")
    assert linear_feed.tick() == 1

    # One event written down: theirs. Hers is not news.
    [event] = linear_feed.recent()
    assert (event["actor"], event["kind"], event["identifier"]) == ("Them", "comment", "BAS-5")
    # The Linear helper was made and woken with it, as a System turn from its seed.
    [(conv, text, turn_config)] = turns
    entry = store.read("bot_chats/index", {})[conv]
    assert entry["role"] == "linear_helper" and turn_config["helper_gate"] is True
    assert "Them commented on BAS-5" in text and "Use the server. Why Hono?" in text
    assert "A session wrote this" not in text
    seed = open(turn_config["system_prompt_file"], encoding="utf-8").read()
    assert "You are the Linear helper" in seed and "# Recent Linear news" in seed
    log = (store.DATA_DIR / "bot_chats" / f"{conv}.jsonl").read_text().splitlines()
    assert json.loads(log[-1])["source"] == "linear-feed"
    # A comment calls on her, so it went to her phone too.
    assert pushes == [("Linear · Them commented on BAS-5", "Use the server. Why Hono?")]

    # Seen again a minute later — Linear still returns it inside the overlap —
    # nothing is written and nobody is woken.
    _free(conv)
    assert linear_feed.tick() == 0
    assert len(linear_feed.recent()) == 1 and len(turns) == 1 and len(pushes) == 1


def test_moves_assignments_and_new_issues_by_others_are_news_and_her_own_are_not(feed):
    fake, turns, pushes = feed
    linear_feed.tick()
    fake.issue("BAS-7", _ago(1), history=[
        # Linear folds one person's quick changes into one row: both are news.
        _move("h1", _ago(1), THEM, "Todo", "Done", toAssignee=ME),
        _move("h2", _ago(1), ME, "Backlog", "Todo"),
    ])
    fake.issue("BAS-40", _ago(1), creator=THEM, created=_ago(1))
    fake.issue("BAS-41", _ago(1), creator=ME, created=_ago(1))
    assert linear_feed.tick() == 3
    told = {(e["identifier"], e["summary"]) for e in linear_feed.recent()}
    assert told == {("BAS-7", "moved it from Todo to Done"), ("BAS-7", "assigned it to you"),
                    ("BAS-40", "created the issue")}
    # Her phone hears only what calls on her: the assignment, not the move.
    assert pushes == [("Linear · Them assigned it to you: BAS-7", "title BAS-7")]

    # The same history row grows (they moved it again): only the new move is news.
    fake.issues[0]["history"]["nodes"][0] = _move("h1", _ago(0), THEM, "Todo", "Canceled",
                                                  toAssignee=ME)
    fake.issues[0]["updatedAt"] = _ago(0)
    _free(turns[0][0])
    assert linear_feed.tick() == 1
    assert "moved it from Todo to Canceled" in turns[-1][1] and "assigned it to you" not in turns[-1][1]


def test_the_first_look_lists_old_news_without_waking_anyone(feed):
    fake, turns, pushes = feed
    fake.issue("BAS-5", _ago(60))
    fake.comment("c-old", "BAS-5", _ago(60), THEM, "An answer from yesterday.")
    fake.comment("c-ancient", "BAS-5", _ago(60 * 24 * 30), THEM, "From last month.")
    assert linear_feed.tick() == 0 and turns == [] and pushes == []
    assert [e["body"] for e in linear_feed.recent(days=60)] == ["An answer from yesterday."]
    assert linear_feed.find_helper() is None


def test_news_waits_when_linear_cant_be_reached_and_no_key_means_no_look(feed, monkeypatch):
    fake, turns, _ = feed
    linear_feed.tick()
    config.linear_api_key_path().write_text("lin_api_revoked")
    assert linear_feed.tick() == 0 and "refused" in linear_feed.state()["error"]
    # The key is put right: the comment made meanwhile is still news.
    fake.issue("BAS-5", _ago(1))
    fake.comment("c1", "BAS-5", _ago(1), THEM, "Still here.")
    config.linear_api_key_path().write_text(KEY)
    assert linear_feed.tick() == 1 and linear_feed.state()["error"] is None
    config.linear_api_key_path().unlink()
    calls = fake.calls
    assert linear_feed.tick() == 0 and fake.calls == calls


def test_the_helper_is_shown_the_sessions_that_work_in_linear_whatever_their_room(feed):
    import sqlstore
    now = datetime.now().isoformat(timespec="seconds")
    with store.mutate("bot_chats/index", {}) as index:
        index["2026-10-01.090000"] = {"title": "builds from Linear", "lane": "coding", "last_at": now}
        index["2026-10-01.091000"] = {"title": "unrelated", "lane": "coding", "last_at": now}
        index["2026-10-01.092000"] = {"title": "in the room", "lane": "linear", "last_at": now}
        index["2026-10-01.093000"] = {"title": "used Linear, finished", "lane": "coding",
                                      "last_at": now, "done_at": now}
    conn = sqlstore.open_db()
    for number, conv in enumerate(("2026-10-01.090000", "2026-10-01.093000")):
        conn.execute("INSERT INTO tool_calls (tool_use_id, source, conv, at, day, hour, name)"
                     " VALUES (?, 'observatory', ?, ?, ?, 9, 'mcp__linear__save_comment')",
                     (f"t{number}", conv, now, now[:10]))
    conn.commit()
    conn.close()
    lines = linear_feed.watched_lines(store.read("bot_chats/index", {}))
    assert set(lines) == {"2026-10-01.090000", "2026-10-01.092000"}


def test_the_page_lists_the_news_and_keeps_the_helper_out_of_the_session_list(feed):
    fake, turns, _ = feed
    linear_feed.tick()
    fake.issue("BAS-5", _ago(1))
    fake.comment("c1", "BAS-5", _ago(1), THEM, "Looks good.")
    linear_feed.tick()
    app = Flask(__name__)
    app.config.update(TESTING=True)
    linear_room.register(app)
    client = app.test_client()
    calls = fake.calls
    body = client.get("/api/linear-room/feed").get_json()
    [event] = body["events"]
    assert event["actor"] == "Them" and event["body"] == "Looks good." and event["for_owner"]
    room = client.get("/api/linear-room").get_json()
    assert room["helper"] == body["helper"] == turns[0][0]
    assert room["sessions"] == [] and room["news_times"] == [event["at"]]
    assert fake.calls == calls                      # neither route called Linear
