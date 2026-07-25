"""Web push notifications — VAPID-signed pushes to subscribed browsers.

The app is a personal PWA with exactly one owner, so this is deliberately
simple: no per-user fan-out, no queueing. Three small collections live in
store.py (each a plain-ish list/dict, no schema needed):

  - push_subscriptions.json {"subs": [...]}  — one entry per browser
    installation that opted in (endpoint + keys + created + ua), upserted by
    endpoint.
  - push_presence.json {"endpoints": {...}}  — endpoint-hash -> last time the
    PWA told us it was in the foreground. Lets notify() skip a device that's
    already looking at the app.
  - push_muted.json {"sessions": [...]}      — tmux session names opted out
    of notifications (no management UI yet; a future bell toggle writes
    this).

The VAPID keypair and the hook's shared secret are NOT store.py collections —
store.write()'s SQL-mirror/export machinery is meant for app data, and a
private signing key must never be a candidate for that. They're plain files
directly under the data dir (push_vapid.pem, push_hook_secret), generated on
first need and chmod 0600, guarded by the same flock-a-lock-file pattern
store.mutate() uses so two gunicorn workers racing to generate one on cold
start can't clobber each other.

POST /api/push/notify is the hook door: Claude Code's Stop/Notification hooks
(scripts/push_notify_hook.py) call it from localhost with no session cookie,
authenticated by a shared secret instead — see its PUBLIC_PATHS entry in
public_config.py. Everything else here rides the normal auth gate.
"""
from datetime import datetime
from flask import request, jsonify
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from py_vapid.utils import b64urlencode
from pywebpush import webpush, WebPushException
import fcntl
import hashlib
import hmac
import json
import secrets
import time

import store

# How recently a device must have pinged /api/push/presence as visible for
# notify() to treat it as "already looking at the app" and skip the push.
_PRESENCE_SUPPRESS_SEC = 30
# Presence entries older than this are stale (tab closed without a final
# visible:false beacon, laptop slept, ...) — pruned on every presence write.
_PRESENCE_MAX_AGE_SEC = 600
_BODY_TRUNCATE = 140
_UA_TRUNCATE = 200


# --- VAPID keypair + hook secret: plain files, not a store.py collection ----

def _vapid_pem_path():
    """Resolved fresh on every call (mirrors routes/terminal.py's
    _keeper_state_dir) so tests can monkeypatch store.DATA_DIR and get an
    isolated key file, same as every other collection."""
    return store.DATA_DIR / "push_vapid.pem"


def _hook_secret_path():
    return store.DATA_DIR / "push_hook_secret"


def _ensure_vapid():
    """The VAPID keypair, generating + persisting one on first need. Locked
    (same path.with_suffix(...'.lock') idea as store.mutate) so two gunicorn
    workers racing on cold start can't generate two different keys and have
    the second clobber the first out from under already-issued subscriptions."""
    path = _vapid_pem_path()
    if path.exists():
        return Vapid02.from_file(str(path))
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        # Vapid02.from_file() generates+saves if the file is still missing —
        # re-check under the lock in case the other worker won the race
        # while we were waiting on flock.
        is_new = not path.exists()
        vapid = Vapid02.from_file(str(path))
        if is_new:
            path.chmod(0o600)
    return vapid


def _application_server_key():
    """The browser-facing applicationServerKey: base64url (unpadded) of the
    uncompressed EC public point, per the Push API's subscribe() contract."""
    vapid = _ensure_vapid()
    raw = vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64urlencode(raw)


def _hook_secret():
    """The shared secret scripts/push_notify_hook.py authenticates with,
    generated on first need. Same lock pattern as _ensure_vapid — this file
    is read far more often than written, so the common path (already exists)
    never takes the lock at all."""
    path = _hook_secret_path()
    if path.exists():
        return path.read_text().strip()
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        if not path.exists():
            path.write_text(secrets.token_hex(32))
            path.chmod(0o600)
    return path.read_text().strip()


