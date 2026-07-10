"""The People roster is a native SPA route: `/people` serves the React shell
(routes/spa.py) and `/legacy/people` 302-redirects there for old bookmarks.
The split.html/classic/tab machinery was retired 2026-07-09 with the legacy
frontend. Uses the real server app against an isolated temp data dir —
mirrors test_recipe_sourcing_payload.py's authed_client pattern.
"""
import pytest


@pytest.fixture
def authed_client(data_dir):
    import server
    c = server.app.test_client()
    with c.session_transaction() as sess:
        sess["authed"] = True
    return c


def test_people_is_a_valid_tab():
    import server
    assert "people" in server.VALID_TABS


def test_people_path_serves_the_spa_shell(authed_client):
    # /people is a native SPA route now (routes/spa.py), not a redirect chain.
    resp = authed_client.get("/people")
    assert resp.status_code == 200
    assert b"window.VIEW_MODE" in resp.data


def test_dashboard_people_redirects_to_the_native_tab(authed_client):
    resp = authed_client.get("/dashboard/people")
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/people"


def test_legacy_people_redirects_to_the_native_tab(authed_client):
    # /legacy/<tab> survives only as a bookmark redirect (routes/spa.py).
    resp = authed_client.get("/legacy/people")
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/people"


def test_people_page_requires_auth(data_dir):
    import server
    c = server.app.test_client()
    resp = c.get("/people")
    # Not a public path (like /housing) -> the auth gate redirects to /login.
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]
