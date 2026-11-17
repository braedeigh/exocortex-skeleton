"""scripts/thread_tending.py — the nightly check that cards are filed under the
right threads and people, one isolated session per thread.

Each test builds a small made-up vault (two threads, two people who share a
first name, a card pool as rows in a test exo.db) and runs a whole night with
the agent sessions replaced by a stand-in that answers from a script.
Everything else is real: the planning, the journal engine's `tag` and `untag`
verbs and its label rows (who added a label, which night, why, its weight),
the approval queue and its Approve and Deny routes.
"""
import importlib.util
import json
import sqlite3
from contextlib import closing
from datetime import date
from pathlib import Path

import pytest
from flask import Flask

import store
import personsheets
import threadsummaries
from routes import pending, threads

_spec = importlib.util.spec_from_file_location(
    "thread_tending", Path(__file__).resolve().parents[1] / "scripts" / "thread_tending.py")
tending = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tending)

NIGHT = date(2026, 3, 10)


def thread_file(name, charter):
    return (f"---\nname: {name}\ncharter: {charter}\naliases: []\nfronts: [health]\nparents: []\n"
            f"people: []\nkind: standing\nstatus: active\nopened: 2026-01-01\nretired:\ndistilled:\n---\n")


def mint(content, card_id, body, tags=(), by="migration", note_on=None):
    """One card as a row in exo.db, saved at its own time (so it is past its
    24 hours, like any old card), with `tags` as labels added by `by`, and
    optionally linked as a later note on an older card."""
    import journaldb
    said = f"{card_id[:10]} {card_id[11:13]}:{card_id[13:15]}:00"
    with closing(journaldb.connect(journaldb.db_path())) as conn:
        journaldb.insert_card(conn, id=card_id, who="B", said_at=said, body=body,
                              saved_at=said)
        context = journaldb.LabelContext(content, store.DATA_DIR)
        for tag in tags:
            journaldb.add_label(conn, card_id, tag, by, context)
        if note_on:
            journaldb.link(conn, card_id, note_on, "note", by="test", linked_at=said)
    # The engine's compatibility file, as every real write leaves one (for the
    # readers that still open files; a no-op once those are retired).
    tending._stream()._sync_card_file(card_id)


def label_rows(card_id, include_removed=False):
    """A card's label rows from exo.db, oldest first, as dicts."""
    import journaldb
    with closing(journaldb.connect(journaldb.db_path())) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(
            "SELECT l.slug, cl.added_by, cl.run, cl.reason, cl.weight, cl.removed_at, cl.removed_by"
            " FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = ?"
            + ("" if include_removed else " AND cl.removed_at IS NULL") + " ORDER BY cl.id", (card_id,))]


def tags_of(content, card_id):
    """A card's live labels, in the order they were put on."""
    return [row["slug"] for row in label_rows(card_id)]


def take_off(card_id, tag):
    """The owner takes a label off a card, the way the journal page does."""
    import journaldb
    with closing(journaldb.connect(journaldb.db_path())) as conn:
        assert journaldb.remove_label(conn, card_id, tag, journaldb.OWNER, "not this") == "removed"


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    data, content = tmp_path / "data", tmp_path / "content"
    data.mkdir()
    (content / "Threads").mkdir(parents=True)
    (content / "people").mkdir()
    monkeypatch.setattr(store, "DATA_DIR", data)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(content))
    monkeypatch.setenv("TULKU_STREAM_DB", str(data / "exo.db"))   # for stream.py subprocesses
    # The app's own database (from the migrated template), word index and all.
    import sqlstore
    sqlstore._connect().close()
    (content / "Threads" / "garden.md").write_text(thread_file("Garden", "the vegetable beds"))
    (content / "Threads" / "knee.md").write_text(thread_file("Knee", "the sore knee"))
    (content / "people" / "sam.md").write_text("# Sam\n\nA made-up neighbour.\n")
    (content / "people" / "sam-okafor.md").write_text("# Sam Okafor\n\nA made-up dentist.\n")
    mint(content, "2026-03-08.0900b", "planted the beans", tags=["garden"])
    mint(content, "2026-03-10.0900b", "weeded the beds, knee ached after")
    mint(content, "2026-03-10.0910b", "bought a rake", tags=["knee"])
    mint(content, "2026-03-10.0920b", "Sam said my teeth look fine", tags=["sam"])
    mint(content, "2026-03-10.0930b", "nothing much today")
    return content


