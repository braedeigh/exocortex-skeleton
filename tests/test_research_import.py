"""Behavioral tests for the open-questions miner (routes/research_import.py).

Pins down: the heuristic section matching (question-ish headings in the real
corpus's vocabulary), list vs paragraph extraction, noise filtering, the
dry-run contract (writes nothing), idempotent import, and topic reuse.
"""
import json
from pathlib import Path

import pytest

from conftest import data_dir  # noqa: F401
from routes.research_import import mine_questions, md_title


# --- pure parsing core --------------------------------------------------------

DOC_LISTS = """# Wearables signal taxonomy

## Build order

- ship the strap first

## Open gaps (flagged by research as not yet confirmed)

- Is HRV from wrist optical actually usable during movement?
- **Skin temp** baselines: how many nights until stable?

## Key sources

- some paper
"""

DOC_NUMBERED = """# Food provenance

## Due-diligence questions for the SGTM CEO call

1. How do you verify **inputs** the satellite can't see?
2. Permissioned or public chain, and why a token at all?

## Sources
"""

DOC_PARAGRAPH = """# Context engine

## Open question carried forward

WiFi-sensing indoor presence (802.11bf / CSI): which products expose a
developer-usable data feed, and is identity-disambiguation feasible?
"""


def test_mine_list_items_under_open_gaps_heading():
    qs = mine_questions(DOC_LISTS)
    assert qs == [
        "Is HRV from wrist optical actually usable during movement?",
        "Skin temp baselines: how many nights until stable?",
    ]


def test_mine_numbered_items_and_strips_bold():
    qs = mine_questions(DOC_NUMBERED)
    assert len(qs) == 2
    assert qs[0] == "How do you verify inputs the satellite can't see?"


def test_mine_paragraph_mode_joins_wrapped_lines():
    qs = mine_questions(DOC_PARAGRAPH)
    assert len(qs) == 1
    assert qs[0].startswith("WiFi-sensing indoor presence")
    assert "feasible?" in qs[0]
    assert "\n" not in qs[0]


def test_mine_ignores_non_question_sections():
    doc = "# T\n\n## What Needs to Exist First\n\n- a prerequisite item here\n"
    assert mine_questions(doc) == []


def test_mine_section_ends_at_next_heading():
    qs = mine_questions(DOC_LISTS)
    assert not any("some paper" in q for q in qs)
    assert not any("strap" in q for q in qs)


def test_mine_filters_noise_by_length():
    doc = "# T\n\n## Open questions\n\n- tiny\n- " + ("x" * 501) + "\n- a real question of decent length?\n"
    assert mine_questions(doc) == ["a real question of decent length?"]


def test_md_title():
    assert md_title(DOC_LISTS) == "Wearables signal taxonomy"
    assert md_title("no heading here\n") == ""


# --- route ---------------------------------------------------------------------

def _post(client, payload=None):
    return client.post("/api/research/import-questions",
                       data=json.dumps(payload or {}),
                       content_type="application/json")


@pytest.fixture
def research_dir(tmp_path, monkeypatch):
    import store
    root = tmp_path / "research"
    root.mkdir()
    monkeypatch.setattr(store, "RESEARCH_DIR", root)
    return root


@pytest.fixture
def client(data_dir, research_dir):
    from flask import Flask
    from routes import research_import
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_import.register(app)
    return app.test_client()


def _read():
    import store
    return store.read("research.json", {"topics": [], "entries": []})


def _seed_file(root, name, text):
    (root / name).write_text(text)


def test_dry_run_previews_and_writes_nothing(client, research_dir):
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    r = _post(client, {"dry_run": True})
    body = r.get_json()
    assert body["dry_run"] is True
    assert body["total"] == 2
    assert body["plan"][0]["file"] == "wearables.md"
    assert body["plan"][0]["topic"] == "Wearables signal taxonomy"
    # An untouched pool reads back as researchstore's empty document, which
    # always carries the sessions list — not the default the reader passed.
    assert _read() == {"topics": [], "entries": [], "sessions": []}


def test_import_creates_topic_and_open_questions_with_origin(client, research_dir):
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    r = _post(client)
    body = r.get_json()
    assert body["imported"] == 2
    data = _read()
    assert [t["name"] for t in data["topics"]] == ["Wearables signal taxonomy"]
    tid = data["topics"][0]["id"]
    for e in data["entries"]:
        assert e["kind"] == "question"
        assert e["status"] == "open"
        assert e["topics"] == [tid]
        assert e["origin"] == "note:wearables.md"


def test_import_is_idempotent(client, research_dir):
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    assert _post(client).get_json()["imported"] == 2
    again = _post(client).get_json()
    assert again.get("total", 0) == 0 and not again.get("plan")
    assert len(_read()["entries"]) == 2


def test_import_skips_questions_already_captured_by_hand(client, research_dir):
    import store
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    store.write("research.json", {"topics": [], "entries": [{
        "id": "x", "kind": "question",
        "text": "is hrv from wrist optical actually usable during movement?",
        "topics": [], "url": "", "verdict": "", "status": "open",
        "reply_to": None, "created": "2026-07-01 10:00",
    }]})
    r = _post(client).get_json()
    assert r["imported"] == 1   # only the skin-temp question is new
    texts = [e["text"] for e in _read()["entries"]]
    assert len(texts) == 2


def test_import_reuses_existing_topic_by_name(client, research_dir):
    import store
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    store.write("research.json", {"topics": [{
        "id": "wearables", "name": "Wearables signal taxonomy",
        "status": "dormant", "created": "2026-07-01 10:00",
    }], "entries": []})
    _post(client)
    data = _read()
    assert len(data["topics"]) == 1          # reused, not duplicated
    assert data["topics"][0]["status"] == "dormant"   # untouched
    assert all(e["topics"] == ["wearables"] for e in data["entries"])


def test_import_two_files_two_topics(client, research_dir):
    _seed_file(research_dir, "wearables.md", DOC_LISTS)
    _seed_file(research_dir, "provenance.md", DOC_NUMBERED)
    r = _post(client).get_json()
    assert r["imported"] == 4
    assert sorted(t["name"] for t in _read()["topics"]) == [
        "Food provenance", "Wearables signal taxonomy"]
