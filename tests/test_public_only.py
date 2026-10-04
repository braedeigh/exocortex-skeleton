"""The public-only mirror switch (config.public_only, EXOCORTEX_PUBLIC_ONLY).

A second copy of the site can run on a public host against a copy of the data
(a portfolio mirror). What keeps that copy from being a second door into the
private site is this switch, so the contract is pinned here:
  - an authed session cookie still gets the PUBLIC (frosted) view
  - /login is gone (404), on GET and POST
  - a private page redirects to the front door, a private API answers 401
  - the shell is told (window.PUBLIC_ONLY) so it can hide its Sign-in buttons
  - with the switch off, none of this changes (the session cookie still works)

Uses the real server app, like test_conditional_cache.py, because the gate
lives in server.py and not in a blueprint.
"""
import pytest


@pytest.fixture
def mirror(data_dir, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    import server
    c = server.app.test_client()
    with c.session_transaction() as sess:
        sess["authed"] = True          # a real cookie — must still count for nothing
    return c


@pytest.fixture
def private(data_dir, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    c = server.app.test_client()
    with c.session_transaction() as sess:
        sess["authed"] = True
    return c


def test_authed_cookie_counts_for_nothing(mirror):
    # The dashboard data is closed to visitors since 2026-09-17 (see the
    # "only Terrain" block at the bottom) — and a real cookie doesn't reopen
    # it. What IS open answers the same to the cookie as to anyone.
    assert mirror.get("/api/data/today").status_code == 401
    assert mirror.get("/api/observatory/terrain").status_code == 200


def test_login_page_is_gone(mirror):
    assert mirror.get("/login").status_code == 404
    assert mirror.post("/login", data={"password": "x"}).status_code == 404


def test_private_page_redirects_to_front_door(mirror):
    resp = mirror.get("/observatory")
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/")
    assert "/login" not in resp.headers["Location"]


def test_private_api_is_unauthorized(mirror):
    assert mirror.get("/api/observatory/bots").status_code == 401
    assert mirror.get("/api/auth-check").status_code == 401


def test_shell_is_told_it_is_a_mirror(mirror):
    html = mirror.get("/").get_data(as_text=True)
    assert 'window.VIEW_MODE = "public"' in html
    assert "window.PUBLIC_ONLY = true" in html


def test_mirror_header_gets_the_way_back_to_the_main_site(mirror, private, monkeypatch):
    """The page that may frame the mirror is the owner's main site, and a
    visitor's header links back to it. The private site gets no such link."""
    monkeypatch.setenv("EXOCORTEX_FRAME_ANCESTORS", "https://example.org https://www.example.org")
    monkeypatch.setenv("EXOCORTEX_PUBLIC_ONLY", "1")
    assert '"home_site": "https://example.org"' in mirror.get("/terrain/files").get_data(as_text=True)
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY")
    assert '"home_site": ""' in private.get("/terrain/files").get_data(as_text=True)


def test_switch_off_leaves_the_cookie_working(private):
    html = private.get("/").get_data(as_text=True)
    assert 'window.VIEW_MODE = "authed"' in html
    assert "window.PUBLIC_ONLY = false" in html
    assert private.get("/login").status_code == 200


# --- "only Terrain for now" (2026-09-17) ------------------------------------
# public_config splits what a stranger may reach into _SHELL_PATHS (the app
# shell), PRESENTABLE_PATHS (the exhibits — today: the Terrain map) and
# _NOT_YET_PRESENTABLE (everything that used to be public and is closed until
# the owner moves its line back up). These pin that every closed line IS
# closed, on the mirror and on the private site's logged-out view alike, and
# that the shell and the map stay open — so reopening a page is a move in
# that file, never an accident.

import pytest

import public_config


@pytest.fixture
def stranger(data_dir, monkeypatch):
    """Logged out on the private site (no cookie, switch off)."""
    monkeypatch.delenv("EXOCORTEX_PUBLIC_ONLY", raising=False)
    import server
    return server.app.test_client()


def _closed_paths():
    # Prefix entries ("/item/buy/") get a concrete child so the request is real.
    return [p + "x" if p.endswith("/") else p for p in public_config._NOT_YET_PRESENTABLE]


@pytest.mark.parametrize("path", _closed_paths())
def test_not_yet_presentable_is_closed_on_the_mirror(mirror, path):
    resp = mirror.get(path)
    if path.startswith("/api/"):
        assert resp.status_code == 401, path
    else:
        assert resp.status_code == 302 and resp.headers["Location"].endswith("/"), path
        assert "/login" not in resp.headers["Location"]


@pytest.mark.parametrize("path", _closed_paths())
def test_not_yet_presentable_is_closed_to_a_stranger(stranger, path):
    resp = stranger.get(path)
    if path.startswith("/api/"):
        assert resp.status_code == 401, path
    else:
        assert resp.status_code == 302 and resp.headers["Location"].endswith("/login"), path


def test_presentable_and_shell_stay_open(mirror):
    assert mirror.get("/").status_code == 200
    assert mirror.get("/terrain/files").status_code == 200
    assert mirror.get("/terrain/map").status_code == 200
    assert mirror.get("/api/observatory/terrain").status_code == 200
    assert mirror.get("/api/version").status_code == 200
    assert mirror.get("/manifest.webmanifest").status_code == 200


# The map's shape-only companions, opened 2026-09-22 so the public map draws
# the same threads, pond landmark and file pop-out the owner's does. Each is
# the exact path: the content endpoints beside them stay shut.
@pytest.mark.parametrize("path", ["/code", "/api/creek", "/api/pond/shape"])
def test_map_companions_pass_the_gate(mirror, path):
    resp = mirror.get(path)
    assert resp.status_code not in (401, 302), path


@pytest.mark.parametrize("path", [
    "/terrain/pond", "/terrain/sql", "/terrain/flow",
    "/api/observatory/flow", "/api/observatory", "/api/pond/cards",
    "/api/creek/collection/todos/now",
])
def test_what_would_quote_her_stays_shut(mirror, path):
    resp = mirror.get(path)
    if path.startswith("/api/"):
        assert resp.status_code == 401, path
    else:
        assert resp.status_code == 302, path


def test_the_three_tiers_do_not_overlap():
    tiers = (set(public_config._SHELL_PATHS), set(public_config.PRESENTABLE_PATHS),
             set(public_config._NOT_YET_PRESENTABLE))
    assert not (tiers[0] & tiers[1]) and not (tiers[0] & tiers[2]) and not (tiers[1] & tiers[2])
    for p in public_config._NOT_YET_PRESENTABLE:
        assert not public_config.is_public_path(p), p


# --- who may frame the mirror (server.frame_policy) ----------------------------
# The portfolio page at the apex domain embeds /terrain/map?embed=1 in an
# <iframe>, which the client forwards to /terrain/files; nothing else on the mirror may be framed, by anyone, and the
# private instance sends no policy at all (its own surfaces frame each other).

def test_only_the_map_may_be_framed_and_only_by_the_configured_origins(mirror, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_FRAME_ANCESTORS", "https://example.org https://www.example.org")
    assert mirror.get("/terrain/map").headers["Content-Security-Policy"] == \
        "frame-ancestors https://example.org https://www.example.org"
    assert mirror.get("/terrain/map?embed=1").headers["Content-Security-Policy"] == \
        "frame-ancestors https://example.org https://www.example.org"
    assert mirror.get("/terrain/files?embed=1").headers["Content-Security-Policy"] == \
        "frame-ancestors https://example.org https://www.example.org"
    # The food map is the second exhibit, framed the same way.
    assert mirror.get("/food-map?embed=1").headers["Content-Security-Policy"] == \
        "frame-ancestors https://example.org https://www.example.org"
    for path in ("/", "/terrain", "/api/observatory/terrain", "/api/version", "/kitchen"):
        assert mirror.get(path).headers["Content-Security-Policy"] == "frame-ancestors 'none'", path


def test_no_configured_origins_means_nobody_frames_anything(mirror, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_FRAME_ANCESTORS", raising=False)
    assert mirror.get("/terrain/map").headers["Content-Security-Policy"] == "frame-ancestors 'none'"


def test_private_instance_sends_no_frame_policy(private, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_FRAME_ANCESTORS", "https://example.org")
    assert "Content-Security-Policy" not in private.get("/terrain/map").headers
    assert "Content-Security-Policy" not in private.get("/").headers