def scripted(answers, seen=None):
    """A stand-in for run_session: answers each session from `answers`, keyed
    by the session's name, and records the job each one was given."""
    def session(role, job, night_dir, name, crickets_dir, model, log):
        if seen is not None:
            seen[name] = job
        return answers.get(name)
    return session


def night(answers, seen=None, target=NIGHT):
    return tending.tend(target, Path("/nowhere"), session=scripted(answers, seen), out=lambda _: None)


ANSWERS = {
    "main": {"threads": {"garden": ["2026-03-10.0900b"], "knee": ["2026-03-10.0900b"]}},
    "thread.garden": {"belongs": [{"card": "2026-03-10.0900b", "reason": "weeding is bed work"}],
                      "movement": [{"text": "weeded the beds", "sources": ["2026-03-10.0900b"]}],
                      "summary": "Beans in, beds weeded."},
    "thread.knee": {"belongs": ["2026-03-10.0900b"],
                    "does_not_belong": [{"card": "2026-03-10.0910b", "reason": "a rake is not a knee"}]},
    "overlap": {"cards": {"2026-03-10.0900b": {"about": "garden"},
                          "2026-03-10.0920b": {"about": "sam-okafor"}}},
    "person.shared_sam": {"verdicts": [
        {"card": "2026-03-10.0920b", "person": "sam-okafor", "reason": "teeth: the dentist"}]},
    "sheet.sam": {"change": False, "reason": "nothing new"},
    "sheet.sam-okafor": {"change": False, "reason": "nothing new"},
}


def test_each_thread_session_sees_only_its_own_threads_cards(vault):
    seen = {}
    night(ANSWERS, seen)
    assert [c["id"] for c in seen["thread.garden"]["cards"]] == ["2026-03-08.0900b", "2026-03-10.0900b"]
    assert [c["id"] for c in seen["thread.knee"]["cards"]] == ["2026-03-10.0900b", "2026-03-10.0910b"]
    assert "knee" not in json.dumps({k: v for k, v in seen["thread.garden"].items() if k != "cards"})


def test_a_night_tags_what_belongs_and_asks_before_removing_anything(vault):
    outcome = night(ANSWERS)
    # Both threads keep the card they both claimed; the dentist gets his card.
    assert tags_of(vault, "2026-03-10.0900b") == ["garden", "knee"]
    assert "sam-okafor" in tags_of(vault, "2026-03-10.0920b")
    # Nothing was removed: the wrong tags are still on, and waiting for a tap.
    assert tags_of(vault, "2026-03-10.0910b") == ["knee"]
    assert "sam" in tags_of(vault, "2026-03-10.0920b")
    asked = {(p["payload"]["card_id"], p["payload"]["tag"])
             for p in store.read("pending_changes", {"pending": []})["pending"]}
    assert asked == {("2026-03-10.0910b", "knee"), ("2026-03-10.0920b", "sam")}
    assert "weeded the beds" in (store.DATA_DIR / "thread_tending" / "2026-03-10" / "digest.md").read_text()
    assert outcome["failed"] == []


def test_approving_a_removal_takes_the_tag_off_the_card(vault):
    night(ANSWERS)
    app = Flask(__name__)
    pending.register(app)
    queue = store.read("pending_changes", {"pending": []})["pending"]
    rake = next(p for p in queue if p["payload"]["card_id"] == "2026-03-10.0910b")
    assert app.test_client().post("/api/pending/approve", json={"id": rake["id"]}).get_json() == {"ok": True}
    assert tags_of(vault, "2026-03-10.0910b") == []


