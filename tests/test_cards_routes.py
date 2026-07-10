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
from datetime import datetime

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
# `edit <id>` and `record` verbs to exercise the routes' contracts — it shells
# out and trusts whatever stream.py writes, it does not rebuild frontmatter
# itself beyond what `record` needs to mint a new card. Real stream.py
# preserves every frontmatter field (including refs) across an edit; this
# double asserts the same behavior without depending on the sibling repo.
FAKE_STREAM_PY = '''
import sys
from datetime import datetime
from pathlib import Path

POOL = Path(__file__).resolve().parent / "data" / "cards"

def do_edit(cid):
    path = POOL / f"{cid}.md"
    text = path.read_text()
    front, _, _body = text.partition("---\\n")[2].partition("\\n---\\n")
    new_body = sys.stdin.read()
    path.write_text("---\\n" + front + "\\n---\\n" + new_body)
    print(cid)

def do_record(argv):
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i].startswith("--"):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    who = opts["who"]
    ts = opts["ts"]
    ts_dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    base = ts_dt.strftime("%Y-%m-%d.%H%M") + who.lower()
    cid = base
    n = 2
    while (POOL / f"{cid}.md").exists():
        cid = f"{base}{n}"
        n += 1
    body = sys.stdin.read()
    POOL.mkdir(parents=True, exist_ok=True)
    front = (
        f"id: {cid}\\n"
        f"who: {who}\\n"
        f"ts: {ts}\\n"
        "reply_to: null\\n"
        "tags: []\\n"
        "kind: line\\n"
    )
    (POOL / f"{cid}.md").write_text("---\\n" + front + "---\\n" + body)
    print(cid)

def main():
    verb = sys.argv[1]
    if verb == "edit":
        do_edit(sys.argv[2])
    elif verb == "record":
        do_record(sys.argv[2:])
    else:
        raise SystemExit(f"unknown verb: {verb}")

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


# --- POST /api/cards/add ---------------------------------------------------
#
# The seed day (2026-07-08) has two timeline cards: a `line` at 07:34:00 and
# a `ref` at 21:14:00 — neither is `kind: context`, so both count toward the
# top/bottom insert math.

def test_add_card_top_inserts_one_second_before_earliest_timeline_card(client, vault, monkeypatch):
    monkeypatch.setattr(cards, "_stream_py", lambda: vault / "_system" / "stream.py")
    resp = client.post("/api/cards/add", json={
        "date": "2026-07-08",
        "position": "top",
        "body": "Woke up early, quiet house.",
    })
    assert resp.status_code == 200
    card = resp.get_json()
    assert card["body"] == "Woke up early, quiet house."
    assert card["ts"] == "2026-07-08 07:33:59"
    assert card["who"] == "B"


def test_add_card_bottom_on_past_day_inserts_one_second_after_latest_timeline_card(client, vault, monkeypatch):
    monkeypatch.setattr(cards, "_stream_py", lambda: vault / "_system" / "stream.py")
    resp = client.post("/api/cards/add", json={
        "date": "2026-07-08",
        "position": "bottom",
        "body": "One more thought before bed.",
    })
    assert resp.status_code == 200
    card = resp.get_json()
    assert card["body"] == "One more thought before bed."
    assert card["ts"] == "2026-07-08 21:14:01"
    assert card["who"] == "B"


def test_insert_ts_bottom_on_today_past_last_card_uses_now(client):
    day_cards = [
        {"id": "2026-07-08.0734b", "ts": "2026-07-08 07:34:00", "kind": "line"},
    ]
    now = datetime(2026, 7, 8, 23, 0, 0)
    ts = cards._insert_ts("2026-07-08", "bottom", day_cards, now=now)
    assert ts == "2026-07-08 23:00:00"


def test_insert_ts_top_clamps_to_midnight_when_first_card_is_at_midnight(client):
    day_cards = [
        {"id": "2026-07-08.0000b", "ts": "2026-07-08 00:00:00", "kind": "line"},
    ]
    ts = cards._insert_ts("2026-07-08", "top", day_cards, now=datetime(2026, 7, 8, 12, 0, 0))
    assert ts == "2026-07-08 00:00:00"


def test_add_card_rejects_empty_body(client):
    resp = client.post("/api/cards/add", json={
        "date": "2026-07-08",
        "position": "top",
        "body": "   ",
    })
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "body cannot be empty"


def test_add_card_rejects_bad_position(client):
    resp = client.post("/api/cards/add", json={
        "date": "2026-07-08",
        "position": "middle",
        "body": "Some note.",
    })
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "position must be 'top' or 'bottom'"


def test_add_card_rejects_date_before_cards_cutover(client):
    resp = client.post("/api/cards/add", json={
        "date": "2026-07-05",
        "position": "top",
        "body": "Some note.",
    })
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "day predates the card pool"
