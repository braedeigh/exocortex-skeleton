"""The People roster moved from a standalone page (`/people` rendering
templates/people.html directly) to a proper dashboard tab: `/people` is now a
legacy path that 302-redirects to `/dashboard/people` (routes/shell.py), which
302-redirects into the React SPA at `/legacy/people` (routes/spa.py), same as
`/housing`. The old split.html shell iframing `/tab/people` still exists as a
rollback at `/classic/people`. Uses the real server app (the split/tab/SPA
machinery lives there, not in a blueprint) against an isolated temp data dir —
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


def test_people_legacy_path_redirects_to_dashboard_tab(authed_client):
    resp = authed_client.get("/people")
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/dashboard/people"


def test_dashboard_people_redirects_into_the_spa(authed_client):
    resp = authed_client.get("/dashboard/people")
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/legacy/people"


def test_legacy_people_serves_the_spa_shell(authed_client):
    resp = authed_client.get("/legacy/people")
    assert resp.status_code == 200
    assert b"window.VIEW_MODE" in resp.data


def test_classic_people_still_renders_the_old_split_shell(authed_client):
    resp = authed_client.get("/classic/people")
    assert resp.status_code == 200
    assert b'src="/tab/people"' in resp.data


def test_people_page_requires_auth(data_dir):
    import server
    c = server.app.test_client()
    resp = c.get("/people")
    # Not a public path (like /housing) -> the auth gate redirects to /login.
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_tab_people_renders_index_with_active_tab(authed_client):
    resp = authed_client.get("/tab/people")
    assert resp.status_code == 200
    assert b'id="tab-people"' in resp.data
    assert b'data-active-tab="people"' in resp.data
