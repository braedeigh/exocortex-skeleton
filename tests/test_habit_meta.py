"""Course habits: a habit can carry an optional time-limited 'course' (e.g. a
10-day antibiotic) that auto-archives when it ends, and can be configured into
one or more time-of-day sections in a single call (/api/habits/configure)."""
from datetime import date

import pytest

import store
import habit_meta as hm
from routes import habits


HABITS_MD = """# Habits

## Morning
- [ ] Water upon waking

## Midday
- [ ] Water - noon

## Evening / Night
- [ ] Floss
"""


@pytest.fixture
def habits_md(data_dir, tmp_path, monkeypatch):
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


def configure(client, **kw):
    return client.post("/api/habits/configure", json=kw)


# --- create / multi-section ---

def test_configure_adds_to_multiple_sections_with_course(client, habits_md):
    r = configure(client, name="Doxycycline", sections=["Morning", "Evening / Night"], course_days=10)
    assert r.status_code == 200
    md = (habits_md / "HABITS.md").read_text()
    assert md.count("- [ ] Doxycycline") == 2          # one per section
    meta = store.read("habit_meta.json")
    assert meta["morning|Doxycycline"]["course_days"] == 10
    assert meta["evening / night|Doxycycline"]["course_days"] == 10


def test_configure_without_course_leaves_no_meta(client, habits_md):
    configure(client, name="Kefir", sections=["Morning"], course_days=0)
    assert "- [ ] Kefir" in (habits_md / "HABITS.md").read_text()
    assert store.read("habit_meta.json", {}) == {}


# --- reconfigure: section membership + overlays ---

def test_deselecting_a_section_removes_it_and_drops_overlays(client, habits_md):
    configure(client, name="Doxycycline", sections=["Morning", "Evening / Night"], course_days=10)
    configure(client, name="Doxycycline", sections=["Morning"], course_days=10)
    md = (habits_md / "HABITS.md").read_text()
    assert md.count("- [ ] Doxycycline") == 1
    assert "Doxycycline" in md.split("## Evening / Night")[0]   # the survivor is the morning one
    meta = store.read("habit_meta.json")
    assert "morning|Doxycycline" in meta
    assert "evening / night|Doxycycline" not in meta           # overlay cleaned up


def test_setting_course_to_zero_clears_meta_but_keeps_habit(client, habits_md):
    configure(client, name="Kefir", sections=["Morning"], course_days=10)
    assert "morning|Kefir" in store.read("habit_meta.json")
    configure(client, name="Kefir", sections=["Morning"], course_days=0)
    assert store.read("habit_meta.json", {}) == {}
    assert "- [ ] Kefir" in (habits_md / "HABITS.md").read_text()  # still a (permanent) habit


def test_course_start_is_preserved_across_reconfigure(client, habits_md):
    configure(client, name="Doxycycline", sections=["Morning"], course_days=10)
    start = store.read("habit_meta.json")["morning|Doxycycline"]["course_start"]
    configure(client, name="Doxycycline", sections=["Morning"], course_days=14)
    m = store.read("habit_meta.json")["morning|Doxycycline"]
    assert m["course_start"] == start      # didn't restart the clock
    assert m["course_days"] == 14


# --- validation ---

def test_configure_requires_name_and_at_least_one_section(client, habits_md):
    assert configure(client, sections=["Morning"], course_days=0).status_code == 400
    assert configure(client, name="X", sections=[], course_days=0).status_code == 400


# --- pure course math ---

def test_course_day_and_expiry():
    entry = {"course_start": "2026-06-25", "course_days": 10}
    assert hm.course_day(entry, date(2026, 6, 25)) == 1     # start day = day 1
    assert hm.course_day(entry, date(2026, 7, 4)) == 10     # final day
    assert not hm.is_expired(entry, date(2026, 7, 4))       # day 10 still active
    assert hm.is_expired(entry, date(2026, 7, 5))           # day 11 → archived
    assert hm.course_day({}, date(2026, 6, 25)) is None     # not a course
