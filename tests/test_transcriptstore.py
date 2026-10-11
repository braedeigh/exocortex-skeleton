"""transcriptstore.py — conversations in, topics filed, pond cards and search out.

Every test runs against a fresh transcripts.db in the `data_dir` tmp folder.
Times are pinned to UTC so a day boundary means the same thing on every box.
"""
import time

import pytest

import transcriptstore as ts


@pytest.fixture(autouse=True)
def utc(monkeypatch):
    monkeypatch.setenv("TZ", "UTC")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def conv(source_id, title="Chat", updated=100.0, messages=None, source="chatgpt", created=86400.0):
    return {"source": source, "source_id": source_id, "title": title,
            "created_at": created, "updated_at": updated,
            "messages": messages if messages is not None else [
                {"role": "user", "text": "hello there", "at": 86400.0 + 3600},
                {"role": "assistant", "text": "hi back", "at": 86400.0 + 3660}]}


def _only_id():
    return ts.unsorted()[0]["id"]


def test_importing_the_same_export_twice_does_not_duplicate(data_dir):
    assert ts.save([conv("a"), conv("b")]) == {"added": 2, "updated": 0, "unchanged": 0}
    assert ts.save([conv("a"), conv("b")]) == {"added": 0, "updated": 0, "unchanged": 2}
    assert ts.stats()["conversations"] == 2


def test_a_changed_conversation_is_replaced_and_queued_to_sort_again(data_dir):
    ts.save([conv("a")])
    ts.file_under(_only_id(), ["Baking"])
    longer = conv("a", updated=200.0, messages=[{"role": "user", "text": "new words", "at": None}])
    assert ts.save([longer])["updated"] == 1
    waiting = ts.unsorted()
    assert [m["text"] for m in waiting[0]["messages"]] == ["new words"]


def test_the_same_id_from_two_services_is_two_conversations(data_dir):
    ts.save([conv("x", source="chatgpt"), conv("x", source="claude")])
    assert ts.stats()["conversations"] == 2


def test_filing_joins_existing_topics_whatever_the_letter_case(data_dir):
    ts.save([conv("a"), conv("b")])
    first, second = [c["id"] for c in ts.unsorted()]
    ts.file_under(first, ["Sourdough"])
    ts.file_under(second, ["sourdough", "Garden"])
    names = {t["name"]: len(t["conversations"]) for t in ts.topics()}
    assert names == {"Sourdough": 2, "Garden": 1}


def test_a_conversation_can_sit_under_several_topics_and_each_links_back(data_dir):
    ts.save([conv("a", title="Bread and beds")])
    conv_id = _only_id()
    ts.file_under(conv_id, ["Baking", "Garden"])
    for topic in ts.topics():
        assert topic["conversations"] == [{"id": conv_id, "title": "Bread and beds"}]


def test_refiling_removes_topics_left_empty(data_dir):
    ts.save([conv("a")])
    conv_id = _only_id()
    ts.file_under(conv_id, ["Old idea"])
    ts.file_under(conv_id, ["New idea"])
    assert [t["name"] for t in ts.topics()] == ["New idea"]


def test_filed_conversations_leave_the_sorting_queue(data_dir):
    ts.save([conv("a"), conv("b")])
    ts.file_under(ts.unsorted()[0]["id"], ["Topic"])
    assert ts.stats()["unsorted"] == 1 and len(ts.unsorted()) == 1


def test_topic_names_come_busiest_first(data_dir):
    ts.save([conv("a"), conv("b")])
    first, second = [c["id"] for c in ts.unsorted()]
    ts.file_under(first, ["Rare", "Common"])
    ts.file_under(second, ["Common"])
    assert ts.topic_names() == ["Common", "Rare"]


def test_pond_cards_are_messages_shaped_like_the_journal_pond(data_dir):
    ts.save([conv("a")])
    conv_id = _only_id()
    ts.file_under(conv_id, ["Greetings"])
    tag = ts.topics()[0]["tag"]
    cards, truncated = ts.pond_cards()
    assert not truncated
    assert cards[0] == {"id": f"{conv_id}:0", "day": "1970-01-02", "ts": "1970-01-02 01:00:00",
                        "who": "B", "kind": "chatgpt", "tags": [tag], "body": "hello there",
                        "conv": conv_id}
    assert cards[1]["who"] == "K"


def test_a_message_without_a_time_takes_its_conversations_day_and_no_clock(data_dir):
    ts.save([conv("a", messages=[{"role": "user", "text": "undated", "at": None}])])
    card = ts.pond_cards()[0][0]
    assert (card["day"], card["ts"]) == ("1970-01-02", None)


def test_a_message_with_no_time_anywhere_is_left_off_the_pond(data_dir):
    ts.save([conv("a", created=None, messages=[{"role": "user", "text": "lost", "at": None}])])
    assert ts.pond_cards()[0] == []


def test_pond_cards_past_the_limit_keep_the_newest(data_dir):
    ts.save([conv("a")])
    cards, truncated = ts.pond_cards(limit=1)
    assert truncated and cards[0]["body"] == "hi back"


def test_search_matches_words_in_any_message_as_prefixes(data_dir):
    ts.save([conv("a", title="Bread"), conv("b", title="Beds", messages=[
        {"role": "user", "text": "which hostas grow in shade?", "at": 90000.0}])])
    assert len(ts.search("host shade")) == 1
    assert ts.search("") is None
    assert [c["body"] for c in ts.pond_cards(query="hostas")[0]] == ["which hostas grow in shade?"]


def test_search_survives_punctuation_that_is_fts_syntax(data_dir):
    ts.save([conv("a")])
    assert ts.search('hello" (*') == ts.search("hello") == {_only_id()}


def test_one_conversation_comes_back_whole_with_its_topics(data_dir):
    ts.save([conv("a", title="Greeting")])
    conv_id = _only_id()
    ts.file_under(conv_id, ["Hellos"], summary="Two people say hello.")
    full = ts.conversation(conv_id)
    assert full["title"] == "Greeting" and full["summary"] == "Two people say hello."
    assert [t["name"] for t in full["topics"]] == ["Hellos"]
    assert [m["text"] for m in full["messages"]] == ["hello there", "hi back"]
    assert ts.conversation(9999) is None
