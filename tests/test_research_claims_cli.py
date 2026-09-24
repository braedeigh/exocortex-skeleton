"""Behavioral tests for scripts/research_claims.py — the agents' write door
for claims and their sources.

Each test seeds a minimal research.json under the isolated data_dir, drives
one verb through main(argv), and asserts what landed via store.read /
researchstore.claim_detail. The one that matters most: a passage the source
does not contain exits 1 and links nothing — offsets are never invented.
"""
import importlib.util
import json
import os

import pytest

import docstore
import researchstore
import store

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

# Import the script from the scripts directory via importlib, the same way
# tests/test_research_ctl.py does for its sibling.
_SCRIPTS_PATH = os.path.join(os.path.dirname(__file__), "..", "scripts", "research_claims.py")
_spec = importlib.util.spec_from_file_location("research_claims", _SCRIPTS_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

main = _mod.main
find_passage = _mod.find_passage

SESSION = "2026-07-07.1001"
CLAIM = "2026-07-07.1000"
SOURCE = "2026-07-07.1000-2"
SOURCE_URL = "https://example.org/paper"


def _entry(eid, kind="note", **over):
    entry = {"id": eid, "kind": kind, "text": f"text of {eid}", "topics": [],
             "url": "", "verdict": "", "status": "", "reply_to": None,
             "created": "2026-07-07 10:00"}
    entry.update(over)
    return entry


@pytest.fixture
def seeded(data_dir):
    """One topic, one running session, an owner claim and a source whose
    entry text is a short sentence (the fallback when no text was fetched)."""
    store.write("research.json", {
        "topics": [{"id": "sleep", "name": "Sleep", "status": "active",
                    "created": "2026-07-07 10:00", "fronts": ["health"]}],
        "entries": [
            _entry(CLAIM, kind="claim", text="Magnesium helps sleep", topics=["sleep"]),
            _entry(SOURCE, kind="source", text="Sleep paper says quick things",
                   url=SOURCE_URL, topics=["sleep"]),
        ],
        "sessions": [{"id": SESSION, "entry_ids": [], "topics": ["sleep"],
                      "created": "2026-07-07 10:01", "status": "running", "report": ""}],
    })
    return data_dir


def _entries():
    return store.read("research.json", {"entries": []})["entries"]


def _annotations():
    return store.read("annotations.json", {"annotations": []})["annotations"]


# --- add ------------------------------------------------------------------------------

def test_add_creates_an_llm_unreviewed_claim(seeded, capsys):
    code = main(["add", "--session", SESSION, "--topic", "sleep",
                 "--text", "Magnesium glycinate shortens sleep latency", "--verdict", "shaky"])
    assert code == 0
    new_id = capsys.readouterr().out.strip()
    claim = next(e for e in _entries() if e["id"] == new_id)
    assert claim["kind"] == "claim"
    assert claim["author"] == "llm"
    assert claim["reviewed"] is False
    assert claim["session"] == SESSION
    assert claim["topics"] == ["sleep"]
    assert claim["verdict"] == "shaky"
    assert researchstore.claim_detail(new_id)["claim"]["text"] == \
        "Magnesium glycinate shortens sleep latency"


def test_add_refuses_an_unknown_session_or_topic(seeded, capsys):
    before = len(_entries())
    assert main(["add", "--session", "nope", "--topic", "sleep", "--text", "x"]) == 1
    assert "Session not found" in capsys.readouterr().err
    assert main(["add", "--session", SESSION, "--topic", "invented", "--text", "x"]) == 1
    assert "Topic not found" in capsys.readouterr().err
    assert len(_entries()) == before


# --- source ---------------------------------------------------------------------------

def test_source_dedupes_by_url(seeded, capsys):
    before = len(_entries())
    code = main(["source", "--session", SESSION, "--topic", "sleep",
                 "--url", SOURCE_URL, "--text", "Same paper, cited again"])
    assert code == 0
    assert capsys.readouterr().out.strip() == SOURCE
    assert len(_entries()) == before


def test_source_creates_when_the_url_is_new(seeded, capsys):
    code = main(["source", "--session", SESSION, "--topic", "sleep",
                 "--url", "https://example.org/other", "--text", "Other paper"])
    assert code == 0
    new_id = capsys.readouterr().out.strip()
    entry = next(e for e in _entries() if e["id"] == new_id)
    assert entry["kind"] == "source"
    assert entry["url"] == "https://example.org/other"
    assert entry["author"] == "llm"
    assert entry["reviewed"] is False
    assert entry["session"] == SESSION


# --- link -----------------------------------------------------------------------------

def test_link_with_passage_anchors_to_the_offsets_in_the_fetched_text(seeded):
    docstore.save_entry_text(SOURCE, "Alpha. The quick brown fox sleeps. Omega.")
    code = main(["link", CLAIM, SOURCE, "--stance", "contradicts",
                 "--passage", "quick brown fox", "--note", "figure 2"])
    assert code == 0
    (source,) = researchstore.claim_detail(CLAIM)["sources"]
    assert source["stance"] == "contradicts"
    assert source["note"] == "figure 2"
    assert source["annotation"]["doc"] == f"entry:{SOURCE}"
    assert (source["annotation"]["char_start"], source["annotation"]["char_end"]) == (11, 26)
    assert source["annotation"]["exact"] == "quick brown fox"
    (annotation,) = _annotations()
    assert annotation["content"]["source"] == "llm"
    assert annotation["needs_review"] is True
    assert annotation["selector"] == {"exact": "quick brown fox", "char_start": 11, "char_end": 26}


def test_link_with_passage_falls_back_to_the_entry_text(seeded):
    assert main(["link", CLAIM, SOURCE, "--passage", "quick things"]) == 0
    (source,) = researchstore.claim_detail(CLAIM)["sources"]
    assert (source["annotation"]["char_start"], source["annotation"]["char_end"]) == (17, 29)
    assert source["annotation"]["exact"] == "quick things"


def test_link_with_a_missing_quote_exits_1_and_links_nothing(seeded, capsys):
    docstore.save_entry_text(SOURCE, "Alpha. The quick brown fox sleeps. Omega.")
    code = main(["link", CLAIM, SOURCE, "--passage", "the slow red hen"])
    assert code == 1
    assert "passage not found" in capsys.readouterr().err
    assert researchstore.claim_detail(CLAIM)["sources"] == []
    assert _annotations() == []


def test_link_refuses_a_non_claim_before_writing_the_annotation(seeded):
    assert main(["link", SOURCE, CLAIM, "--passage", "Magnesium"]) == 1
    assert _annotations() == []


def test_find_passage_bridges_line_breaks_but_never_guesses():
    text = "results show a\n  large effect\nin adults"
    assert find_passage(text, "a large effect") == (13, 29)
    assert text[13:29] == "a\n  large effect"
    assert find_passage(text, "a large affect") is None
    assert find_passage(text, "") is None


# --- value / show ---------------------------------------------------------------------

def test_value_sets_the_number_inside_a_claim(seeded):
    code = main(["value", CLAIM, "--subject", "magnesium", "--measure", "dose",
                 "--amount", "350", "--unit", "mg", "--year", "2024", "--tier", "B"])
    assert code == 0
    assert researchstore.claim_detail(CLAIM)["value"] == {
        "subject": "magnesium", "measure": "dose", "amount": 350.0, "unit": "mg",
        "basis": None, "year": 2024, "tier": "B"}
    assert main(["value", SOURCE, "--subject", "x", "--measure", "y",
                 "--amount", "1", "--unit", "z"]) == 1


def test_show_prints_the_claim_detail_as_json(seeded, capsys):
    researchstore.link_claim_source(CLAIM, SOURCE)
    assert main(["show", CLAIM]) == 0
    detail = json.loads(capsys.readouterr().out)
    assert detail["claim"]["id"] == CLAIM
    assert [s["id"] for s in detail["sources"]] == [SOURCE]
    assert main(["show", "nope"]) == 1


def test_add_without_a_session_stamps_the_conversation_it_came_from(data_dir, monkeypatch):
    """A desk session in the research room has no research session id; the
    claim still lands, tagged with the Observatory conversation that wrote it."""
    store.write("research.json", {"topics": [{"id": "t1", "name": "T", "status": "active", "created": "2026-09-24 10:00", "fronts": []}], "entries": [], "sessions": []})
    monkeypatch.setenv("EXOCORTEX_CONV_ID", "2026-09-24.170000")
    assert main(["add", "--topic", "t1", "--text", "A claim from the desk"]) == 0
    entries = store.read("research.json")["entries"]
    assert entries[0]["session"] is None and entries[0]["conv_id"] == "2026-09-24.170000"
