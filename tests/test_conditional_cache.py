"""Perf stage 3: /api/data/<tab> and /api/version are polled every 5s
(static/js/polling.js) plus once more on every visibilitychange, re-downloading
the full JSON body even when nothing changed. server.py's add_conditional_cache
after_request hook ETags those responses and turns a matching If-None-Match
into a bodyless 304 (browsers replay a 304 to fetch() callers as a normal 200
from cache, so no frontend change is needed).

Uses the real server app (the hook + data routes both live there, not in a
blueprint) against an isolated temp data dir — mirrors
test_recipe_sourcing_payload.py's authed_client pattern.
"""
import pytest


@pytest.fixture
def authed_client(data_dir):
    import server
    c = server.app.test_client()
    with c.session_transaction() as sess:
        sess["authed"] = True
    return c


def test_data_today_first_response_carries_etag(authed_client):
    resp = authed_client.get("/api/data/today")
    assert resp.status_code == 200
    assert resp.headers.get("ETag")
    assert "no-cache" in resp.headers.get("Cache-Control", "")


def test_data_today_matching_if_none_match_returns_304(authed_client):
    first = authed_client.get("/api/data/today")
    etag = first.headers["ETag"]

    second = authed_client.get("/api/data/today", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.data == b""


def test_data_today_stale_if_none_match_returns_200(authed_client):
    resp = authed_client.get("/api/data/today", headers={"If-None-Match": '"not-a-real-etag"'})
    assert resp.status_code == 200
    assert resp.data  # full body


def test_api_version_conditional_get_also_304s(authed_client):
    first = authed_client.get("/api/version")
    etag = first.headers.get("ETag")
    assert etag
    second = authed_client.get("/api/version", headers={"If-None-Match": etag})
    assert second.status_code == 304
