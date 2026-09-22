"""The map a public mirror draws: published in from the private box, never
built from data the mirror holds (routes/terrain_mirror.py).

The shape being protected: a mirror owns no vault, no exo.db and no git
history, so the privacy of a personal file is a fact about its disk rather
than a code path that has to hold. What these tests pin down is that the
door only opens where it should, only for the right secret, and that the ONE
artifact it takes in serves every tier of the Files slider correctly.
"""
import gzip
import json

import pytest

from routes import terrain_mirror


def _payload(paths, generated_at="2026-09-21T10:00:00"):
    """A terrain payload of the smallest honest shape: one repo, one file per
    path, each with a single git touch."""
    return {
        "generated_at": generated_at,
        "file_cap": None,
        "window_days": None,
        "pond_days": [],
        "sessions": [],
        "repos": [{
            "id": "skeleton", "name": "App code", "root": "/nowhere",
            "files_total": len(paths),
            "files": [{"path": p, "touches": [1_758_000_000 + i],
                       "sessions": [], "ran": []}
                      for i, p in enumerate(paths)],
        }],
    }


def _client(monkeypatch, *, mirror):
    """The app as a mirror (EXOCORTEX_PUBLIC_ONLY=1) or as the private site."""
    if mirror:
        monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    else:
        monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    return server.app.test_client()


def _ingest(client, payload, secret, gzipped=True):
    raw = json.dumps(payload).encode()
    headers = {"X-Terrain-Secret": secret}
    if gzipped:
        raw = gzip.compress(raw)
        headers["Content-Encoding"] = "gzip"
    return client.post("/api/observatory/terrain/ingest", data=raw, headers=headers)


@pytest.fixture(autouse=True)
def _fresh_caches():
    """The map payload is cached per file-cap for five minutes inside
    routes/terrain.py, and the published artifact is held by mtime — both live
    for the whole process, so one test's map would otherwise be served to the
    next one whose data dir is empty."""
    from routes import terrain, terrain_mirror as mirror
    terrain._terrain_cache.clear()
    mirror._loaded.update(key=None, payload=None)
    yield
    terrain._terrain_cache.clear()
    mirror._loaded.update(key=None, payload=None)


@pytest.fixture
def secret(data_dir):
    """The shared secret, minted into the test's own data dir."""
    return terrain_mirror.secret()


def test_a_published_map_is_what_the_mirror_serves(data_dir, monkeypatch, secret):
    client = _client(monkeypatch, mirror=True)
    assert _ingest(client, _payload(["server.py", "store.py"]), secret).status_code == 200

    got = client.get("/api/observatory/terrain").get_json()
    assert [f["path"] for f in got["repos"][0]["files"]] == ["server.py", "store.py"]
    # The two fields a locally-built payload doesn't carry — a visitor can
    # tell it's a published map, and when the private box built it.
    assert got["mirror"] is True
    assert got["published_at"] == "2026-09-21T10:00:00"


def test_an_unpublished_mirror_still_builds_from_its_own_data(data_dir, monkeypatch):
    """The older PULL mirror — a public host with its own copy of the data —
    must keep working untouched. Nothing published means fall through to the
    local build, unflagged, rather than refusing to draw a map at all."""
    from routes import observatory
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: ())
    client = _client(monkeypatch, mirror=True)
    got = client.get("/api/observatory/terrain")
    assert got.status_code == 200
    assert got.get_json()["repos"] == []
    assert "mirror" not in got.get_json()


def test_the_wrong_secret_never_lands(data_dir, monkeypatch, secret):
    from routes import observatory
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: ())
    client = _client(monkeypatch, mirror=True)
    assert _ingest(client, _payload(["server.py"]), "not-the-secret").status_code == 403
    # Nothing landed, so the map is still the host's own — never the rejected one.
    assert client.get("/api/observatory/terrain").get_json()["repos"] == []


def test_the_door_does_not_exist_on_the_private_site(data_dir, monkeypatch, secret):
    """A leaked secret must not let anyone write the OWNER's map — and the
    door shouldn't announce itself where it has no business being."""
    client = _client(monkeypatch, mirror=False)
    assert _ingest(client, _payload(["server.py"]), secret).status_code == 404


def test_junk_never_replaces_a_good_map(data_dir, monkeypatch, secret):
    client = _client(monkeypatch, mirror=True)
    _ingest(client, _payload(["server.py"]), secret)
    assert client.post("/api/observatory/terrain/ingest", data=b"{}",
                       headers={"X-Terrain-Secret": secret}).status_code == 400
    got = client.get("/api/observatory/terrain").get_json()
    assert [f["path"] for f in got["repos"][0]["files"]] == ["server.py"]


def test_one_artifact_serves_every_tier_of_the_slider(data_dir, monkeypatch, secret):
    """The publisher sends the uncapped map once; the mirror re-cuts it per
    request, and reports the uncapped count so the cap stays honest."""
    client = _client(monkeypatch, mirror=True)
    _ingest(client, _payload([f"file_{i}.py" for i in range(10)]), secret)

    cut = client.get("/api/observatory/terrain?limit=3").get_json()
    assert len(cut["repos"][0]["files"]) == 3
    assert cut["repos"][0]["files_total"] == 10
    assert cut["file_cap"] == 3

    whole = client.get("/api/observatory/terrain?limit=all").get_json()
    assert len(whole["repos"][0]["files"]) == 10


def test_plain_json_is_accepted_too(data_dir, monkeypatch, secret):
    """Gzip is the publisher's choice, not the door's contract."""
    client = _client(monkeypatch, mirror=True)
    assert _ingest(client, _payload(["store.py"]), secret, gzipped=False).status_code == 200
    got = client.get("/api/observatory/terrain").get_json()
    assert [f["path"] for f in got["repos"][0]["files"]] == ["store.py"]


def test_a_mirror_anonymizes_sessions_even_if_the_publisher_did_not(
        data_dir, monkeypatch, secret):
    """Sessions reach a stranger anonymized (terrain._redact_sessions), and
    normally that has already happened on the private box — the publisher
    fetches with no cookie, so it reads as a visitor. This is the second lock.
    A publisher run WITH a cookie, or pointed at a box that predates the
    redaction, would push the owner's own copy; a mirror has no owner to serve
    it to, so it redacts what it hands out regardless."""
    client = _client(monkeypatch, mirror=True)
    raw = _payload(["server.py"])
    raw["sessions"] = [
        {"id": "2026-09-20.101500", "title": "Terrain coils", "lane": "coding"},
        {"id": "2026-09-22.030327", "title": "Morning pages", "lane": "personal"},
    ]
    raw["repos"][0]["files"][0]["sessions"] = [
        {"id": "2026-09-22.030327", "title": "Morning pages", "writes": 2},
    ]
    assert _ingest(client, raw, secret).status_code == 200

    body = client.get("/api/observatory/terrain").get_data(as_text=True)
    assert "Morning pages" not in body and "2026-09-22.030327" not in body
    assert "Terrain coils" in body   # the Coding session is the exhibit

    got = client.get("/api/observatory/terrain").get_json()
    assert got["sessions_redacted"] is True
    card = got["repos"][0]["files"][0]["sessions"][0]
    assert card["title"] == "Personal" and card["writes"] == 2   # activity survives
