"""The research pool as rows, and the documents it comes back as (researchstore.py).

Like the notes tables, these are the DESTINATION rather than a report rebuilt
from a blob, so the thing worth testing is "does anything get lost on the way
through". Every test is a round trip or a seam check:

  - a full research document, every optional key present, survives the trip
  - a key with no column rides along in `extra` instead of being dropped
  - list order survives where ids and dates cannot supply it
  - the first touch seeds from the blob row, and THEN imports the records the
    mirror file has that the blob lacks (the owner's hand-written strays)
  - the blob row is retired once adopted, so an emptied pool stays empty
  - annotations round-trip in routes/annotations.py's nested shape
  - deleting a claim through mutate() takes its claim_sources rows with it
  - link_claim_source + claim_detail hand back the annotation on the link
  - list_claims filters by topic and, through topics, by front
  - the typed helpers keep the mirror file current
  - EXOCORTEX_SQL_OFF still drops both collections back to plain files
  - the routes still see the same document through store.read / store.mutate
"""
import json
import sqlite3

import pytest

import researchstore
import sqlstore
import store


def _topic(tid, **over):
    topic = {"id": tid, "name": tid.title(), "status": "active",
             "created": "2026-07-01 09:00", "fronts": ["health"]}
    topic.update(over)
    return topic


def _entry(eid, kind="note", **over):
    entry = {"id": eid, "kind": kind, "text": f"text of {eid}", "topics": [],
             "url": "", "verdict": "", "status": "open" if kind == "question" else "",
             "reply_to": None, "created": "2026-07-01 09:00"}
    entry.update(over)
    return entry


def _session(sid, **over):
    session = {"id": sid, "entry_ids": [], "topics": [], "created": "2026-07-01 09:00",
               "status": "done", "report": "ok"}
    session.update(over)
    return session


def _annotation(aid, doc="entry:e1", **over):
    annotation = {"id": aid, "doc": doc,
                  "content": {"kind": "highlight", "note": "look", "source": "human"},
                  "needs_review": False,
                  "selector": {"exact": "quick", "char_start": 4, "char_end": 9},
                  "created": "2026-07-01 09:00"}
    annotation.update(over)
    return annotation


FULL_DOCUMENT = {
    "topics": [
        _topic("sleep", fronts=["health", "exocortex"]),
        _topic("money", status="dormant", fronts=[]),
    ],
    "entries": [
        _entry("2026-07-01.0900", topics=["sleep"], re_quote="a passage",
               context_ids=["2026-06-30.1200", "2026-06-30.1201"], flagged=True, processed=False),
        _entry("2026-07-01.0900-2", kind="claim", topics=["sleep", "money"], url="https://x",
               verdict="real", author="llm", reviewed=False, session="2026-07-01.0930",
               file="sleep.md", origin="note:sleep.md"),
        _entry("2026-07-01.0900-3", kind="source", url="https://y", verdict="verified",
               reply_to="2026-07-01.0900"),
        _entry("2026-07-01.0900-10", kind="question"),
    ],
    "sessions": [
        _session("2026-07-01.0930", entry_ids=["2026-07-01.0900", "2026-07-01.0900-2"],
                 topics=["sleep"], mode="regular", worker=True, attempts=2,
                 claude_session="abc", claude_cwd="/tmp/x", conv_id="conv-1", run_id="run-1"),
        _session("2026-07-01.0931", status="failed"),
    ],
}


# --- round trips --------------------------------------------------------------------

def test_full_document_survives_the_round_trip(data_dir):
    researchstore.put("research", FULL_DOCUMENT)
    assert researchstore.get("research") == FULL_DOCUMENT


def test_a_key_with_no_column_is_kept_not_dropped(data_dir):
    """A source's fetched `meta` block, and anything else a later feature
    adds, rides along in `extra` and comes back on the far side."""
    doc = {"topics": [_topic("t", colour="blue")],
           "entries": [_entry("e1", kind="source", meta={"doi": "10.1/x", "reviewed": False})],
           "sessions": [_session("s1", target_id="e1")]}
    researchstore.put("research", doc)
    back = researchstore.get("research")
    assert back["entries"][0]["meta"] == {"doi": "10.1/x", "reviewed": False}
    assert back["topics"][0]["colour"] == "blue"
    assert back["sessions"][0]["target_id"] == "e1"


