"""HTTP contract for the web-push routes (routes/push.py): subscribe/
unsubscribe upsert-by-endpoint, presence suppression, muted sessions, and
the hook door's secret auth + endpoint pruning on a 410.

pywebpush.webpush() is monkeypatched (autouse) so nothing here ever touches
the network -- VAPID key generation is real (it's pure local crypto), but
every "send" is a stub the individual tests configure.
"""
import json
import time

import pytest

import store
from routes import push as push_module


@pytest.fixture
def client(data_dir):
    """Minimal app exposing only the push routes."""
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    push_module.register(app)
    return app.test_client()


@pytest.fixture(autouse=True)
def fake_webpush(monkeypatch):
    """Default stub: every send "succeeds". Individual tests override this
    (monkeypatch.setattr(push_module, "webpush", ...)) to exercise pruning
    or failure counting."""
    def _ok(subscription_info, data, vapid_private_key, vapid_claims):
        return None
    monkeypatch.setattr(push_module, "webpush", _ok)


def _subscribe(client, endpoint, p256dh="p", auth="a"):
    return client.post("/api/push/subscribe", json={
        "subscription": {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
    })


def _read_subs():
    return store.read("push_subscriptions.json", {"subs": []})["subs"]


# --- subscribe / unsubscribe --------------------------------------------------

def test_subscribe_upserts_by_endpoint(client):
    endpoint = "https://push.example.com/abc"
    r1 = _subscribe(client, endpoint, p256dh="p1")
    assert r1.status_code == 200
    r2 = _subscribe(client, endpoint, p256dh="p2")   # same endpoint, new keys
    assert r2.status_code == 200
    subs = _read_subs()
    assert len(subs) == 1
    assert subs[0]["keys"]["p256dh"] == "p2"


def test_subscribe_rejects_malformed_body(client):
    r = client.post("/api/push/subscribe", json={"subscription": {"endpoint": "not-a-url"}})
    assert r.status_code == 400
    assert _read_subs() == []


def test_unsubscribe_removes(client):
    endpoint = "https://push.example.com/xyz"
    _subscribe(client, endpoint)
    r = client.post("/api/push/unsubscribe", json={"endpoint": endpoint})
    assert r.status_code == 200
    assert _read_subs() == []


# --- presence ------------------------------------------------------------------

def test_presence_accepts_sendbeacon_text_plain_body(client):
    endpoint = "https://push.example.com/beacon"
    payload = json.dumps({"endpoint": endpoint, "visible": True})
    r = client.post("/api/push/presence", data=payload, content_type="text/plain")
    assert r.status_code == 200
    presence = store.read("push_presence.json", {"endpoints": {}})
    assert push_module._endpoint_hash(endpoint) in presence["endpoints"]


# --- notify: auth + muting -----------------------------------------------------

def test_notify_wrong_secret_403(client):
    push_module._hook_secret()  # make sure a secret file exists to compare against
    r = client.post("/api/push/notify", json={"secret": "nope", "event": "stop", "session": "chat"})
    assert r.status_code == 403


def test_notify_skips_muted_session(client):
    store.write("push_muted.json", {"sessions": ["chat"]})
    secret = push_module._hook_secret()
    r = client.post("/api/push/notify", json={"secret": secret, "event": "stop", "session": "chat"})
    assert r.get_json() == {"ok": True, "skipped": "muted"}


# --- notify: sending + counts ---------------------------------------------------

def test_notify_sends_and_returns_counts(client):
    _subscribe(client, "https://push.example.com/1")
    secret = push_module._hook_secret()
    r = client.post("/api/push/notify", json={"secret": secret, "event": "stop", "session": "chat"})
    assert r.status_code == 200
    assert r.get_json() == {"ok": True, "sent": 1, "suppressed": 0, "pruned": 0, "failed": 0}


def test_notify_suppresses_fresh_presence_but_not_stale(client):
    fresh = "https://push.example.com/fresh"
    stale = "https://push.example.com/stale"
    _subscribe(client, fresh)
    _subscribe(client, stale)
    now = time.time()
    with store.mutate("push_presence.json", {"endpoints": {}}) as data:
        endpoints = data.setdefault("endpoints", {})
        endpoints[push_module._endpoint_hash(fresh)] = {"visible_at": now}          # just now
        endpoints[push_module._endpoint_hash(stale)] = {"visible_at": now - 120}    # 2 min ago

    secret = push_module._hook_secret()
    r = client.post("/api/push/notify", json={"secret": secret, "event": "notification",
                                               "session": "chat", "body": "hi"})
    body = r.get_json()
    assert body["suppressed"] == 1   # fresh one skipped
    assert body["sent"] == 1         # stale one still gets pushed


def test_notify_410_prunes_the_subscription(client, monkeypatch):
    endpoint = "https://push.example.com/gone"
    _subscribe(client, endpoint)

    class _GoneResponse:
        status_code = 410

    def _raise_gone(subscription_info, data, vapid_private_key, vapid_claims):
        raise push_module.WebPushException("gone", response=_GoneResponse())
    monkeypatch.setattr(push_module, "webpush", _raise_gone)

    secret = push_module._hook_secret()
    r = client.post("/api/push/notify", json={"secret": secret, "event": "stop", "session": "chat"})
    body = r.get_json()
    assert body["sent"] == 0
    assert body["pruned"] == 1
    assert _read_subs() == []


def test_notify_other_failure_is_counted_not_raised(client, monkeypatch):
    _subscribe(client, "https://push.example.com/broken")

    def _boom(subscription_info, data, vapid_private_key, vapid_claims):
        raise RuntimeError("network is on fire")
    monkeypatch.setattr(push_module, "webpush", _boom)

    secret = push_module._hook_secret()
    r = client.post("/api/push/notify", json={"secret": secret, "event": "stop", "session": "chat"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["failed"] == 1
    assert len(_read_subs()) == 1   # a generic failure doesn't prune the subscription


# --- test endpoint ---------------------------------------------------------------

def test_test_endpoint_ignores_presence(client):
    endpoint = "https://push.example.com/open"
    _subscribe(client, endpoint)
    with store.mutate("push_presence.json", {"endpoints": {}}) as data:
        data.setdefault("endpoints", {})[push_module._endpoint_hash(endpoint)] = {"visible_at": time.time()}

    r = client.post("/api/push/test")
    body = r.get_json()
    assert body["sent"] == 1        # sent despite a fresh presence entry
    assert body["suppressed"] == 0