# --- subscriptions / presence helpers ---------------------------------------

def _endpoint_hash(endpoint):
    """Short, non-reversible key for an endpoint — push_presence.json indexes
    by this instead of the (long, bearer-token-shaped) endpoint URL itself."""
    return hashlib.sha256(endpoint.encode()).hexdigest()[:16]


def _valid_subscription(sub):
    if not isinstance(sub, dict):
        return False
    endpoint = sub.get("endpoint")
    keys = sub.get("keys")
    if not (isinstance(endpoint, str) and endpoint.startswith("http")):
        return False
    return (isinstance(keys, dict)
            and isinstance(keys.get("p256dh"), str) and keys.get("p256dh")
            and isinstance(keys.get("auth"), str) and keys.get("auth"))


def _prune_subs(endpoints):
    """Drop subscriptions (and their presence entries) whose endpoint the
    push service told us is gone (404/410 — see _send_push). Returns the
    count actually removed."""
    endpoints = set(endpoints)
    if not endpoints:
        return 0
    with store.mutate("push_subscriptions.json", {"subs": []}) as data:
        before = len(data.get("subs", []))
        data["subs"] = [s for s in data.get("subs", []) if s.get("endpoint") not in endpoints]
        removed = before - len(data["subs"])
    with store.mutate("push_presence.json", {"endpoints": {}}) as data:
        eps = data.setdefault("endpoints", {})
        for e in endpoints:
            eps.pop(_endpoint_hash(e), None)
    return removed


def _send_push(sub, title, body_text, pem_path):
    """Send one push. Returns 'sent', 'prune' (the push service says this
    endpoint is gone — 404/410), or 'failed' (anything else, never raises)."""
    subscription_info = {"endpoint": sub.get("endpoint"), "keys": sub.get("keys") or {}}
    payload = json.dumps({"title": title, "body": body_text, "url": "/chat"})
    # A fresh dict per call: webpush() fills in "aud" (from the endpoint) and
    # "exp" IN PLACE only when they're not already set, so a dict reused
    # across sends would keep the first endpoint's aud on every call after.
    claims = {"sub": "mailto:owner@localhost"}
    try:
        webpush(subscription_info=subscription_info, data=payload,
                vapid_private_key=pem_path, vapid_claims=claims)
        return "sent"
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        return "prune" if status in (404, 410) else "failed"
    except Exception:
        return "failed"


def _dispatch(subs, title, body_text, suppress_presence):
    """Send `title`/`body_text` to every sub in `subs`, optionally skipping
    ones whose presence entry says they're already looking at the app.
    Returns the {"sent", "suppressed", "pruned", "failed"} counts."""
    pem_path = str(_vapid_pem_path())
    _ensure_vapid()  # make sure the key file actually exists before we loop
    presence = {}
    if suppress_presence:
        presence = store.read("push_presence.json", {"endpoints": {}}).get("endpoints", {}) or {}
    now = time.time()
    sent = suppressed = failed = 0
    to_prune = []
    for sub in subs:
        endpoint = sub.get("endpoint")
        if not endpoint:
            continue
        if suppress_presence:
            pres = presence.get(_endpoint_hash(endpoint))
            if pres and (now - pres.get("visible_at", 0)) <= _PRESENCE_SUPPRESS_SEC:
                suppressed += 1
                continue
        result = _send_push(sub, title, body_text, pem_path)
        if result == "sent":
            sent += 1
        elif result == "prune":
            to_prune.append(endpoint)
        else:
            failed += 1
    pruned = _prune_subs(to_prune)
    return {"sent": sent, "suppressed": suppressed, "pruned": pruned, "failed": failed}


