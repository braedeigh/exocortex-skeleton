"""Habits log keying: 'section|text' so identical habit text can live in two
sections with independent done-state (the 'chew food m/n/e' suffix fix)."""
import pytest

import store
import data_helpers as dh
from routes import habits


HABITS_MD = """# Habits

## Morning
- [ ] Water upon waking
- [ ] Remember to chew food

## Evening / Night
- [ ] Remember to chew food
- [ ] BPC-157
"""


@pytest.fixture
def habits_md(data_dir, tmp_path, monkeypatch):
    """Point CONTENT_DIR (both the store seam and the routes module's bound
    copy) at a scratch HABITS.md."""
    content = tmp_path / "content"
    content.mkdir()
    (content / "HABITS.md").write_text(HABITS_MD)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    monkeypatch.setattr(habits, "CONTENT_DIR", content)
    return content


@pytest.fixture
def client(habits_md):
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    habits.register(app)
    return app.test_client()


def read_log():
    return store.read("habits_log.json", {})


# --- migration ---

def test_migration_qualifies_bare_keys_by_current_section(habits_md):
    store.write("habits_log.json", {
        "2026-06-10": {"Water upon waking": True, "BPC-157": True},
        "2026-06-11": {"Water upon waking": True},
    })
    log = dh.load_habits_log()
    assert log["2026-06-10"] == {
        "morning|Water upon waking": True,
        "evening / night|BPC-157": True,
    }
    # persisted, not just returned
    assert "morning|Water upon waking" in read_log()["2026-06-11"]


def test_migration_leaves_unknown_texts_bare(habits_md):
    store.write("habits_log.json", {"2026-01-01": {"Deleted habit": True, "BPC-157": True}})
    log = dh.load_habits_log()
    assert log["2026-01-01"]["Deleted habit"] is True
    assert log["2026-01-01"]["evening / night|BPC-157"] is True


def test_migration_noop_when_already_qualified(habits_md):
    store.write("habits_log.json", {"2026-06-12": {"morning|Water upon waking": True}})
    assert dh.load_habits_log() == {"2026-06-12": {"morning|Water upon waking": True}}


# --- toggle: same text, two sections, independent state ---

def test_same_text_in_two_sections_tracks_independently(client):
    client.post("/api/habits/toggle", json={
        "habit": "Remember to chew food", "section": "Morning", "date": "2026-06-12"})
    log = read_log()["2026-06-12"]
    assert log == {"morning|Remember to chew food": True}
    client.post("/api/habits/toggle", json={
        "habit": "Remember to chew food", "section": "Evening / Night", "date": "2026-06-12"})
    log = read_log()["2026-06-12"]
    assert log["morning|Remember to chew food"] is True
    assert log["evening / night|Remember to chew food"] is True
    # untoggle morning only
    client.post("/api/habits/toggle", json={
        "habit": "Remember to chew food", "section": "Morning", "date": "2026-06-12"})
    log = read_log()["2026-06-12"]
    assert "morning|Remember to chew food" not in log
    assert log["evening / night|Remember to chew food"] is True


def test_toggle_with_section_absorbs_legacy_bare_entry(client):
    store.write("habits_log.json", {"2026-06-12": {"Water upon waking": True, "x": True}})
    client.post("/api/habits/toggle", json={
        "habit": "Water upon waking", "section": "Morning", "date": "2026-06-12"})
    log = read_log()["2026-06-12"]
    assert "Water upon waking" not in log
    assert log["morning|Water upon waking"] is True


# --- rename / move keep history attached ---

def test_rename_rewrites_qualified_history(client):
    store.write("habits_log.json", {
        "2026-06-10": {"morning|Remember to chew food": True},
        "2026-06-11": {"Remember to chew food": True},   # legacy bare
    })
    client.post("/api/habits/rename", json={
        "old": "Remember to chew food", "new": "Chew slowly", "section": "Morning"})
    log = read_log()
    assert log["2026-06-10"] == {"morning|Chew slowly": True}
    assert log["2026-06-11"] == {"morning|Chew slowly": True}


def test_move_between_sections_carries_history(client, habits_md):
    store.write("habits_log.json", {"2026-06-10": {"evening / night|BPC-157": True}})
    client.post("/api/habits/move", json={"item": "BPC-157", "to_section": "Morning"})
    assert read_log()["2026-06-10"] == {"morning|BPC-157": True}
    md = (habits_md / "HABITS.md").read_text()
    assert md.index("BPC-157") < md.index("## Evening / Night")
