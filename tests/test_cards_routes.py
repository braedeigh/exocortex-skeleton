"""routes/cards.py — the journal-day card read/edit/delete API.

Same vault-fixture style as test_entities_routes.py / test_person_routes.py:
card files on disk under a tmp CONTENT_DIR, a minimal Flask app registering
only `cards`. Focus here is the `refs` field added alongside `kind: ref` —
always present in the API shape, defaulting to [] when a card predates it
(mirrors how `tags` is normalized), and surviving an /api/cards/update
round-trip (which shells out to stream.py rather than rebuilding frontmatter
itself).
"""
import sys

import pytest
from flask import Flask

import store
from routes import cards

REF_CARD = """---
id: 2026-07-08.2114k
who: K
ts: 2026-07-08 21:14:00
reply_to: 2026-07-08.2113b
tags: [vivian]
kind: ref
refs: [2026-05-14, 2026-05-17, people/vivian.md]
---
Vivian group cancellation — the group she'd been attending got cancelled mid-May; hit the belonging nerve.
"""

LINE_CARD = """---
id: 2026-07-08.0734b
who: B
ts: 2026-07-08 07:34:00
reply_to: null
tags: [khalil]
kind: line
---
I feel really good this morning.
"""

# A minimal stand-in for the vault's stream.py: implements just enough of the
# `edit <id>` verb to exercise the route's contract — it shells out and trusts
# whatever stream.py writes, it does not rebuild frontmatter itself. Real
# stream.py preserves every frontmatter field (including refs) across an edit;
# this double asserts the same behavior without depending on the sibling repo.
FAKE_STREAM_PY = '''
import sys
from pathlib import Path

def main():
    verb, cid = sys.argv[1], sys.argv[2]
    assert verb == "edit"
    path = Path(__file__).resolve().parent / "data" / "cards" / f"{cid}.md"
    text = path.read_text()
    front, _, _body = text.partition("---\\n")[2].partition("\\n---\\n")
    new_body = sys.stdin.read()
    path.write_text("---\\n" + front + "\\n---\\n" + new_body)
    print(cid)

if __name__ == "__main__":
    main()
'''


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    pool = tmp_path / "_system" / "data" / "cards"
    pool.mkdir(parents=True)
    (pool / "2026-07-08.2114k.md").write_text(REF_CARD)
    (pool / "2026-07-08.0734b.md").write_text(LINE_CARD)
    (tmp_path / "_system" / "stream.py").write_text(FAKE_STREAM_PY)
    return tmp_path


@pytest.fixture
def client(vault):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    cards.register(app)
    return app.test_client()


def _by_id(payload, cid):
    return next(c for c in payload["cards"] if c["id"] == cid)


def test_get_cards_returns_refs_as_list_for_ref_card(client):
    resp = client.get("/api/cards/2026-07-08")
    assert resp.status_code == 200
    card = _by_id(resp.get_json(), "2026-07-08.2114k")
    assert card["kind"] == "ref"
    assert card["refs"] == ["2026-05-14", "2026-05-17", "people/vivian.md"]


def test_get_cards_defaults_refs_to_empty_list_when_absent(client):
    resp = client.get("/api/cards/2026-07-08")
    assert resp.status_code == 200
    card = _by_id(resp.get_json(), "2026-07-08.0734b")
    assert card["kind"] == "line"
    assert card["refs"] == []


def test_update_card_preserves_refs_across_edit_round_trip(client, vault, monkeypatch):
    # Route the subprocess call at our fake stream.py (not the real sys.executable
    # environment's), same interpreter as the test runner.
    monkeypatch.setattr(cards, "_stream_py", lambda: vault / "_system" / "stream.py")
    resp = client.post("/api/cards/update", json={
        "id": "2026-07-08.2114k",
        "body": "Vivian group cancellation (edited) — belonging nerve hit hard.",
    })
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["body"] == "Vivian group cancellation (edited) — belonging nerve hit hard."
    assert body["kind"] == "ref"
    assert body["refs"] == ["2026-05-14", "2026-05-17", "people/vivian.md"]