def test_a_flag_never_set_stays_absent(data_dir):
    """The document shows `flagged` only when it was set — the difference
    between false and never-said is kept, not flattened to false."""
    researchstore.put("research", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    back = researchstore.get("research")["entries"][0]
    assert "flagged" not in back and "reviewed" not in back and "author" not in back


def test_list_order_survives_where_ids_cannot_supply_it(data_dir):
    """Entry ids sort '-10' before '-2' as text, and the live pool is in
    neither id nor date order — position is what keeps the list as written."""
    ids = ["2026-07-01.0900-2", "2026-07-01.0900-10", "2026-06-01.0800", "2026-07-01.0900"]
    researchstore.put("research", {"topics": [], "entries": [_entry(i) for i in ids], "sessions": []})
    assert [e["id"] for e in researchstore.get("research")["entries"]] == ids


def test_a_write_restamps_only_the_entry_that_changed(data_dir):
    researchstore.put("research", {"topics": [], "entries": [_entry("e1"), _entry("e2"), _entry("e3")], "sessions": []})
    conn = sqlstore.open_db()
    before = dict(conn.execute("SELECT id, updated_at FROM research_entries"))
    conn.close()
    with researchstore.mutate("research") as doc:
        del doc["entries"][0]                      # e2 and e3 move down one
        doc["entries"][1]["text"] = "edited"       # e3 changes
    conn = sqlstore.open_db()
    after = dict(conn.execute("SELECT id, updated_at FROM research_entries"))
    positions = dict(conn.execute("SELECT id, position FROM research_entries"))
    conn.close()
    assert set(after) == {"e2", "e3"}
    assert after["e2"] == before["e2"]
    assert after["e3"] >= before["e3"]
    assert positions == {"e2": 0, "e3": 1}


def test_the_mirror_file_is_written_from_the_rows(data_dir):
    researchstore.put("research", FULL_DOCUMENT)
    mirror = json.loads((data_dir / "research.json").read_text())
    assert mirror == researchstore.get("research")


def test_mutate_writes_the_whole_block_or_nothing(data_dir):
    researchstore.put("research", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    with pytest.raises(RuntimeError):
        with researchstore.mutate("research") as doc:
            doc["entries"][0]["text"] = "edited"
            raise RuntimeError("boom")
    assert researchstore.get("research")["entries"][0]["text"] == "text of e1"


# --- seeding --------------------------------------------------------------------------

def _plant_blob(name, doc):
    conn = sqlstore.open_db()
    conn.execute("INSERT INTO docs (name, data) VALUES (?, ?)", (name, json.dumps(doc)))
    conn.close()


def test_first_touch_seeds_from_the_blob_then_imports_the_mirror_strays(data_dir):
    """The blob is what the database held; the mirror file may hold records
    that were written to the file directly and never reached the database.
    Both come in, blob first, and the report says which were strays."""
    blob = {"topics": [_topic("sleep")], "entries": [_entry("e1")], "sessions": [_session("s1")]}
    _plant_blob("research", blob)
    mirror = {"topics": [_topic("sleep"), _topic("attention")],
              "entries": [_entry("e1", text="STALE COPY"), _entry("q1", kind="question"), _entry("q2", kind="question")],
              "sessions": [_session("s1")]}
    store.write_file("research", mirror)

    report = researchstore.seed("research")
    assert report == {"seeded_from": "blob",
                      "mirror_added": {"topics": ["attention"], "entries": ["q1", "q2"]}}
    doc = researchstore.get("research")
    assert [t["id"] for t in doc["topics"]] == ["sleep", "attention"]
    assert [e["id"] for e in doc["entries"]] == ["e1", "q1", "q2"]
    assert doc["entries"][0]["text"] == "text of e1"   # the blob's copy wins for a shared id
    assert researchstore.seed("research") is None      # nothing left to do


def test_a_plain_read_seeds_too(data_dir):
    _plant_blob("research", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    assert [e["id"] for e in researchstore.get("research")["entries"]] == ["e1"]


def test_with_no_blob_the_legacy_file_is_adopted(data_dir):
    store.write_file("research", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    assert researchstore.seed("research")["seeded_from"] == "file"
    assert [e["id"] for e in researchstore.get("research")["entries"]] == ["e1"]


def test_the_blob_row_is_retired_so_an_emptied_pool_stays_empty(data_dir):
    _plant_blob("research", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    researchstore.get("research")
    researchstore.put("research", {"topics": [], "entries": [], "sessions": []})
    conn = sqlstore.open_db()
    assert conn.execute("SELECT COUNT(*) FROM docs WHERE name = 'research'").fetchone()[0] == 0
    conn.close()
    assert researchstore.get("research") == {"topics": [], "entries": [], "sessions": []}


# --- annotations -----------------------------------------------------------------------

def test_annotations_round_trip_in_the_routes_shape(data_dir):
    doc = {"annotations": [
        _annotation("ann-2026-07-01.0900"),
        _annotation("ann-2026-07-01.0900-2", doc="note:sleep.md", needs_review=True,
                    content={"kind": "highlight", "source": "llm", "confidence": 0.4},
                    selector={"exact": "x", "char_start": 0, "char_end": 1, "prefix": "…"},
                    colour="amber"),
    ]}
    researchstore.put("annotations", doc)
    back = researchstore.get("annotations")
    assert back == doc
    assert list(back["annotations"][0]) == ["id", "doc", "content", "needs_review", "selector", "created"]


def test_annotations_seed_from_the_blob_and_the_mirror(data_dir):
    _plant_blob("annotations", {"annotations": [_annotation("ann-1")]})
    store.write_file("annotations", {"annotations": [_annotation("ann-1"), _annotation("ann-2")]})
    assert researchstore.seed("annotations")["mirror_added"] == {"annotations": ["ann-2"]}
    assert [a["id"] for a in researchstore.get("annotations")["annotations"]] == ["ann-1", "ann-2"]


def test_add_annotation_uses_the_routes_id_scheme_and_updates_the_mirror(data_dir):
    first = researchstore.add_annotation("entry:e1", 4, 9, "quick", note="n", source="llm")
    second = researchstore.add_annotation("entry:e1", 4, 9, "quick", source="human", needs_review=False)
    assert first.startswith("ann-") and second == first + "-2"
    doc = researchstore.get("annotations")
    assert doc["annotations"][0]["content"] == {"kind": "highlight", "note": "n", "source": "llm"}
    assert doc["annotations"][0]["needs_review"] is True
    assert doc["annotations"][1]["needs_review"] is False
    assert json.loads((data_dir / "annotations.json").read_text()) == doc


# --- claims ---------------------------------------------------------------------------

def _claims_pool():
    researchstore.put("research", {
        "topics": [_topic("sleep", fronts=["health"]), _topic("money", fronts=["finances"])],
        "entries": [
            _entry("c1", kind="claim", topics=["sleep"], verdict="real"),
            _entry("c2", kind="claim", topics=["money"]),
            _entry("s1", kind="source", url="https://s1", verdict="verified"),
            _entry("n1", kind="note"),
        ],
        "sessions": [_session("s-1")],
    })


def test_deleting_a_claim_through_mutate_removes_its_source_links(data_dir):
    _claims_pool()
    researchstore.link_claim_source("c1", "s1")
    researchstore.link_claim_source("c2", "s1")
    with researchstore.mutate("research") as doc:
        doc["entries"] = [e for e in doc["entries"] if e["id"] != "c1"]
    conn = sqlstore.open_db()
    left = [r[0] for r in conn.execute("SELECT claim_id FROM claim_sources")]
    conn.close()
    assert left == ["c2"]


def test_link_and_detail_return_the_annotation(data_dir):
    _claims_pool()
    aid = researchstore.add_annotation("entry:s1", 0, 5, "hello", note="the evidence")
    researchstore.link_claim_source("c1", "s1", stance="contradicts", annotation_id=aid, note="see p.3")
    detail = researchstore.claim_detail("c1")
    assert detail["claim"]["id"] == "c1" and detail["claim"]["source_count"] == 1
    assert detail["sources"] == [{
        "id": "s1", "text": "text of s1", "url": "https://s1", "verdict": "verified",
        "stance": "contradicts", "note": "see p.3", "doc": "entry:s1",
        "annotation": {"id": aid, "doc": "entry:s1", "char_start": 0, "char_end": 5,
                       "exact": "hello", "note": "the evidence"},
    }]
    assert researchstore.claims_for_source("s1")[0]["id"] == "c1"
    assert researchstore.unlink_claim_source("c1", "s1") is True
    assert researchstore.claim_detail("c1")["sources"] == []


def test_deleting_the_annotation_keeps_the_link_and_blanks_it(data_dir):
    _claims_pool()
    aid = researchstore.add_annotation("entry:s1", 0, 5, "hello")
    researchstore.link_claim_source("c1", "s1", annotation_id=aid)
    researchstore.put("annotations", {"annotations": []})
    assert researchstore.claim_detail("c1")["sources"][0]["annotation"] is None


def test_link_refuses_what_is_not_a_claim(data_dir):
    _claims_pool()
    with pytest.raises(ValueError):
        researchstore.link_claim_source("n1", "s1")
    with pytest.raises(ValueError):
        researchstore.link_claim_source("c1", "nope")
    with pytest.raises(ValueError):
        researchstore.link_claim_source("c1", "s1", stance="maybe")


def test_list_claims_filters_by_front_through_topics(data_dir):
    _claims_pool()
    assert [c["id"] for c in researchstore.list_claims()] == ["c1", "c2"]
    assert [c["id"] for c in researchstore.list_claims(front="health")] == ["c1"]
    assert [c["id"] for c in researchstore.list_claims(topic="money")] == ["c2"]
    claim = researchstore.list_claims(front="health")[0]
    assert claim["fronts"] == ["health"] and claim["topics"] == ["sleep"]
    assert claim["source_count"] == 0 and claim["value"] is None


def test_set_claim_value_merges_and_keeps_unknown_fields(data_dir):
    _claims_pool()
    researchstore.set_claim_value("c1", subject="oats", measure="protein", amount=13.2, unit="g", basis="100 g")
    researchstore.set_claim_value("c1", year=2024, tier="verified", method="lab")
    value = researchstore.list_claims(topic="sleep")[0]["value"]
    assert value == {"subject": "oats", "measure": "protein", "amount": 13.2, "unit": "g",
                     "basis": "100 g", "year": 2024, "tier": "verified", "method": "lab"}
    with pytest.raises(ValueError):
        researchstore.set_claim_value("nope", subject="x")


def test_set_session_link_shows_in_the_document_and_the_mirror(data_dir):
    _claims_pool()
    researchstore.set_session_link("s-1", conv_id="conv-9")
    researchstore.set_session_link("s-1", run_id="run-9")
    session = researchstore.get("research")["sessions"][0]
    assert session["conv_id"] == "conv-9" and session["run_id"] == "run-9"
    assert json.loads((data_dir / "research.json").read_text())["sessions"][0]["run_id"] == "run-9"
    with pytest.raises(ValueError):
        researchstore.set_session_link("nope", conv_id="x")


# --- the seam ---------------------------------------------------------------------------

def test_store_dispatches_both_collections_here(data_dir):
    assert store._backend("research.json") is researchstore
    assert store._backend("annotations.json") is researchstore
    with store.mutate("research.json", {"topics": [], "entries": []}) as data:
        data["entries"].append(_entry("e1", kind="question"))
    assert store.read("research.json")["entries"][0]["status"] == "open"
    conn = sqlite3.connect(data_dir / "exo.db")
    assert conn.execute("SELECT kind FROM research_entries").fetchone() == ("question",)
    conn.close()


def test_sql_off_falls_back_to_plain_files(data_dir, monkeypatch):
    monkeypatch.setattr(store, "_SQL_OFF", True)
    assert store._backend("research.json") is None
    store.write("research.json", {"topics": [], "entries": [_entry("e1")], "sessions": []})
    assert json.loads((data_dir / "research.json").read_text())["entries"][0]["id"] == "e1"
    assert not (data_dir / "exo.db").exists()
