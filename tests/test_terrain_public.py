"""The Terrain map for a visitor (public_config.PUBLIC_PATHS + the visitor
lock in routes/terrain.py).

The owner's decision (2026-09-17): "i am ok with personal stuff showing on
the map, just make all personal files unreadable to visitors, but the code
can be interactive for visitors." So, for a logged-out visitor — on the
private site's public view AND on the public-only mirror alike:
  - the map page and its payload answer 200
  - a git-tracked app-code file opens (200, with its text)
  - a vault file answers 403 `private`, and none of its text travels
  - an untracked app-repo file is private too (logs, CLAUDE.local.md)
  - path traversal is still a 404, whoever asks
  - what writes, arms or streams stays 401: traces, flow, creek, the roster
The owner keeps reading the vault through the same endpoint.
"""
from pathlib import Path

import pytest

import store


SECRET_LINE = "what i really think about all this"


@pytest.fixture
def repos(tmp_path, monkeypatch):
    """Re-root Terrain's vault at a temp dir holding one private file; the
    app-code repo stays the real one (server.py is tracked there)."""
    from routes import observatory
    vault = tmp_path / "vault"
    (vault / "tulku").mkdir(parents=True)
    (vault / "tulku" / "journal.md").write_text(SECRET_LINE + "\n")
    monkeypatch.setattr(observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": Path(store.BUILD_DIR)},
        {"id": "vault", "name": "Personal vault", "root": vault},
    ))
    return vault


def _client(monkeypatch, *, mirror, authed):
    if mirror:
        monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    else:
        monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    c = server.app.test_client()
    if authed:
        with c.session_transaction() as sess:
            sess["authed"] = True
    return c


@pytest.fixture(params=["private-site-visitor", "mirror"])
def visitor(request, data_dir, repos, monkeypatch):
    """A stranger, both ways: logged out on the private site, or on the
    mirror carrying a session cookie that must count for nothing."""
    mirror = request.param == "mirror"
    return _client(monkeypatch, mirror=mirror, authed=mirror)


@pytest.fixture
def owner(data_dir, repos, monkeypatch):
    return _client(monkeypatch, mirror=False, authed=True)


def _file(c, repo, path):
    return c.get(f"/api/observatory/terrain/file?repo={repo}&path={path}")


def test_map_page_and_payload_open_to_visitors(visitor):
    assert visitor.get("/terrain/map").status_code == 200
    resp = visitor.get("/api/observatory/terrain")
    assert resp.status_code == 200
    assert {r["id"] for r in resp.get_json()["repos"]} == {"skeleton", "vault"}


def test_visitor_reads_tracked_app_code(visitor):
    resp = _file(visitor, "skeleton", "server.py")
    assert resp.status_code == 200
    assert "def gate" in resp.get_json()["content"]


def test_visitor_cannot_read_the_vault(visitor):
    resp = _file(visitor, "vault", "tulku/journal.md")
    assert resp.status_code == 403
    body = resp.get_json()
    assert body["private"] is True and body["error"] == "private"
    assert SECRET_LINE not in resp.get_data(as_text=True)


def test_visitor_cannot_read_untracked_app_files(visitor, monkeypatch):
    from routes import terrain
    monkeypatch.setattr(terrain, "_tracked_paths", lambda root: frozenset())
    assert _file(visitor, "skeleton", "server.py").status_code == 403


def test_traversal_is_still_not_found(visitor):
    assert _file(visitor, "skeleton", "../../etc/passwd").status_code == 404
    assert _file(visitor, "skeleton", "../vault/tulku/journal.md").status_code == 404


def test_what_writes_or_streams_stays_closed(visitor):
    assert visitor.post("/api/observatory/terrain/trace/arm", json={}).status_code == 401
    assert visitor.get("/api/observatory/terrain/trace").status_code == 401
    assert visitor.get("/api/observatory/flow").status_code == 401
    assert visitor.get("/api/creek?days=14").status_code == 401
    assert visitor.get("/api/sessions").status_code == 401
    assert visitor.get("/api/observatory/terrain/growth").status_code == 401


