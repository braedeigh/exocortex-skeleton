"""tools/mention_context.py — the hook that loads her journal cards about a
person or thread the first time she names them in a session.

Each test builds a small made-up vault (two people, one thread) and a card
mirror in a temp database, then calls the hook the way Claude Code does: one
JSON prompt in, one JSON reply (or silence) out.
"""
import importlib.util
import json
from pathlib import Path

import pytest

import config
import loadrecord
import sqlstore
import store
from routes import observatory

_spec = importlib.util.spec_from_file_location(
    "mention_context", Path(__file__).resolve().parents[1] / "tools" / "mention_context.py")
mention_context = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mention_context)

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
    return mention_context.run({"prompt": prompt, "session_id": "s1", **extra})


def loads():
    """The tracker's rows, oldest first."""
    conn = sqlstore.open_db()
    try:
        return conn.execute("SELECT slug, matched, outcome, cards, skipped, card_ids"
                            " FROM context_loads ORDER BY id").fetchall()
    finally:
        conn.close()


def pack_of(reply):
    return reply["hookSpecificOutput"]["additionalContext"]


def test_first_mention_loads_her_cards_about_a_person(vault):
    pack = pack_of(send("robin wants the rent early"))
    # Named, tagged-only and alias cards are in, however old; oldest first.
    assert pack.index("kind in January") < pack.index("texted about the deposit") \
        < pack.index("fixed the sink") < pack.index("my landlord came by")
    # The Keeper's card isn't hers, and a word that merely starts with the
    # name isn't a mention.
    assert "sounds stressed" not in pack
    assert "crusoe" not in pack
    assert "Person: Robin Vale" in pack and "people/robin.md" in pack


def test_a_name_loads_once_per_session_and_again_in_a_new_one(vault, monkeypatch):
    assert send("saw Robin") is not None
    assert send("Robin again") is None
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv-2")
    assert "Robin Vale" in pack_of(send("Robin again"))


def test_cards_the_session_already_has_are_left_out_and_older_ones_take_their_place(
        vault, monkeypatch):
    # The boot package handed this session two of Robin's three recent cards.
    monkeypatch.setattr(config, "MENTION_CONTEXT_CARDS", 2)
    loadrecord.add("conv-1", cards=["2026-03-21.0900b", "2026-03-22.0900b"])
    pack = pack_of(send("Robin called"))
    assert "fixed the sink" not in pack and "my landlord came by" not in pack
    # Its two slots are filled from further back instead.
    assert "kind in January" in pack and "texted about the deposit" in pack


def test_the_same_words_under_two_ids_load_once(vault):
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-26.0900b", "Robin said the heating is fixed for good")
    add_card(conn, "2026-03-26.0902b", "Robin said the heating is fixed for good")
    conn.commit()
    conn.close()
    assert pack_of(send("Robin called")).count("heating is fixed") == 1


def test_the_message_she_just_typed_is_not_handed_back_as_history(vault):
    # The app mints her message as a card before the agent answers it.
    message = "Robin came by about the boiler this morning"
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-29.0900b", message)
    conn.commit()
    conn.close()
    pack = pack_of(send(message))
    assert "about the boiler" not in pack and "texted about the deposit" in pack


def test_two_names_in_one_session_never_share_a_card(vault):
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-27.0900b", "Robin and Juniper argued on the stairs")
    conn.commit()
    conn.close()
    first = pack_of(send("Robin called"))
    second = pack_of(send("so did Juniper"))
    assert "argued on the stairs" in first and "argued on the stairs" not in second
    assert "coffee with Juniper" in second


def test_a_name_with_nothing_new_loads_nothing_and_is_not_asked_again(vault):
    loadrecord.add("conv-1", cards=["2025-11-02.0900b", "2025-12-02.0900b"])
    assert send("Juniper is visiting") is None
    assert [(row[0], row[2], row[4]) for row in loads()] == [("juniper", "nothing new", 2)]
    assert send("Juniper again") is None and len(loads()) == 1


def test_a_screenshot_card_shows_its_words_not_its_upload_paths(vault):
    paths = " ".join(f"[uploaded: /srv/vault/data/uploads/2026030{n}_120000_IMG_{n}.png]"
                     for n in range(1, 9))
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-28.0900b", paths + " Robin's text says the rent goes up in May",
             tags=["robin"])
    conn.commit()
    conn.close()
    pack = pack_of(send("Robin"))
    assert "rent goes up in May" in pack
    assert "/srv/vault" not in pack and "[file 20260301_120000_IMG_1.png]" in pack


def test_every_load_is_tracked_with_the_word_that_set_it_off(vault):
    send("my landlord wants the rent early")
    (row,) = loads()
    assert row[:4] == ("robin", "my landlord", "loaded", 4)
    assert json.loads(row[5])[-1] == "2026-03-22.0900b"


