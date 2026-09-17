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


def test_authed_cookie_still_gets_frosted_view(mirror):
    resp = mirror.get("/api/data/today")
    assert resp.status_code == 200
    todos = resp.get_json().get("todos")
    # "todos" is a frosted stream in public_config: shape and count only
    assert todos is None or todos.get("_frosted") is True


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


def test_switch_off_leaves_the_cookie_working(private):
    html = private.get("/").get_data(as_text=True)
    assert 'window.VIEW_MODE = "authed"' in html
    assert "window.PUBLIC_ONLY = false" in html
    assert private.get("/login").status_code == 200
