"""The People roster moved from a standalone page (`/people` rendering
templates/people.html directly) to a proper dashboard tab: `/people` is now a
legacy path that 302-redirects to `/dashboard/people` (routes/shell.py), which
renders the split.html shell iframing `/tab/people` -> index.html with the
tab-people div, same as `/housing`. Uses the real server app (the split/tab
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


def test_dashboard_people_renders_the_split_shell(authed_client):
    resp = authed_client.get("/dashboard/people")
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