def test_an_off_the_record_message_leaves_no_trace_but_still_loads(vault, monkeypatch):
    monkeypatch.setattr(mention_context, "_off_the_record", lambda prompt: True)
    assert "Robin Vale" in pack_of(send("Robin wants the rent early, strictly between us"))
    assert loads() == []
    assert loadrecord.read("conv-1")["texts"] == {
        loadrecord.fingerprint(body) for body in (
            "Robin texted about the deposit", "he still hasn't fixed the sink",
            "my landlord came by again", "Robin was kind in January")}


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
        add_card(conn, f"2026-03-26.09{minute}b", "Robin " + "long " * 800, tags=["robin"])
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
    assert [row[2] for row in loads()] == ["loaded", "no room", "loaded"]


def test_the_chat_gets_a_grey_line_saying_what_was_loaded(vault, data_dir):
    send("Robin wants the rent early")
    lines = [json.loads(line) for line in
             (data_dir / "bot_chats" / "conv-1.jsonl").read_text().splitlines()]
    assert lines == [{"type": "context-loaded", "ts": lines[0]["ts"], "items": lines[0]["items"],
                      "text": "loaded: Robin Vale — 4 cards, 2026-01-05 to 2026-03-22"}]


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
    assert mention_context.run(hook_input, terminal=True) is None
    with transcript.open("a") as handle:
        handle.write(json.dumps({"type": "user", "message": {
            "content": "<!-- KEEPER_SESSION_ACTIVE -->"}}) + "\n")
    reply = mention_context.run(hook_input, terminal=True)
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


# --- Names that can't be trusted as a bare word (namerisk.py) -----------------

WILL = "# Will\n\nA made-up man she met once.\n"


@pytest.fixture
def common_word_name(vault):
    """A person whose name is an ordinary word: one card really about him,
    tagged, and thirty that only use the word."""
    (vault / "people" / "will.md").write_text(WILL)
    conn = sqlstore.open_db()
    add_card(conn, "2026-02-01.0900b", "met Will at the party", tags=["will"])
    for minute in range(10, 40):
        add_card(conn, f"2026-03-10.09{minute}b", "I will do the dishes later")
    conn.commit()
    conn.close()
    return vault


def test_a_name_that_is_an_ordinary_word_loads_nothing_when_used_as_the_word(common_word_name):
    assert send("Will upgrade the updater tonight") is None
    assert send("i will do it") is None


def test_a_common_word_name_written_as_a_name_loads_only_the_tagged_cards(common_word_name):
    pack = pack_of(send("I saw Will again"))
    assert "met Will at the party" in pack
    assert "dishes" not in pack


def test_two_people_sharing_a_first_name_each_load_only_their_own_tagged_cards(vault):
    (vault / "people" / "sam.md").write_text("# Sam\n\nA made-up neighbour.\n")
    (vault / "people" / "sam-okafor.md").write_text("# Sam Okafor\n\nA made-up dentist.\n")
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-20.1000b", "Sam fixed the fence", tags=["sam"])
    add_card(conn, "2026-03-21.1000b", "Sam says no cavities", tags=["sam-okafor"])
    add_card(conn, "2026-03-22.1000b", "Sam waved, not sure which")
    conn.commit()
    conn.close()
    pack = pack_of(send("Sam came by"))
    sections = {block.split(" — ")[0]: block for block in pack.split("## Person: ")[1:]}
    assert "fence" in sections["Sam"] and "cavities" not in sections["Sam"]
    assert "cavities" in sections["Sam Okafor"] and "fence" not in sections["Sam Okafor"]
    assert "not sure which" not in pack


def test_a_message_the_app_sent_to_wake_the_session_loads_nothing(vault):
    assert send("[Background job finished — you started it in the background]\n"
                "Job: pack for The Move\nResult: exit 0") is None
    assert send("[Sudo request answered — you filed it]\nRobin approved") is None


def test_the_tracker_reads_back_each_load_beside_her_message_and_the_reply(vault, data_dir):
    from datetime import datetime, timedelta

    from scripts import context_loads

    def line(seconds_ago, **fields):
        moment = (datetime.now() - timedelta(seconds=seconds_ago)).isoformat(timespec="seconds")
        return json.dumps({"ts": moment, **fields}) + "\n"

    # The chat as the app logs it: an earlier turn, then the one that names Robin.
    log = data_dir / "bot_chats" / "conv-1.jsonl"
    log.write_text(line(600, type="user", text="good morning")
                   + json.dumps({"type": "result", "result": "Morning."}) + "\n"
                   + line(1, type="user", text="Robin wants the rent early"))
    send("Robin wants the rent early")
    with log.open("a") as handle:
        handle.write(json.dumps({"type": "result", "result": "Early again, like in March?"}) + "\n")

    (row,) = context_loads.loads(days=1)
    assert (row["slug"], row["matched"], row["cards"]) == ("robin", "Robin", 4)
    assert row["said"] == "Robin wants the rent early"
    assert row["answered"] == "Early again, like in March?"
    # A window that ended last week holds nothing from today.
    last_week = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    assert context_loads.loads(days=7, until=last_week) == []
