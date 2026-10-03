"""tools/mention_context.py — the hook that loads her journal cards about a
person or thread the first time she names them in a session.

Each test builds a small made-up vault (two people, one thread) and a card
mirror in a temp database, then calls the hook the way Claude Code does: one
JSON prompt in, one JSON reply (or silence) out.
"""
import importlib.util
import json
from datetime import date
from pathlib import Path

import pytest

import config
import sqlstore
import store
from routes import observatory

_spec = importlib.util.spec_from_file_location(
    "mention_context", Path(__file__).resolve().parents[1] / "tools" / "mention_context.py")
mention_context = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mention_context)

TODAY = date(2026, 3, 30)

ROBIN = """---
aliases: [my landlord]
---
# Robin Vale

A made-up landlord.
"""
JUNIPER = "# Juniper\n\nA made-up friend.\n"
MOVE = """---
name: The Move
aliases: [moving house]
---

## What it is
A made-up thread.
"""


def add_card(conn, card_id, body, who="B", tags=()):
    day = card_id[:10]
    ts = f"{day} {card_id[11:13]}:{card_id[13:15]}:00"
    conn.execute(
        "INSERT INTO cards (id, day, ts, who, kind, body, first_seen, last_seen)"
        " VALUES (?, ?, ?, ?, 'line', ?, 'x', 'x')", (card_id, day, ts, who, body))
    for tag in tags:
        conn.execute("INSERT INTO card_tags (card_id, tag) VALUES (?, ?)", (card_id, tag))


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "people").mkdir(parents=True)
    (content / "Threads").mkdir()
    (content / "people" / "robin.md").write_text(ROBIN)
    (content / "people" / "juniper.md").write_text(JUNIPER)
    (content / "Threads" / "the-move.md").write_text(MOVE)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv-1")
    (data_dir / "bot_chats").mkdir(exist_ok=True)
    conn = sqlstore.open_db()
    # Robin: one card that names him, one tagged without naming him, one by
    # alias, one old, one of the Keeper's, and a near-miss word.
    add_card(conn, "2026-03-20.0900b", "Robin texted about the deposit")
    add_card(conn, "2026-03-21.0900b", "he still hasn't fixed the sink", tags=["robin"])
    add_card(conn, "2026-03-22.0900b", "my landlord came by again")
    add_card(conn, "2026-01-05.0900b", "Robin was kind in January")
    add_card(conn, "2026-03-23.0900k", "Robin sounds stressed", who="K")
    add_card(conn, "2026-03-24.0900b", "watched a robinson crusoe film")
    # Juniper: nothing in the last month, two old cards.
    add_card(conn, "2025-11-02.0900b", "coffee with Juniper")
    add_card(conn, "2025-12-02.0900b", "Juniper called")
    # The thread: tagged by the nightly pass, never named in the text.
    add_card(conn, "2026-03-25.0900b", "boxes everywhere", tags=["the-move"])
    conn.commit()
    conn.close()
    return content


def send(prompt, **extra):
    return mention_context.run({"prompt": prompt, "session_id": "s1", **extra}, today=TODAY)


def pack_of(reply):
    return reply["hookSpecificOutput"]["additionalContext"]


def test_first_mention_loads_her_cards_about_a_person_from_the_last_month(vault):
    pack = pack_of(send("robin wants the rent early"))
    # Named, tagged-only and alias cards are in; oldest first.
    assert pack.index("texted about the deposit") < pack.index("fixed the sink") \
        < pack.index("my landlord came by")
    # The old card is outside the month, the Keeper's card isn't hers, and a
    # word that merely starts with the name isn't a mention.
    assert "kind in January" not in pack
    assert "sounds stressed" not in pack
    assert "crusoe" not in pack
    assert "Person: Robin Vale" in pack and "people/robin.md" in pack


def test_a_name_loads_once_per_session_and_again_in_a_new_one(vault, monkeypatch):
    assert send("saw Robin") is not None
    assert send("Robin again") is None
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv-2")
    assert "Robin Vale" in pack_of(send("Robin again"))


def test_an_empty_month_falls_back_to_her_newest_cards_of_any_age(vault):
    pack = pack_of(send("Juniper is visiting"))
    assert "coffee with Juniper" in pack and "Juniper called" in pack
    assert "nothing in the last 30 days" in pack