def test_the_overlap_session_can_give_a_contested_card_to_one_thread(vault):
    outcome = night({**ANSWERS, "overlap": {"cards": {"2026-03-10.0900b": {"about": "garden", "drop": ["knee"]}}}})
    assert tags_of(vault, "2026-03-10.0900b") == ["garden"]
    assert {"card": "2026-03-10.0900b", "tag": "knee"} in outcome["dropped"]


def test_a_session_cannot_tag_a_card_outside_its_own_job(vault):
    night({**ANSWERS, "thread.garden": {"belongs": ["2026-03-10.0930b", "2026-03-10.0900b"]}})
    assert tags_of(vault, "2026-03-10.0930b") == []


def test_the_next_night_looks_only_at_new_cards_and_asks_nothing_twice(vault):
    night(ANSWERS)
    mint(vault, "2026-03-11.0900b", "the beans sprouted")
    seen = {}
    night({"main": {"threads": {"garden": ["2026-03-11.0900b"]}},
           "thread.garden": {"belongs": ["2026-03-11.0900b"]}}, seen, target=date(2026, 3, 11))
    assert [c["id"] for c in seen["thread.garden"]["cards"]] == ["2026-03-11.0900b"]
    assert "thread.knee" not in seen and "person.shared_sam" not in seen
    assert len(store.read("pending_changes", {"pending": []})["pending"]) == 2


def test_a_thread_whose_session_failed_is_looked_at_again_the_next_night(vault):
    night({**ANSWERS, "thread.knee": None})
    seen = {}
    night(ANSWERS, seen, target=date(2026, 3, 11))
    assert [c["id"] for c in seen["thread.knee"]["cards"]] == ["2026-03-10.0900b", "2026-03-10.0910b"]


LONG = "The beds are weeded. " + "More was said about the soil than fits here. " * 20
BEAN_FACT = {"section": "Mar 11 — the beans sprouted", "text": "the beans sprouted",
             "sources": ["2026-03-11.0900b"]}


def stack_of(slug):
    app = Flask(__name__)
    threads.register(app)
    return app.test_client().get(f"/api/thread/{slug}/summaries").get_json()["summaries"]


@pytest.fixture
def facts_written(monkeypatch):
    """Stand in for the `thread` tool's add-card: record the fact, accept it."""
    written = []
    monkeypatch.setattr(tending, "add_fact", lambda slug, fact: (written.append((slug, fact)), (True, ""))[1])
    return written


def test_a_thread_gets_a_new_summary_only_on_a_night_a_fact_is_written(vault, facts_written):
    """Three nights on one thread, read back the way the thread's page reads
    them. New cards alone add nothing; a fact adds one summary, on top."""
    night(ANSWERS)                                   # a card belongs, no fact
    assert stack_of("garden") == []
    mint(vault, "2026-03-11.0900b", "the beans sprouted")
    seen = {}
    night({"main": {"threads": {"garden": ["2026-03-11.0900b"]}},
           "thread.garden": {"belongs": ["2026-03-11.0900b"], "facts": [BEAN_FACT], "summary": LONG}},
          seen, target=date(2026, 3, 11))
    # The session was handed the thread's older cards, so it can cover the whole thread.
    assert [c["id"] for c in seen["thread.garden"]["history"]] == ["2026-03-08.0900b", "2026-03-10.0900b"]
    mint(vault, "2026-03-12.0900b", "watered the beans")
    night({"main": {"threads": {"garden": ["2026-03-12.0900b"]}},
           "thread.garden": {"belongs": ["2026-03-12.0900b"], "summary": "Watered."}},
          target=date(2026, 3, 12))

    (only,) = stack_of("garden")
    assert facts_written == [("garden", BEAN_FACT)]
    assert only["author"] == "cricket:thread-helper" and only["status"] is None
    # The over-long one was cut at a sentence, not mid-word.
    assert only["body"].startswith("The beds are weeded.") and only["body"].endswith(".")
    assert threadsummaries.word_count(only["body"]) <= threadsummaries.MAX_WORDS
    assert only["based_on"] == ["2026-03-11.0900b"]
    assert stack_of("knee") == []


