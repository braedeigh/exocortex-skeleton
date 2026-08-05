"""Habits as typed rows (habitstore.py) — identity that survives the markdown.

The behavior that matters: a habit's history must stay reachable after it's
renamed, moved between sections, or dropped from HABITS.md entirely. That's the
thing the string-keyed log can't do, and every test here is a version of it.

Follows the house pattern — `data_dir` for an isolated store (and therefore an
isolated exo.db), a scratch HABITS.md pointed at by CONTENT_DIR, and assertions
against the persisted result.
"""
import pytest

import habitstore
import store


HABITS_MD = """# Habits

## Morning
- [ ] Water upon waking
- [ ] Remember to chew food
- [ ] Kefir

## Evening / Night
- [ ] Remember to chew food
- [ ] Floss
"""


@pytest.fixture
def habits_md(data_dir, tmp_path, monkeypatch):
    """A scratch HABITS.md as the current habit list."""
    content = tmp_path / "content"
    content.mkdir()
    (content / "HABITS.md").write_text(HABITS_MD)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    return content


def by_name(habits, name, section=None):
    for h in habits:
        if h["name"] == name and (section is None or h["section"] == section):
            return h
    raise AssertionError(f"no habit {name!r} (section={section!r}) in {habits}")


# --- the list becomes rows ----------------------------------------------------

def test_rebuild_creates_a_row_per_listed_habit(habits_md):
    habitstore.rebuild()
    habits = habitstore.all_habits()
    assert {(h["name"], h["section"]) for h in habits} == {
        ("Water upon waking", "morning"),
        ("Remember to chew food", "morning"),
        ("Kefir", "morning"),
        ("Remember to chew food", "evening / night"),
        ("Floss", "evening / night"),
    }
    assert all(h["active"] for h in habits)


def test_same_text_in_two_sections_stays_two_habits(habits_md):
    habitstore.rebuild()
    habits = habitstore.all_habits()
    morning = by_name(habits, "Remember to chew food", "morning")
    evening = by_name(habits, "Remember to chew food", "evening / night")
    assert morning["id"] != evening["id"]


def test_rebuild_is_idempotent_and_keeps_ids(habits_md):
    habitstore.rebuild()
    before = {(h["name"], h["section"]): h["id"] for h in habitstore.all_habits()}
    habitstore.rebuild()
    after = {(h["name"], h["section"]): h["id"] for h in habitstore.all_habits()}
    assert before == after


# --- log keys map onto rows ---------------------------------------------------

def test_qualified_key_resolves_to_its_habit(habits_md):
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    habitstore.rebuild()
    assert habitstore.resolve("morning|Kefir") == by_name(habitstore.all_habits(), "Kefir")["id"]


def test_bare_and_qualified_keys_join_into_one_habit(habits_md):
    """The key-format change mid-2026 must not split a habit in two."""
    store.write("habits_log", {
        "2026-03-01": {"Floss": True},              # legacy bare era
        "2026-06-10": {"evening / night|Floss": True},   # qualified era
    })
    habitstore.rebuild()
    floss = by_name(habitstore.all_habits(), "Floss")
    assert habitstore.resolve("Floss") == floss["id"]
    assert habitstore.resolve("evening / night|Floss") == floss["id"]
    assert habitstore.history(floss["id"]) == ["2026-03-01", "2026-06-10"]


def test_rebuild_never_writes_the_log(habits_md):
    """load_habits_log() rewrites bare keys in place; this must not."""
    raw = {"2026-03-01": {"Floss": True}}
    store.write("habits_log", raw)
    habitstore.rebuild()
    assert store.read("habits_log") == raw


# --- the orphaning this exists to fix -----------------------------------------

def test_habit_dropped_from_markdown_keeps_its_history(habits_md):
    """A habit whose line left HABITS.md is retired, not erased."""
    store.write("habits_log", {
        "2026-03-01": {"Belly massage": True},
        "2026-03-02": {"Belly massage": True},
    })
    habitstore.rebuild()
    massage = by_name(habitstore.all_habits(), "Belly massage")
    assert massage["active"] is False
    assert massage["section"] == habitstore.NO_SECTION
    assert habitstore.history(massage["id"]) == ["2026-03-01", "2026-03-02"]


def test_hidden_habit_is_inactive_but_still_queryable(habits_md):
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    store.write("habit_settings", {"hidden": ["Kefir"]})
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")
    assert kefir["active"] is False
    assert habitstore.history(kefir["id"]) == ["2026-06-10"]