def register(app):

    @app.route("/api/push/vapid-key")
    def push_vapid_key():
        return jsonify({"key": _application_server_key()})

    @app.route("/api/push/subscribe", methods=["POST"])
    def push_subscribe():
        data = request.get_json(silent=True) or {}
        sub = data.get("subscription")
        if not _valid_subscription(sub):
            return jsonify({"error": "malformed subscription"}), 400
        endpoint = sub["endpoint"]
        ua = (request.headers.get("User-Agent") or "")[:_UA_TRUNCATE]
        with store.mutate("push_subscriptions.json", {"subs": []}) as store_data:
            subs = store_data.setdefault("subs", [])
            existing = next((s for s in subs if s.get("endpoint") == endpoint), None)
            if existing:
                existing["keys"] = sub["keys"]
                existing["ua"] = ua
            else:
                subs.append({
                    "endpoint": endpoint,
                    "keys": sub["keys"],
                    "created": datetime.now().isoformat(timespec="seconds"),
                    "ua": ua,
                })
        return jsonify({"ok": True})

    @app.route("/api/push/unsubscribe", methods=["POST"])
    def push_unsubscribe():
        data = request.get_json(silent=True) or {}
        endpoint = data.get("endpoint")
        if isinstance(endpoint, str) and endpoint:
            with store.mutate("push_subscriptions.json", {"subs": []}) as store_data:
                store_data["subs"] = [s for s in store_data.get("subs", []) if s.get("endpoint") != endpoint]
            with store.mutate("push_presence.json", {"endpoints": {}}) as store_data:
                store_data.setdefault("endpoints", {}).pop(_endpoint_hash(endpoint), None)
        return jsonify({"ok": True})

    @app.route("/api/push/presence", methods=["POST"])
    def push_presence():
        # navigator.sendBeacon() (used so presence:false fires reliably on tab
        # close/hide) posts a text/plain Blob, not application/json — force
        # past the content-type check and fall back to {} if it still isn't
        # parseable JSON, same as any other malformed body here.
        data = request.get_json(force=True, silent=True) or {}
        endpoint = data.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint:
            return jsonify({"ok": True})
        visible = bool(data.get("visible"))
        h = _endpoint_hash(endpoint)
        now = time.time()
        with store.mutate("push_presence.json", {"endpoints": {}}) as store_data:
            endpoints = store_data.setdefault("endpoints", {})
            cutoff = now - _PRESENCE_MAX_AGE_SEC
            for k in list(endpoints):
                if endpoints[k].get("visible_at", 0) < cutoff:
                    del endpoints[k]
            if visible:
                endpoints[h] = {"visible_at": now}
            else:
                endpoints.pop(h, None)
        return jsonify({"ok": True})

    @app.route("/api/push/notify", methods=["POST"])
    def push_notify():
        """The hook door — exempt from the session gate (see PUBLIC_PATHS),
        so it authenticates itself: the secret in the body must match
        push_hook_secret exactly."""
        data = request.get_json(silent=True) or {}
        secret = str(data.get("secret") or "")
        if not hmac.compare_digest(_hook_secret(), secret):
            return jsonify({"error": "forbidden"}), 403
        session_name = data.get("session") or ""
        muted = store.read("push_muted.json", {"sessions": []}).get("sessions") or []
        if session_name in muted:
            return jsonify({"ok": True, "skipped": "muted"})
        event = data.get("event")
        if event == "stop":
            title = f"✓ {session_name} finished"
        elif event == "notification":
            title = f"⏳ {session_name} needs input"
        else:
            return jsonify({"error": "unknown event"}), 400
        body_text = (data.get("body") or "")[:_BODY_TRUNCATE]
        subs = store.read("push_subscriptions.json", {"subs": []}).get("subs", []) or []
        counts = _dispatch(subs, title, body_text, suppress_presence=True)
        return jsonify({"ok": True, **counts})

    @app.route("/api/push/test", methods=["POST"])
    def push_test():
        """Authed, manual "does this work" button — sends to every sub
        regardless of presence, since it exists precisely for testing with
        the app open in front of you."""
        subs = store.read("push_subscriptions.json", {"subs": []}).get("subs", []) or []
        counts = _dispatch(subs, "Exocortex", "Push works!", suppress_presence=False)
        return jsonify({"ok": True, **counts})