def set_status(vault, slug, status):
    path = vault / "Threads" / f"{slug}.md"
    text = path.read_text()
    current = next(line for line in text.splitlines() if line.startswith("status:"))
    path.write_text(text.replace(current, f"status: {status}"))


def test_a_thread_whose_status_changed_gets_a_summary_marked_with_the_new_status(vault):
    """Whatever changed the status, the next night notices and asks one session
    for that thread's summary. A failed session is asked again the next night,
    and an unchanged thread is never asked."""
    night(ANSWERS)                                   # first sight: statuses only remembered
    set_status(vault, "knee", "retired")
    seen = {}
    night({}, seen, target=date(2026, 3, 11))        # the status session fails
    assert seen["status.knee"]["status_before"] == "active"
    assert seen["status.knee"]["status_now"] == "retired"
    assert [c["id"] for c in seen["status.knee"]["cards"]] == ["2026-03-10.0900b", "2026-03-10.0910b"]
    assert stack_of("garden") == [] and threadsummaries.for_thread("knee") == []

    seen = {}
    night({"status.knee": {"summary": "Mar 10: the knee ached after weeding. Retired Mar 11.",
                           "based_on": ["2026-03-10.0900b", "not-a-card-in-the-job"]}},
          seen, target=date(2026, 3, 12))
    (row,) = threadsummaries.for_thread("knee")
    assert (row["status"], row["based_on"]) == ("retired", ["2026-03-10.0900b"])
    assert "status.garden" not in seen

    seen = {}
    night({}, seen, target=date(2026, 3, 13))        # nothing changed since: nobody is asked
    assert not [name for name in seen if name.startswith("status.")]


def test_a_trial_run_stores_no_summary(vault, facts_written):
    mint(vault, "2026-03-11.0900b", "the beans sprouted")
    tending.tend(date(2026, 3, 11), Path("/nowhere"), apply=False, out=lambda _: None, session=scripted({
        "main": {"threads": {"garden": ["2026-03-11.0900b"]}},
        "thread.garden": {"belongs": ["2026-03-11.0900b"], "facts": [BEAN_FACT], "summary": "Beans up."}}))
    assert threadsummaries.for_thread("garden") == [] and facts_written == []


OLD_SHEET = ("Who: a neighbour\nPronouns: not on record\nTied to: the street\n"
             "Now: nothing pending\nLast contact: 2026-03-08")
NEW_SHEET = OLD_SHEET.replace("2026-03-08", "2026-03-10")


def sheet_sessions(seen):
    return sorted(name for name in seen if name.startswith("sheet."))


def test_a_changed_sheet_lands_on_top_and_is_not_asked_for_again_that_night(vault):
    personsheets.add("sam", "cricket:person-sheet", OLD_SHEET, ["2026-03-08"])
    answers = {**ANSWERS, "sheet.sam": {"change": True, "sheet": NEW_SHEET,
                                        "based_on": ["2026-03-10.0920b"], "reason": "new date"}}
    seen = {}
    outcome = night(answers, seen)
    assert seen["sheet.sam"]["current_sheet"]["body"] == OLD_SHEET
    assert [p["slug"] for p in seen["sheet.sam"]["same_name"]] == ["sam-okafor"]
    top, under = personsheets.for_person("sam")
    assert (top["body"], top["author"], top["based_on"]) == (NEW_SHEET, "cricket:person-sheet", ["2026-03-10.0920b"])
    assert under["body"] == OLD_SHEET
    assert [item["slug"] for item in outcome["sheets"] if item["changed"] and item["ok"]] == ["sam"]
    assert "new fact sheet for `sam`" in (store.DATA_DIR / "thread_tending" / "2026-03-10" / "digest.md").read_text()
    again = {}
    night(answers, again)
    assert "sheet.sam" not in again and len(personsheets.for_person("sam")) == 2