def test_absence_is_the_only_not_done(habits_md):
    """schemas/habits_log.json pins every value to `const: true`, so unchecking
    DELETES the key. Absence is the only negative the format can express — which
    is why a missing day and a day never opened look identical."""
    store.write("habits_log", {
        "2026-06-10": {"morning|Kefir": True},
        "2026-06-11": {},                      # opened, not checked
        # 2026-06-12 absent entirely — never opened
    })
    habitstore.rebuild()
    assert habitstore.history(by_name(habitstore.all_habits(), "Kefir")["id"]) == ["2026-06-10"]


def test_the_log_format_cannot_record_a_false(habits_md):
    """Guards the assumption above: if this ever starts passing, history() needs
    to filter on truthiness rather than trusting presence."""
    import schemas
    with pytest.raises(schemas.SchemaError):
        store.write("habits_log", {"2026-06-11": {"morning|Kefir": False}})


# --- start dates --------------------------------------------------------------

def test_start_date_comes_from_habit_start_dates(habits_md):
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    store.write("habit_start_dates", {"Kefir": "2026-01-01"})
    habitstore.rebuild()
    assert by_name(habitstore.all_habits(), "Kefir")["started_on"] == "2026-01-01"


def test_start_date_falls_back_to_earliest_logged_day(habits_md):
    """habit_start_dates drifts from the log's text — don't leave it empty."""
    store.write("habits_log", {
        "2026-05-02": {"morning|Kefir": True},
        "2026-04-01": {"morning|Kefir": True},
    })
    habitstore.rebuild()
    assert by_name(habitstore.all_habits(), "Kefir")["started_on"] == "2026-04-01"


def test_listed_but_never_logged_habit_still_gets_a_row(habits_md):
    habitstore.rebuild()
    water = by_name(habitstore.all_habits(), "Water upon waking")
    assert water["started_on"] is None
    assert habitstore.history(water["id"]) == []


# --- merges (the owner's call, not the resolver's) ----------------------------

def test_different_texts_are_not_merged_automatically(habits_md):
    """Overlapping same-day entries mean two habits, not one rename."""
    store.write("habits_log", {"2026-03-01": {"Neck rub": True, "Neck-side rubbing": True}})
    habitstore.rebuild()
    assert by_name(habitstore.all_habits(), "Neck rub")["id"] != \
           by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]


def test_merge_unions_history_and_hides_the_source(habits_md):
    store.write("habits_log", {
        "2026-03-01": {"Neck rub": True},
        "2026-03-02": {"Neck-side rubbing": True},
    })
    habitstore.rebuild()
    src = by_name(habitstore.all_habits(), "Neck rub")["id"]
    dst = by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]
    habitstore.merge(src, dst)

    assert habitstore.resolve("Neck rub") == dst
    assert habitstore.history(dst) == ["2026-03-01", "2026-03-02"]
    assert all(h["id"] != src for h in habitstore.all_habits())
    assert any(h["id"] == src for h in habitstore.all_habits(include_merged=True))


def test_merge_survives_rebuild(habits_md):
    """rebuild() rewrites aliases every run — the merge must not be undone."""
    store.write("habits_log", {
        "2026-03-01": {"Neck rub": True},
        "2026-03-02": {"Neck-side rubbing": True},
    })
    habitstore.rebuild()
    src = by_name(habitstore.all_habits(), "Neck rub")["id"]
    dst = by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]
    habitstore.merge(src, dst)
    habitstore.rebuild()
    assert habitstore.resolve("Neck rub") == dst
    assert habitstore.history(dst) == ["2026-03-01", "2026-03-02"]


def test_unmerge_restores_the_habit(habits_md):
    store.write("habits_log", {
        "2026-03-01": {"Neck rub": True},
        "2026-03-02": {"Neck-side rubbing": True},
    })
    habitstore.rebuild()
    src = by_name(habitstore.all_habits(), "Neck rub")["id"]
    dst = by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]
    habitstore.merge(src, dst)
    habitstore.unmerge(src)
    assert habitstore.resolve("Neck rub") == src
    assert habitstore.history(dst) == ["2026-03-02"]


def test_merge_rejects_self_and_cycles(habits_md):
    store.write("habits_log", {"2026-03-01": {"Neck rub": True, "Neck-side rubbing": True}})
    habitstore.rebuild()
    a = by_name(habitstore.all_habits(), "Neck rub")["id"]
    b = by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]
    with pytest.raises(ValueError):
        habitstore.merge(a, a)
    habitstore.merge(a, b)
    with pytest.raises(ValueError):
        habitstore.merge(b, a)


# --- schema guarantees --------------------------------------------------------