def test_owner_still_reads_the_vault(owner):
    resp = _file(owner, "vault", "tulku/journal.md")
    assert resp.status_code == 200
    assert SECRET_LINE in resp.get_json()["content"]


# --- what a visitor may know about a SESSION ---------------------------------
#
# Her call, 2026-09-22: "everything that isn't coding should be opaque …
# activity is fine to show … anonymized orbs keep their lane", and the title
# they wear is the room's name. So for a stranger, a non-Coding session keeps
# its orb, its footprint files, its counts, its `last` and its lane, and loses
# its title, its id and its bot. A Coding session is untouched — it's the
# exhibit the public site exists for.
#
# Identity rides in the payload TWICE (the top-level roster and a copy on every
# file card), and the file cards are where a visitor lands after tapping a dot,
# so every test below checks both places.

CODING_TITLE = "Terrain coil spirals"
PERSONAL_TITLE = "Morning pages with the Keeper"
ORCHESTRA_TITLE = "Night crew: backfill the tag table"
UNPLACED_TITLE = "A session the roster never heard of"

# Timestamp-shaped, like the real ones — which is the whole reason the id has
# to go with the title.
CODING_ID = "2026-09-20.101500"
PERSONAL_ID = "2026-09-22.030327"
ORCHESTRA_ID = "2026-09-21.234500"
UNPLACED_ID = "2026-09-19.221000"


@pytest.fixture
def _fresh_terrain_cache():
    """The payload cache lives for the whole process and is keyed by file cap,
    so one test's map would otherwise be served to the next one."""
    from routes import terrain
    terrain._terrain_cache.clear()
    yield
    terrain._terrain_cache.clear()


@pytest.fixture
def sessions(data_dir, repos, monkeypatch, _fresh_terrain_cache):
    """One session per lane, each with a footprint in the vault, plus one that
    only ever appears on a file card. Git heat is stubbed out: these tests are
    about session identity, and a real history scan of the app repo would cost
    seconds per test to say nothing about it."""
    from routes import terrain
    monkeypatch.setattr(terrain, "_terrain_refresh_history", lambda: None)
    monkeypatch.setattr(terrain, "_terrain_git_touches", lambda repo_id: {})
    journal = str(repos / "tulku" / "journal.md")
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {
        CODING_ID: {"title": CODING_TITLE, "lane": "coding", "bot": "spark",
                    "last_at": "2026-09-20T10:20:00"},
        PERSONAL_ID: {"title": PERSONAL_TITLE, "lane": "personal", "bot": "keeper",
                      "last_at": "2026-09-22T03:10:00"},
        ORCHESTRA_ID: {"title": ORCHESTRA_TITLE, "lane": "orchestra", "bot": "spark",
                       "last_at": "2026-09-21T23:50:00"},
    })
    touch = {"writes": 2, "reads": 1, "creates": 0, "last": "2026-09-22T03:10:00Z"}
    store.write("bot_chats/footprints", {
        cid: {"files": {journal: dict(touch)}}
        for cid in (CODING_ID, PERSONAL_ID, ORCHESTRA_ID, UNPLACED_ID)
    })
    return journal


def _roster(payload):
    return {s["title"]: s for s in payload["sessions"]}


def _file_card_sessions(payload):
    return [s for repo in payload["repos"] for f in repo["files"] for s in f["sessions"]]


def test_no_session_title_reaches_a_visitor_but_the_coding_one(visitor, sessions):
    """The blunt check, over the raw body: a stranger reads the Coding
    session's name and none of the others — in EITHER copy, since this looks
    at the whole response."""
    body = visitor.get("/api/observatory/terrain?limit=all").get_data(as_text=True)
    assert CODING_TITLE in body
    assert PERSONAL_TITLE not in body
    assert ORCHESTRA_TITLE not in body
    # The ids are timestamps, so they leak the same fact the titles do.
    assert CODING_ID in body
    assert PERSONAL_ID not in body
    assert ORCHESTRA_ID not in body
    assert UNPLACED_ID not in body