def test_no_change_judges_a_failure_retries_and_a_foreign_source_is_refused(vault):
    seen = {}
    outcome = night({**ANSWERS, "sheet.sam": {"change": False, "reason": "same"},
                     "sheet.sam-okafor": None}, seen)
    assert personsheets.for_person("sam") == []
    assert outcome["failed"] == ["sheet sam-okafor"]
    again = {}
    night(ANSWERS, again)
    assert sheet_sessions(again) == ["sheet.sam-okafor"]

    # A source that was not in the job is refused, and the person is still judged.
    mint(vault, "2026-03-11.0900b", "Sam again", tags=["sam"])
    mint(vault, "2026-03-11.0910b", "unrelated note")
    outcome = night({"sheet.sam": {"change": True, "sheet": NEW_SHEET, "based_on": ["2026-03-11.0910b"]}},
                    target=date(2026, 3, 11))
    assert personsheets.for_person("sam") == []
    (refused,) = [item for item in outcome["sheets"] if item["slug"] == "sam"]
    assert not refused["ok"] and "source" in refused["error"]
    assert "NOT kept" in (store.DATA_DIR / "thread_tending" / "2026-03-11" / "digest.md").read_text()
    later = {}
    night({}, later, target=date(2026, 3, 11))
    assert "sheet.sam" not in later


def test_only_the_busiest_people_get_a_sheet_session_each_night(vault, monkeypatch):
    monkeypatch.setattr(tending, "MAX_SHEET_SESSIONS", 2)
    for index, (slug, count) in enumerate((("ann", 3), ("bo", 2), ("cy", 2))):
        (vault / "people" / f"{slug}.md").write_text(f"# {slug.title()}\n\nMade up.\n")
        for number in range(count):
            mint(vault, f"2026-03-10.10{number}{index}b", f"saw {slug.title()}", tags=[slug])
    first, second = {}, {}
    night({}, first)
    night({}, second)
    assert sheet_sessions(first) == ["sheet.ann", "sheet.bo"]
    # Nobody was judged (every session failed), so the same two come up again.
    assert sheet_sessions(second) == ["sheet.ann", "sheet.bo"]
    done = {name: {"change": False, "reason": "x"} for name in ("sheet.ann", "sheet.bo")}
    night(done)
    after = {}
    night({}, after)
    assert sheet_sessions(after) == ["sheet.cy", "sheet.sam"]


def test_person_sheets_off_runs_no_sheet_session(vault, monkeypatch):
    monkeypatch.setenv("PERSON_SHEETS", "0")
    seen = {}
    outcome = night(ANSWERS, seen)
    assert sheet_sessions(seen) == [] and outcome["sheets"] == []


def test_a_backlog_of_removals_goes_out_a_few_a_night_behind_the_nights_own(vault, monkeypatch):
    monkeypatch.setattr(tending, "MAX_UNTAG_PROPOSALS", 3)
    for minute in range(40, 45):
        mint(vault, f"2026-03-09.09{minute}b", "met a different Sam at the market", tags=["sam"])
    tending.queue_untags([{"card_id": f"2026-03-09.09{minute}b", "tag": "sam",
                           "reason": "a different Sam", "card_text": "met a different Sam"}
                          for minute in range(40, 45)]
                         + [{"card_id": "2026-03-08.0900b", "tag": "knee", "reason": "never tagged",
                             "card_text": "planted the beans"}])
    night(ANSWERS)
    asked = [p["payload"]["card_id"] for p in store.read("pending_changes", {"pending": []})["pending"]]
    # The night's own two removals go first; one backlog item fills the cap of three.
    assert asked[:2] == ["2026-03-10.0910b", "2026-03-10.0920b"] and asked[2:] == ["2026-03-09.0940b"]
    # A backlog item whose card never carried the tag is dropped; the rest keep waiting.
    waiting = [item["card_id"] for item in tending.read_untag_backlog()]
    assert waiting == [f"2026-03-09.09{minute}b" for minute in range(41, 45)]
    night(ANSWERS, target=date(2026, 3, 11))
    assert [item["card_id"] for item in tending.read_untag_backlog()] == ["2026-03-09.0944b"]