def test_unresolvable_key_resolves_to_none(habits_md):
    habitstore.rebuild()
    assert habitstore.resolve("morning|Never logged") is None


def test_duplicate_section_name_pairs_are_impossible(habits_md):
    """UNIQUE(section, name) is what stops the string-key duplication returning."""
    import sqlite3
    import sqlstore
    habitstore.rebuild()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO habits (name, section) VALUES ('Kefir', 'morning')")
    finally:
        conn.close()


# --- entries (layer 2): the status the JSON log can't express -----------------

def entries(habit_id):
    import sqlstore
    conn = sqlstore.open_db()
    try:
        return conn.execute(
            "SELECT date, status, source FROM habit_entries"
            " WHERE habit_id = ? ORDER BY date", (habit_id,)).fetchall()
    finally:
        conn.close()


def test_logged_days_become_done_rows(habits_md):
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")["id"]
    assert entries(kefir) == [("2026-06-10", "done", "logged")]


def test_a_used_day_inside_the_window_becomes_an_inferred_miss(habits_md):
    """The app was open on the 11th and Kefir wasn't checked — that's a miss,
    and it's marked inferred because the log can't actually say so."""
    store.write("habits_log", {
        "2026-06-10": {"morning|Kefir": True},
        "2026-06-11": {"morning|Water upon waking": True},
        "2026-06-12": {"morning|Kefir": True},
    })
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")["id"]
    assert entries(kefir) == [
        ("2026-06-10", "done", "logged"),
        ("2026-06-11", "missed", "inferred"),
        ("2026-06-12", "done", "logged"),
    ]


def test_days_outside_the_observed_window_get_no_row(habits_md):
    """Before a habit's first log it may not have existed; after its last it may
    be retired. Writing a miss there would be inventing history."""
    store.write("habits_log", {
        "2026-06-01": {"morning|Water upon waking": True},
        "2026-06-10": {"morning|Kefir": True},
        "2026-06-20": {"morning|Water upon waking": True},
    })
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")["id"]
    assert [d for d, _, _ in entries(kefir)] == ["2026-06-10"]


def test_unopened_days_produce_nothing_for_anyone(habits_md):
    """A day absent from the log is a day with no evidence, not a day everyone
    failed. Empty day-dicts count as unopened too."""
    store.write("habits_log", {
        "2026-06-10": {"morning|Kefir": True},
        "2026-06-11": {},
        "2026-06-12": {"morning|Kefir": True},
    })
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")["id"]
    assert [d for d, _, _ in entries(kefir)] == ["2026-06-10", "2026-06-12"]


def test_entries_span_the_key_format_change(habits_md):
    store.write("habits_log", {
        "2026-03-01": {"Floss": True},
        "2026-03-02": {"evening / night|Floss": True},
    })
    habitstore.rebuild()
    floss = by_name(habitstore.all_habits(), "Floss")["id"]
    assert [d for d, _, _ in entries(floss)] == ["2026-03-01", "2026-03-02"]


def test_merged_habits_share_one_continuous_entry_record(habits_md):
    store.write("habits_log", {
        "2026-03-01": {"Neck rub": True},
        "2026-03-02": {"Neck-side rubbing": True},
    })
    habitstore.rebuild()
    src = by_name(habitstore.all_habits(), "Neck rub")["id"]
    dst = by_name(habitstore.all_habits(), "Neck-side rubbing")["id"]
    habitstore.merge(src, dst)
    habitstore.rebuild()
    assert [d for d, _, _ in entries(dst)] == ["2026-03-01", "2026-03-02"]
    assert entries(src) == []


def test_entries_are_derived_so_rebuild_rewrites_them(habits_md):
    store.write("habits_log", {"2026-06-10": {"morning|Kefir": True}})
    habitstore.rebuild()
    import sqlstore
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO habit_entries (habit_id, date, status, source)"
                 " VALUES ((SELECT id FROM habits WHERE name='Kefir'),"
                 " '2030-01-01', 'done', 'logged')")
    conn.close()
    habitstore.rebuild()
    kefir = by_name(habitstore.all_habits(), "Kefir")["id"]
    assert [d for d, _, _ in entries(kefir)] == ["2026-06-10"]


def test_status_and_source_are_constrained(habits_md):
    import sqlite3
    import sqlstore
    habitstore.rebuild()
    conn = sqlstore.open_db()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO habit_entries (habit_id, date, status, source)"
                         " VALUES (1, '2026-01-01', 'maybe', 'logged')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO habit_entries (habit_id, date, status, source)"
                         " VALUES (1, '2026-01-01', 'done', 'vibes')")
    finally:
        conn.close()
