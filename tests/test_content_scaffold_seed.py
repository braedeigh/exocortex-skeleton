"""store.seed_content_scaffold() — populating a fresh CONTENT_DIR with the
journaling seed tree (content-scaffold/), and the end-to-end path it exists
for: a fresh install's /api/cards/add actually working against the seeded
engine, not shelling out to nothing.

Isolation follows the repo convention (see tests/conftest.py's `data_dir`):
every test monkeypatches store.CONTENT_DIR to a fresh tmp_path rather than
touching the real data/ dir. CONTENT_SCAFFOLD_DIR itself is NOT patched — the
whole point is exercising the real content-scaffold/ tree shipped in this repo.
"""
from datetime import datetime

import pytest
from flask import Flask

import store
from routes import cards


def _seed(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    store.seed_content_scaffold()
    return tmp_path


# --- population ---------------------------------------------------------

def test_seed_populates_a_fresh_content_dir(tmp_path, monkeypatch):
    root = _seed(tmp_path, monkeypatch)

    for rel in (
        "_system/stream.py",
        "_system/keeper_capture.py",
        "_system/reconcile_transcripts.py",
        "_system/STREAM.md",
        "_system/test_stream.py",
        "_system/test_keeper_capture.py",
        "_system/test_reconcile_transcripts.py",
        "CLAUDE.md",
    ):
        assert (root / rel).is_file(), f"missing {rel}"

    for rel in ("_system/data/cards", "Journal/Daily", "Journal/Weekly", "keeper-diary"):
        assert (root / rel).is_dir(), f"missing dir {rel}"


def test_seed_scaffold_source_carries_no_personal_content(tmp_path, monkeypatch):
    # Belt-and-suspenders on top of the manual grep sweep: nothing seeded should
    # ever mention the author by name or point back at the private vault.
    root = _seed(tmp_path, monkeypatch)
    banned = ("bradie", "/opt/exocortex/personal")
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
        for needle in banned:
            assert needle not in text, f"{needle!r} found in {path}"


# --- idempotence / never-overwrite --------------------------------------

def test_seed_is_idempotent(tmp_path, monkeypatch):
    root = _seed(tmp_path, monkeypatch)
    stream_before = (root / "_system" / "stream.py").read_text()

    store.seed_content_scaffold()  # second call: must be a no-op, not an error

    assert (root / "_system" / "stream.py").read_text() == stream_before


def test_seed_never_overwrites_an_existing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    # Simulate a partially-populated dir: CLAUDE.md already customized by the
    # owner, but the engine itself not yet present.
    (tmp_path / "CLAUDE.md").write_text("owner's own customized manifest\n")

    store.seed_content_scaffold()

    assert (tmp_path / "CLAUDE.md").read_text() == "owner's own customized manifest\n"
    # The rest of the scaffold still gets seeded around the untouched file.
    assert (tmp_path / "_system" / "stream.py").is_file()


def test_seed_does_nothing_when_stream_py_already_exists(tmp_path, monkeypatch):
    # The gate: an install whose CONTENT_DIR already has an engine (e.g. the
    # author's own vault via EXOCORTEX_CONTENT_DIR) must be left untouched.
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path)
    system_dir = tmp_path / "_system"
    system_dir.mkdir()
    (system_dir / "stream.py").write_text("# the owner's real engine\n")

    store.seed_content_scaffold()

    assert (system_dir / "stream.py").read_text() == "# the owner's real engine\n"
    assert not (tmp_path / "CLAUDE.md").exists()
    assert not (tmp_path / "Journal").exists()


# --- end to end: a fresh install's card API against the seeded engine ---

@pytest.fixture
def seeded_client(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    cards.register(app)
    return app.test_client()


def test_add_card_on_freshly_seeded_content_dir_round_trips(seeded_client):
    today = datetime.now().strftime("%Y-%m-%d")

    resp = seeded_client.post("/api/cards/add", json={
        "date": today,
        "position": "top",
        "body": "hello from a fresh install",
    })
    assert resp.status_code == 200, resp.get_json()
    added = resp.get_json()
    assert added["body"] == "hello from a fresh install"
    assert added["who"] == "B"

    resp = seeded_client.get(f"/api/cards/{today}")
    assert resp.status_code == 200
    cards_out = resp.get_json()["cards"]
    assert any(c["id"] == added["id"] for c in cards_out)