# --- Filing into the label rows ------------------------------------------------

def label_status(slug):
    import journaldb
    with closing(journaldb.connect(journaldb.db_path())) as conn:
        return conn.execute("SELECT status FROM labels WHERE slug = ?", (slug,)).fetchone()[0]


def test_every_label_a_night_adds_says_who_which_night_why_and_how_much(vault):
    """The two threads both claim the weeding card; the overlap pass makes it
    about the garden and touching the knee. A card with one label is about
    it, and a label already on gets its weight the same night."""
    night(ANSWERS)
    rows = {row["slug"]: row for row in label_rows("2026-03-10.0900b")}
    assert (rows["garden"]["added_by"], rows["garden"]["run"], rows["garden"]["reason"],
            rows["garden"]["weight"]) == ("thread-tending", "2026-03-10", "weeding is bed work", "about")
    assert rows["knee"]["weight"] == "touches" and rows["knee"]["reason"]
    (rake,) = label_rows("2026-03-10.0910b")
    assert (rake["added_by"], rake["weight"]) == ("migration", "about")
    assert {row["slug"]: row["weight"] for row in label_rows("2026-03-10.0920b")} == {
        "sam": "touches", "sam-okafor": "about"}


def test_a_failed_overlap_pass_adds_every_claim_unweighed(vault):
    outcome = night({**ANSWERS, "overlap": None})
    assert {row["slug"]: row["weight"] for row in label_rows("2026-03-10.0900b")} == {
        "garden": None, "knee": None}
    assert "overlap" in outcome["failed"]


def test_a_trusted_name_is_filed_by_plain_code_and_the_main_session_can_stop_it(vault):
    (vault / "people" / "priya.md").write_text("# Priya\n\nA made-up friend.\n")
    (vault / "people" / "lou.md").write_text("# Lou\n\nA made-up cousin.\n")
    mint(vault, "2026-03-10.1000b", "priya came by with soup")
    mint(vault, "2026-03-10.1010b", "Sam Okafor moved his office")
    mint(vault, "2026-03-10.1020b", "lou is a word here, honestly")
    seen = {}
    outcome = night({**ANSWERS, "main": {**ANSWERS["main"], "people_wrong": [
        {"card": "2026-03-10.1020b", "tag": "lou", "reason": "not the cousin"}]}}, seen)
    (row,) = label_rows("2026-03-10.1000b")
    assert (row["slug"], row["added_by"], row["run"], row["reason"], row["weight"]) == (
        "priya", "people-cricket", "2026-03-10", 'names "priya"', "about")
    # A full name is trusted even when the first name is shared.
    assert tags_of(vault, "2026-03-10.1010b") == ["sam-okafor"]
    # The main session saw the match as a tag, said no, and it was never added.
    assert "lou" in next(c for c in seen["main"]["cards"] if c["id"] == "2026-03-10.1020b")["tags"]
    assert tags_of(vault, "2026-03-10.1020b") == []
    assert [item["tag"] for item in outcome["vetoed"]] == ["lou"]


def test_a_common_word_is_not_trusted_as_the_name_of_someone_never_tagged(vault):
    (vault / "people" / "will.md").write_text("# Will\n\nA made-up climber.\n")
    for day in range(1, 17):
        mint(vault, f"2026-02-{day:02d}.0900b", "i will rest more")
    mint(vault, "2026-03-10.1000b", "will try the soup tomorrow")
    seen = {}
    night(ANSWERS, seen)
    assert tags_of(vault, "2026-03-10.1000b") == []


def test_a_label_taken_off_a_card_is_never_put_back(vault):
    (vault / "people" / "priya.md").write_text("# Priya\n\nA made-up friend.\n")
    mint(vault, "2026-03-10.1000b", "the garden beds again", tags=["garden"])
    mint(vault, "2026-03-10.1010b", "priya came by", tags=["priya"])
    take_off("2026-03-10.1000b", "garden")
    take_off("2026-03-10.1010b", "priya")
    night({**ANSWERS, "thread.garden": {"belongs": ["2026-03-10.0900b", "2026-03-10.1000b"]}})
    assert tags_of(vault, "2026-03-10.1000b") == [] and tags_of(vault, "2026-03-10.1010b") == []