def test_an_anonymized_orb_wears_its_rooms_name_over_an_opaque_handle(visitor, sessions):
    payload = visitor.get("/api/observatory/terrain?limit=all").get_json()
    assert payload["sessions_redacted"] is True
    roster = _roster(payload)

    assert roster[CODING_TITLE]["id"] == CODING_ID
    assert "anon" not in roster[CODING_TITLE]

    personal = roster["Personal"]
    assert personal["id"].startswith("anon-") and personal["anon"] is True
    assert roster["Orchestra"]["id"].startswith("anon-")
    # The bot names a persona, which is identity — it goes with the title.
    assert "bot" not in personal and "bot" not in roster["Orchestra"]


def test_the_file_cards_are_redacted_too(visitor, sessions):
    """The second copy of identity. Redacting only the roster would leave
    every title readable one tap into the map."""
    cards = _file_card_sessions(visitor.get("/api/observatory/terrain?limit=all").get_json())
    titles = {s["title"] for s in cards}
    assert titles == {CODING_TITLE, "Personal", "Orchestra"}
    assert {s["id"] for s in cards if s["title"] != CODING_TITLE} == {
        s["id"] for s in cards if s["id"].startswith("anon-")}


def test_the_handle_still_groups_a_session_with_its_files(visitor, sessions):
    """The orb is built by matching the roster's id against the file cards',
    so the handle has to come out the same in both halves of one payload."""
    payload = visitor.get("/api/observatory/terrain?limit=all").get_json()
    roster_handle = _roster(payload)["Personal"]["id"]
    card_handles = {s["id"] for s in _file_card_sessions(payload)}
    assert roster_handle in card_handles


def test_activity_survives_the_anonymizing(visitor, sessions):
    """Her line was "activity is fine to show": the orb keeps everything that
    says work happened here, and loses only whose and what."""
    payload = visitor.get("/api/observatory/terrain?limit=all").get_json()
    personal = _roster(payload)["Personal"]
    assert personal["lane"] == "personal"
    assert personal["last"] == "2026-09-22T03:10:00"
    assert personal["open"] is True
    card = next(s for s in _file_card_sessions(payload) if s["id"] == personal["id"])
    assert (card["writes"], card["reads"]) == (2, 1)


def test_a_session_with_no_index_entry_is_redacted(visitor, sessions):
    """UNPLACED_ID has a footprint but no index entry. It still reaches the
    roster (_build_terrain gives every footprinted session an orb, so the map
    can't under-report itself), and _conv_lane derives it to ORCHESTRA — the
    gated lane it fails toward. Coding is the allowlist, so it is redacted
    like everything else outside it."""
    payload = visitor.get("/api/observatory/terrain?limit=all").get_json()
    cards = _file_card_sessions(payload)
    assert UNPLACED_ID not in {s["id"] for s in cards}
    assert UNPLACED_ID not in {s["id"] for s in payload["sessions"]}
    # Two Orchestra orbs now: the explicit one, and this derived one.
    assert len([s for s in payload["sessions"] if s["title"] == "Orchestra"]) == 2


def test_a_file_card_the_roster_never_mentions_is_redacted():
    """The defensive branch, reached directly. A published artifact built by
    an older private box could carry a file-card id the roster doesn't list;
    with no lane to read, Coding's allowlist refuses it and it goes opaque."""
    from routes import terrain
    payload = {"sessions": [],
               "repos": [{"id": "vault", "files": [
                   {"path": "tulku/journal.md", "touches": [],
                    "sessions": [{"id": PERSONAL_ID, "title": PERSONAL_TITLE}]}]}]}
    card = terrain._redact_sessions(payload)["repos"][0]["files"][0]["sessions"][0]
    assert card["title"] == "Personal" and card["id"].startswith("anon-")


