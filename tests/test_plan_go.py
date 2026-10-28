"""Go on her word (routes/spinoff.py go_by_word, scripts/plan_go.py).

She tells a helper "make that one go" and the helper presses the session's Go
button for her. These run a real planning session to its build card (as
test_spinoff_routes.py does), then have a helper press it through the script
door, and check the result is exactly her tap's: the builder starts, the
planner closes, and her words are on the record in the planner's chat.
"""
import json

import briefstore
import store
from routes import observatory, spinoff
from scripts import plan_go
from tests.test_spinoff_routes import (  # noqa: F401  (spinoff_client is a fixture)
    _index, _planned, spinoff_client)

HELPER = "2026-09-27.213703"


def _helper(role="room_helper"):
    with store.mutate("bot_chats/index", {}) as index:
        index[HELPER] = {"title": "Room helper", "role": role, "lane": "coding"}


def _build_card(monkeypatch, planner, slug="pond-colour"):
    """The planner saves the agreed plan and puts up its build Go card."""
    monkeypatch.setenv("EXOCORTEX_CONV_ID", planner)
    briefstore.save(slug, "# Spinoff: paint the pond\n\n## The approved plan\nBlue.\n",
                    written_by=planner)
    assert spinoff.offer_spinoff(planner, [slug])[1] == 200
    monkeypatch.delenv("EXOCORTEX_CONV_ID")


def _press(monkeypatch, caller, *arguments):
    monkeypatch.setenv("EXOCORTEX_CONV_ID", caller)
    code = plan_go.main(list(arguments))
    monkeypatch.delenv("EXOCORTEX_CONV_ID")
    return code


def test_a_helper_pressing_go_on_her_word_starts_the_builder_and_closes_the_planner(
        spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    _build_card(monkeypatch, planner)
    _helper()
    assert _press(monkeypatch, HELPER, planner, "--owner-said", "make the pond one go") == 0
    index = _index()
    builders = [cid for cid, entry in index.items() if entry.get("planned_in") == planner]
    assert len(builders) == 1 and index[builders[0]]["spinoff_stage"] == "build"
    assert index[planner].get("archived") and "spinoff_offer" not in index[planner]
    # Her words, and who pressed it, are in the planner's chat.
    lines = [json.loads(line) for line in
             (store.DATA_DIR / "bot_chats" / f"{planner}.jsonl").read_text().splitlines()]
    pressed = [line for line in lines if line.get("type") == "go-by-word"]
    assert pressed == [{"type": "go-by-word", "words": "make the pond one go",
                        "by": HELPER, "by_title": "Room helper", "ts": pressed[0]["ts"]}]


def test_only_a_helper_with_her_words_can_press_a_card_that_is_up(spinoff_client, monkeypatch):
    planner = _planned(spinoff_client, monkeypatch)
    worker = _index()[planner]["spawned_from"]   # an ordinary session
    # Not a helper: refused, card still up.
    _build_card(monkeypatch, planner)
    assert _press(monkeypatch, worker, planner, "--owner-said", "go") == 1
    assert "spinoff_offer" in _index()[planner]
    # A helper, but no words: refused before anything is read.
    _helper("swarm_helper")
    assert _press(monkeypatch, HELPER, planner, "--owner-said", "  ") == 2
    assert _press(monkeypatch, HELPER, planner) == 2
    assert spinoff.go_by_word(planner, HELPER, "")[1] == 400
    assert "spinoff_offer" in _index()[planner] and not _index()[planner].get("archived")
    # A session with no card up: refused, and nothing written to its chat.
    observatory._chats_dir()
    other = worker
    assert spinoff.go_by_word(other, HELPER, "make it go")[1] == 409
    log = store.DATA_DIR / "bot_chats" / f"{other}.jsonl"
    assert not log.exists() or "go-by-word" not in log.read_text()
