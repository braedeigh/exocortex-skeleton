"""scripts/thread_tending.py — the nightly check that cards are filed under the
right threads and people, one isolated session per thread.

Each test builds a small made-up vault (two threads, two people who share a
first name, a real card pool on disk) and runs a whole night with the agent
sessions replaced by a stand-in that answers from a script. Everything else is
real: the planning, the journal engine's `tag` and `untag` verbs, the approval
queue and its Approve route.
"""
import importlib.util
import json
from datetime import date
from pathlib import Path

import pytest
from flask import Flask

import store
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


def mint(content, card_id, body, tags=()):
    pool = content / "_system" / "data" / "cards"
    pool.mkdir(parents=True, exist_ok=True)
    ts = f"{card_id[:10]} {card_id[11:13]}:{card_id[13:15]}:00"
    (pool / f"{card_id}.md").write_text(
        f"---\nid: {card_id}\nwho: B\nts: {ts}\nreply_to: null\ntags: [{', '.join(tags)}]\n"
        f"kind: line\n---\n{body}\n", encoding="utf-8")


def tags_of(content, card_id):
    text = (content / "_system" / "data" / "cards" / f"{card_id}.md").read_text()
    line = next(l for l in text.splitlines() if l.startswith("tags:"))
    return [t.strip() for t in line[len("tags:"):].strip(" []").split(",") if t.strip()]


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    data, content = tmp_path / "data", tmp_path / "content"
    data.mkdir()
    (content / "Threads").mkdir(parents=True)
    (content / "people").mkdir()
    monkeypatch.setattr(store, "DATA_DIR", data)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(content))
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
    "thread.garden": {"belongs": ["2026-03-10.0900b"],
                      "movement": [{"text": "weeded the beds", "sources": ["2026-03-10.0900b"]}],
                      "summary": "Beans in, beds weeded."},
    "thread.knee": {"belongs": ["2026-03-10.0900b"],
                    "does_not_belong": [{"card": "2026-03-10.0910b", "reason": "a rake is not a knee"}]},
    "reconcile": {"keep": {"2026-03-10.0900b": ["garden", "knee"]}},
    "person.shared_sam": {"verdicts": [
        {"card": "2026-03-10.0920b", "person": "sam-okafor", "reason": "teeth: the dentist"}]},
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


def test_the_reconcile_session_can_give_a_contested_card_to_one_thread(vault):
    night({**ANSWERS, "reconcile": {"keep": {"2026-03-10.0900b": ["garden"]}}})
    assert tags_of(vault, "2026-03-10.0900b") == ["garden"]


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
