"""The Keeper's boot package (scripts/boot_context.py).

Each test builds a tiny fake vault in tmp_path and points the store at it, so
nothing here reads real journal files.
"""
import json
from datetime import date

import pytest

import store
from scripts import boot_context


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "Journal" / "Daily").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    return content


def _manifest(data_dir, manifest):
    (data_dir / "keeper_boot.json").write_text(json.dumps(manifest))


def test_named_files_come_in_manifest_order(vault, data_dir):
    (vault / "A.md").write_text("alpha rules")
    (vault / "B.md").write_text("beta rules")
    _manifest(data_dir, {"sections": [{"title": "Rules", "files": ["B.md", "A.md"]}]})
    out = boot_context.build(date(2026, 9, 25))
    assert out.index("beta rules") < out.index("alpha rules")


def test_last_n_takes_the_newest_files_oldest_first(vault, data_dir):
    daily = vault / "Journal" / "Daily"
    for day in ("2026-09-20", "2026-09-21", "2026-09-22"):
        (daily / f"{day}.md").write_text(f"entry {day}")
    _manifest(data_dir, {"sections": [{"dir": "Journal/Daily", "glob": "*.md", "last": 2}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "entry 2026-09-20" not in out
    assert out.index("entry 2026-09-21") < out.index("entry 2026-09-22")


def test_numbered_names_sort_as_numbers(vault, data_dir):
    diary = vault / "diary"
    diary.mkdir()
    (diary / "99-old.md").write_text("old keeper")
    (diary / "205-new.md").write_text("new keeper")
    _manifest(data_dir, {"sections": [{"dir": "diary", "glob": "[0-9]*.md", "last": 1}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "new keeper" in out and "old keeper" not in out


def test_long_files_are_cut_with_a_pointer_to_the_rest(vault, data_dir):
    (vault / "Big.md").write_text("x" * 500)
    _manifest(data_dir, {"sections": [{"files": ["Big.md"], "max_chars": 100}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "cut at 100 characters" in out
    assert "x" * 101 not in out


def test_weekday_sections_only_appear_on_their_day(vault, data_dir):
    (vault / "SUNDAY.md").write_text("sunday passes")
    _manifest(data_dir, {"sections": [{"files": ["SUNDAY.md"], "weekday": "sunday"}]})
    assert "sunday passes" not in boot_context.build(date(2026, 9, 25))   # a Friday
    assert "sunday passes" in boot_context.build(date(2026, 9, 27))       # a Sunday


def test_missing_file_is_named_not_dropped(vault, data_dir):
    _manifest(data_dir, {"sections": [{"files": ["Nope.md"]}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "Nope.md" in out and "missing" in out


def test_no_manifest_falls_back_to_the_default_and_says_so(vault, data_dir):
    (vault / "CLAUDE.md").write_text("seed keeper")
    out = boot_context.build(date(2026, 9, 25))
    assert "seed keeper" in out and "built-in default" in out


def test_broken_manifest_falls_back_instead_of_crashing(vault, data_dir):
    (data_dir / "keeper_boot.json").write_text("{not json")
    out = boot_context.build(date(2026, 9, 25))
    assert "unreadable" in out


def test_package_says_the_keeper_may_read_beyond_it(vault, data_dir):
    out = boot_context.build(date(2026, 9, 25))
    assert "not your" in out and "boundary" in out


def test_coming_up_is_the_last_section(vault, data_dir):
    import comingup
    comingup.add_item({"title": "Festival", "date": "2026-10-02"}, "manual")
    (vault / "CLAUDE.md").write_text("rules")
    out = boot_context.build(date(2026, 9, 25))
    assert out.rindex("## Coming up") > out.index("rules")
    assert "Festival" in out


def test_manifest_root_is_relative_to_the_data_dir(data_dir, tmp_path, monkeypatch):
    elsewhere = tmp_path / "vault-content"
    elsewhere.mkdir()
    (elsewhere / "R.md").write_text("rooted file")
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "wrong")
    _manifest(data_dir, {"root": "vault-content", "sections": [{"files": ["R.md"]}]})
    # data_dir IS tmp_path here, so root "vault-content" resolves beside it
    assert "rooted file" in boot_context.build(date(2026, 9, 25))


# --- Journal days from the cards in the database ------------------------------

def _card(conn, card_id, body, who="B", kind="line"):
    day = card_id[:10]
    ts = f"{day} {card_id[11:13]}:{card_id[13:15]}:00"
    conn.execute(
        "INSERT INTO cards (id, day, ts, who, kind, body, first_seen, last_seen)"
        " VALUES (?, ?, ?, ?, ?, ?, 'x', 'x')", (card_id, day, ts, who, kind, body))


@pytest.fixture
def journal(vault, data_dir):
    """Three days of cards, and a manifest that loads the days from them."""
    import sqlstore
    conn = sqlstore.open_db()
    _card(conn, "2026-09-22.0900b", "an old day " + "x" * 300)
    _card(conn, "2026-09-23.0800k", "A quiet Wednesday. Keeper: Fen", who="K", kind="context")
    _card(conn, "2026-09-23.0900k", "How did you sleep?", who="K")
    _card(conn, "2026-09-23.0901b", "Badly, the neighbour was drilling")
    _card(conn, "2026-09-23.1200s", "Reminder: dentist at three", who="S")
    _card(conn, "2026-09-24.1000b", "Feeling better today")
    conn.commit()
    conn.close()
    _manifest(data_dir, {"sections": [
        {"title": "Days", "cards": True, "min_days": 2, "budget_chars": 400,
         "dir": "Journal/Daily", "glob": "*.md", "last": 2}]})
    return vault


def test_days_come_from_the_cards_with_ids_and_every_speaker_in_order(journal):
    out, cards = boot_context.build_package(date(2026, 9, 25))
    # The context line heads the day; the Keeper's question, her answer and
    # the system reminder follow in time order, each named by its card id.
    assert out.index("A quiet Wednesday") < out.index("K [0900k]: *How did you sleep?*") \
        < out.index("B [0901b]: Badly, the neighbour") < out.index("S [1200s]: Reminder: dentist") \
        < out.index("B [1000b]: Feeling better today")
    # The budget stops the walk at two days, and what was loaded is reported.
    assert "an old day" not in out
    assert [card["id"] for card in cards] == [
        "2026-09-23.0800k", "2026-09-23.0900k", "2026-09-23.0901b", "2026-09-23.1200s",
        "2026-09-24.1000b"]


def test_a_card_written_since_the_last_sync_is_in_the_package(journal):
    pool = journal / "_system" / "data" / "cards"
    pool.mkdir(parents=True)
    (pool / "2026-09-24.2350b.md").write_text(
        "---\nid: 2026-09-24.2350b\nwho: B\nts: 2026-09-24 23:50:00\nreply_to: null\n"
        "tags: []\nkind: line\nrefs: []\nsession: null\n---\nstill awake at midnight\n")
    assert "B [2350b]: still awake at midnight" in boot_context.build(date(2026, 9, 25))


def test_with_no_cards_in_the_database_the_day_files_are_used(vault, data_dir):
    (vault / "Journal" / "Daily" / "2026-09-24.md").write_text("the day as a file")
    _manifest(data_dir, {"sections": [
        {"title": "Days", "cards": True, "dir": "Journal/Daily", "glob": "*.md", "last": 2}]})
    out, cards = boot_context.build_package(date(2026, 9, 25))
    assert "the day as a file" in out and cards == []


def test_pages_loaded_through_the_database_follow_their_files(vault, data_dir):
    weekly = vault / "Journal" / "Weekly"
    weekly.mkdir()
    for week in ("W37", "W38", "W39"):
        (weekly / f"2026-{week}.md").write_text(f"summary of {week}")
    _manifest(data_dir, {"sections": [
        {"dir": "Journal/Weekly", "glob": "*.md", "last": 2, "source": "database"}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "summary of W37" not in out
    assert out.index("summary of W38") < out.index("summary of W39")
    # The file is still what gets edited; the next package has the new words,
    # and a file that is deleted drops out.
    (weekly / "2026-W39.md").write_text("W39, rewritten")
    (weekly / "2026-W38.md").unlink()
    out = boot_context.build(date(2026, 9, 25))
    assert "W39, rewritten" in out and "summary of W38" not in out and "summary of W37" in out


def test_what_the_wake_loaded_is_not_loaded_again_when_she_names_someone(
        journal, data_dir, monkeypatch):
    """The whole point: boot the Keeper, then name a person whose cards the
    boot already held. The pack reaches past them."""
    import importlib.util
    from pathlib import Path

    import loadrecord
    import sqlstore
    from routes import observatory

    spec = importlib.util.spec_from_file_location(
        "mention_context", Path(boot_context.__file__).resolve().parents[1]
        / "tools" / "mention_context.py")
    mention_context = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mention_context)

    (journal / "people").mkdir()
    (journal / "Threads").mkdir()
    (journal / "people" / "sam.md").write_text("# Sam\n\nA made-up neighbour.\n")
    conn = sqlstore.open_db()
    _card(conn, "2026-06-01.0900b", "Sam lent me a ladder back in June")
    _card(conn, "2026-09-24.1100b", "Sam was drilling again this morning")
    conn.commit()
    conn.close()
    (data_dir / "bot_chats").mkdir(exist_ok=True)
    monkeypatch.setattr(boot_context, "date", type("Fixed", (date,), {
        "today": classmethod(lambda cls: date(2026, 9, 25))}))

    assert observatory.attach_boot_package("conv-7")
    assert "2026-09-24.1100b" in loadrecord.read("conv-7")["cards"]
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "conv-7")
    reply = mention_context.run({"prompt": "Sam knocked on my door", "session_id": "s"})
    pack = reply["hookSpecificOutput"]["additionalContext"]
    assert "ladder back in June" in pack and "drilling again" not in pack
    conn = sqlstore.open_db()
    rows = conn.execute("SELECT source, slug, outcome, cards, skipped FROM context_loads"
                        " ORDER BY id").fetchall()
    conn.close()
    assert [tuple(row) for row in rows] == [
        ("boot", None, "loaded", 6, 0), ("mention", "sam", "loaded", 1, 1)]