def test_the_owner_still_sees_every_name(owner, sessions):
    payload = owner.get("/api/observatory/terrain?limit=all").get_json()
    assert "sessions_redacted" not in payload
    assert {s["title"] for s in payload["sessions"]} == {
        CODING_TITLE, PERSONAL_TITLE, ORCHESTRA_TITLE,
        "Untitled"}   # UNPLACED_ID — footprint, no index entry
    assert _roster(payload)[PERSONAL_TITLE]["bot"] == "keeper"


@pytest.mark.parametrize("visitor_first", [True, False])
def test_one_build_serves_both_views_without_crossing(
        data_dir, repos, sessions, monkeypatch, visitor_first):
    """The sharpest hazard in this change. The payload is cached per file cap
    and one build is handed to owner and visitor alike, so without a deliberate
    split whichever request arrived FIRST would decide what the other one saw.
    Both orders, because only one of them fails for a given mistake."""
    stranger = _client(monkeypatch, mirror=False, authed=False)
    her = _client(monkeypatch, mirror=False, authed=True)
    first, second = (stranger, her) if visitor_first else (her, stranger)
    first.get("/api/observatory/terrain?limit=all")
    stranger_body = stranger.get("/api/observatory/terrain?limit=all").get_data(as_text=True)
    her_body = her.get("/api/observatory/terrain?limit=all").get_data(as_text=True)
    assert PERSONAL_TITLE not in stranger_body
    assert PERSONAL_TITLE in her_body
    assert second is not None   # both orders exercised; see the parametrize


def test_the_handle_is_keyed_to_a_secret_not_just_hashed(data_dir, monkeypatch):
    """A session id IS a timestamp, so a bare hash of it is recoverable by
    hashing a year of candidates. The handle must move when the salt does."""
    from routes import terrain
    monkeypatch.setattr(terrain, "_anon_salt", lambda: b"one")
    with_one = terrain._opaque_session_id(PERSONAL_ID)
    monkeypatch.setattr(terrain, "_anon_salt", lambda: b"two")
    assert terrain._opaque_session_id(PERSONAL_ID) != with_one
    # ...and stable for a given salt, or an orb would change identity per poll.
    assert terrain._opaque_session_id(PERSONAL_ID) == terrain._opaque_session_id(PERSONAL_ID)


def test_redacting_twice_changes_nothing(data_dir):
    """What lets a mirror redact defensively: an artifact that arrived already
    redacted passes straight through rather than being hashed a second time."""
    from routes import terrain
    payload = {"sessions": [{"id": PERSONAL_ID, "title": PERSONAL_TITLE, "lane": "personal"}],
               "repos": [{"id": "vault", "files": [
                   {"path": "tulku/journal.md", "touches": [],
                    "sessions": [{"id": PERSONAL_ID, "title": PERSONAL_TITLE}]}]}]}
    once = terrain._redact_sessions(payload)
    assert terrain._redact_sessions(once) == once
    # ...and the original was not mutated: the cache holds that exact object.
    assert payload["sessions"][0]["title"] == PERSONAL_TITLE


def test_a_host_that_cannot_keep_a_salt_still_anonymizes(data_dir, monkeypatch):
    """A mirror with a read-only data dir must not 500 the whole map over a
    salt file, and must not fall back to something guessable. It gets a
    process-lifetime salt instead: handles stop surviving a restart (an orb
    regroups, which is cosmetic) and stay opaque (which isn't)."""
    from routes import terrain
    monkeypatch.setattr(terrain, "_anon_salt_cache", {"dir": None, "salt": None})

    def _refuse(*args, **kwargs):
        raise OSError("read-only file system")
    monkeypatch.setattr(terrain.Path, "write_bytes", _refuse, raising=False)
    monkeypatch.setattr(terrain.Path, "read_bytes", _refuse, raising=False)

    handle = terrain._opaque_session_id(PERSONAL_ID)
    assert handle.startswith("anon-")
    assert PERSONAL_ID not in handle
    # Stable within the process, or one payload's roster and file cards would
    # disagree and the orb would lose its own files.
    assert terrain._opaque_session_id(PERSONAL_ID) == handle