def test_the_owners_labels_are_never_questioned_and_a_turned_down_removal_makes_one_hers(vault):
    mint(vault, "2026-03-10.1000b", "the knee brace arrived", tags=["knee"], by="owner")
    night({**ANSWERS, "thread.knee": {"belongs": ["2026-03-10.0900b"], "does_not_belong": [
        {"card": "2026-03-10.0910b", "reason": "a rake is not a knee"},
        {"card": "2026-03-10.1000b", "reason": "a brace is gear"}]}})
    queue = store.read("pending_changes", {"pending": []})["pending"]
    assert ("2026-03-10.1000b", "knee") not in {(p["payload"]["card_id"], p["payload"]["tag"]) for p in queue}

    app = Flask(__name__)
    pending.register(app)
    rake = next(p for p in queue if p["payload"]["card_id"] == "2026-03-10.0910b")
    assert app.test_client().post("/api/pending/deny", json={"id": rake["id"]}).get_json() == {"ok": True}
    (row,) = label_rows("2026-03-10.0910b")
    assert (row["slug"], row["added_by"], row["weight"]) == ("knee", "owner", "about")
    # Asked once, ever: the same removal waiting in the backlog is dropped, not asked again.
    tending.queue_untags([{**rake["payload"]}])
    night({}, target=date(2026, 3, 11))
    assert ("2026-03-10.0910b", "knee") not in {
        (p["payload"]["card_id"], p["payload"]["tag"])
        for p in store.read("pending_changes", {"pending": []})["pending"]}
    assert tending.read_untag_backlog() == []


def test_a_note_on_an_old_card_is_judged_with_it_and_wakes_its_quiet_thread(vault):
    (vault / "Threads" / "beans.md").write_text(thread_file("Beans", "the bean crop"))
    mint(vault, "2026-01-05.0900b", "the crop failed this year", tags=["beans"])
    set_status(vault, "beans", "dormant")
    mint(vault, "2026-03-11.0900b", "still true, they never came up", note_on="2026-01-05.0900b")
    seen = {}
    night({}, seen, target=date(2026, 3, 11))
    card = next(c for c in seen["thread.beans"]["cards"] if c["id"] == "2026-03-11.0900b")
    assert (card["note_on"]["id"], card["note_on"]["text"]) == ("2026-01-05.0900b", "the crop failed this year")
    assert next(c for c in seen["main"]["cards"] if c["id"] == "2026-03-11.0900b")["note_on"]["tags"] == ["beans"]
    # The label keeps step with its thread file's status.
    assert label_status("beans") == "dormant"


def test_the_old_asked_once_list_moves_into_the_label_rows(vault):
    """Before the journal moved into the database, the removals already asked
    were a list in state.json. A pair whose label is still on was turned
    down: it becomes hers. A pair whose label is gone was approved: it gets a
    row marked off by her, so nobody puts it back."""
    take_off_later = "2026-03-08.0900b"
    tending.save_state({"threads": {}, "names": {}, "statuses": {}, "sheets": {},
                        "untag_proposed": ["2026-03-10.0910b|knee", f"{take_off_later}|knee"]})
    outcome = night(ANSWERS)
    assert [(row["slug"], row["added_by"]) for row in label_rows("2026-03-10.0910b")] == [("knee", "owner")]
    (history,) = label_rows(take_off_later, include_removed=True)[1:]
    assert (history["slug"], history["removed_by"]) == ("knee", "owner")
    assert "untag_proposed" not in tending.load_state()
    assert len(outcome["retired"]) == 2
    # The kept one is not asked about, though the knee session still says it doesn't belong.
    asked = {(p["payload"]["card_id"], p["payload"]["tag"])
             for p in store.read("pending_changes", {"pending": []})["pending"]}
    assert ("2026-03-10.0910b", "knee") not in asked