def test_a_busy_month_is_capped_at_the_newest_cards(vault, monkeypatch):
    monkeypatch.setattr(config, "MENTION_CONTEXT_CARDS", 2)
    pack = pack_of(send("Robin"))
    assert "texted about the deposit" not in pack
    assert "fixed the sink" in pack and "my landlord came by" in pack


def test_a_thread_loads_by_name_or_alias_from_its_tagged_cards(vault):
    pack = pack_of(send("thinking about moving house"))
    assert "Thread: The Move" in pack and "boxes everywhere" in pack


def test_only_her_own_words_can_trigger_a_load(vault):
    # A slash command, another agent's message, and the app's appended note
    # all name Robin; none of them is her.
    assert send("/thread robin") is None
    assert send('[A · "Helper" · coding · c9]\nask Robin about it') is None
    assert send("ok\n\n[System: this message cleared the open questions you had"
                " filed for the owner:\n1. Is Robin the landlord?]") is None
    # In a mixed batch her block still counts.
    batch = '[A · "Helper" · coding · c9]\nJuniper?\n\n[B · the owner]\nRobin called'
    pack = pack_of(send(batch))
    assert "Robin Vale" in pack and "Juniper" not in pack


def test_the_pack_stays_under_the_harness_limit_and_says_what_waited(vault, monkeypatch):
    conn = sqlstore.open_db()
    for minute in range(10, 30):
        add_card(conn, f"2026-03-26.09{minute}b", "Robin " + "long " * 800)
        add_card(conn, f"2026-03-27.09{minute}b", "Juniper " + "long " * 800)
    conn.commit()
    conn.close()
    monkeypatch.setattr(mention_context, "OUTPUT_BUDGET", 3000)
    monkeypatch.setattr(mention_context, "SMALLEST_SHARE", 2000)
    reply = send("Robin and Juniper both came")
    pack = pack_of(reply)
    assert len(json.dumps(reply)) < 3500
    assert "Robin Vale" in pack and "not loaded for lack of room" in pack
    # The one that waited loads on its next mention; the loaded one doesn't repeat.
    again = pack_of(send("Robin and Juniper again"))
    assert "Person: Juniper" in again and "Person: Robin Vale" not in again


def test_the_chat_gets_a_grey_line_saying_what_was_loaded(vault, data_dir):
    send("Robin wants the rent early")
    lines = [json.loads(line) for line in
             (data_dir / "bot_chats" / "conv-1.jsonl").read_text().splitlines()]
    assert lines == [{"type": "context-loaded", "ts": lines[0]["ts"], "items": lines[0]["items"],
                      "text": "loaded: Robin Vale — 3 cards, 2026-03-20 to 2026-03-22"}]


def test_a_new_people_file_is_heard_without_a_restart(vault):
    assert send("Wren is new here") is None
    (vault / "people" / "wren.md").write_text("# Wren\n\nA made-up neighbour.\n")
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-28.0900b", "met Wren on the stairs")
    conn.commit()
    conn.close()
    assert "met Wren" in pack_of(send("Wren again"))


def test_a_terminal_session_waits_until_it_is_armed(vault, tmp_path, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_CONV_ID")
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(vault))
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(json.dumps(
        {"type": "user", "message": {"content": "fix the build"}}) + "\n")
    hook_input = {"prompt": "Robin called", "session_id": "term-1",
                  "transcript_path": str(transcript)}
    assert mention_context.run(hook_input, terminal=True, today=TODAY) is None
    with transcript.open("a") as handle:
        handle.write(json.dumps({"type": "user", "message": {
            "content": "<!-- KEEPER_SESSION_ACTIVE -->"}}) + "\n")
    reply = mention_context.run(hook_input, terminal=True, today=TODAY)
    assert "Robin Vale" in pack_of(reply)
    assert reply["systemMessage"].startswith("loaded: Robin Vale")


def test_a_broken_database_never_breaks_the_message(vault, data_dir, monkeypatch, capsys):
    (data_dir / "exo.db").write_bytes(b"not a database")
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(
        {"prompt": "Robin", "session_id": "s1"})))
    assert mention_context.main() == 0
    assert capsys.readouterr().out == ""


def test_only_personal_and_journaling_sessions_are_wired(data_dir):
    def hooked(config_):
        settings = observatory._session_settings({"conv_id": "c", **config_}, ["Read"])
        return "UserPromptSubmit" in settings.get("hooks", {})
    assert hooked({"lane": "personal"})
    assert hooked({"lane": "orchestra", "journal": True})
    assert not hooked({"lane": "coding"})
    assert not hooked({"lane": "personal", "helper_gate": True})
