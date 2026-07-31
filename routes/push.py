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

Every push is signed with a VAPID JWT that carries a `sub` contact claim, and
that claim has to be a REACHABLE mailto:/https: URI — see _vapid_claims().
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
import os
import secrets
import time

import config
import store

# How recently a device must have pinged /api/push/presence as visible for
# notify() to treat it as "already looking at the app" and skip the push.
_PRESENCE_SUPPRESS_SEC = 30
# Presence entries older than this are stale (tab closed without a final
# visible:false beacon, laptop slept, ...) — pruned on every presence write.
_PRESENCE_MAX_AGE_SEC = 600
_BODY_TRUNCATE = 140
_TITLE_TRUNCATE = 80
_UA_TRUNCATE = 200
# Where tapping a notification lands when the caller doesn't say. Agent
# events (stop/notification) come from a Claude session, so the terminal is
# the useful place to arrive; callers with somewhere better to go pass their
# own (a to-do reminder sends you to the to-dos, not to a chat).
_DEFAULT_URL = "/chat"


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


def _vapid_claims():
    """The signed contact claim that rides on every push.

    Web push signs each message with a JWT, and that JWT carries a `sub`
    claim naming a way to reach whoever runs this server — so a push service
    can complain to a human if an instance misbehaves. It must be a
    REACHABLE mailto: or https: URI. Apple enforces this strictly and
    rejects anything else with 403 BadJwtToken *before* it looks at the
    message; Chrome's and Firefox's push services don't check at all. That
    asymmetry is a trap: a bad value here works everywhere except iOS, so it
    can sit unnoticed until the one device that matters is an iPhone.

    Resolution order — env override first (a deployment may prefer its own
    https origin over a person's mailbox), then the owner profile's email
    (config.get_profile, which itself resolves stored value -> env ->
    default). Instance-specific by nature, so it never gets hardcoded here.

    Returns None when nothing is configured. That's a real state and the
    caller has to handle it: signing with no `sub` is refused by every push
    service, so a missing contact is a configuration error to surface, not a
    push to attempt.
    """
    contact = (os.environ.get("EXOCORTEX_PUSH_CONTACT") or "").strip()
    if not contact:
        email = (config.get_profile().get("owner_email") or "").strip()
        if email:
            contact = f"mailto:{email}"
    if not contact:
        return None
    # A bare email/host with no scheme is the easy mistake — same 403 as a
    # bogus one, so normalize rather than sign something we know is invalid.
    if not contact.startswith(("mailto:", "https://")):
        contact = f"mailto:{contact}" if "@" in contact else f"https://{contact}"
    return {"sub": contact}


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


def _send_push(sub, title, body_text, pem_path, claims, url=_DEFAULT_URL):
    """Send one push. Returns (result, detail): result is 'sent', 'prune'
    (the push service says this endpoint is gone — 404/410), or 'failed'
    (anything else, never raises). `detail` is a short human-readable reason
    on a failure, else None — the only channel by which a push that never
    arrived can explain itself, since the whole point of this system is that
    nobody is watching the server when it runs."""
    subscription_info = {"endpoint": sub.get("endpoint"), "keys": sub.get("keys") or {}}
    payload = json.dumps({"title": title, "body": body_text, "url": url})
    # A fresh dict per call: webpush() fills in "aud" (from the endpoint) and
    # "exp" IN PLACE only when they're not already set, so a dict reused
    # across sends would keep the first endpoint's aud on every call after.
    claims = dict(claims)
    try:
        webpush(subscription_info=subscription_info, data=payload,
                vapid_private_key=pem_path, vapid_claims=claims)
        return "sent", None
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            return "prune", None
        body = (getattr(e.response, "text", "") or "").strip()[:120]
        return "failed", f"push service said {status}{f': {body}' if body else ''}"
    except Exception as e:
        return "failed", f"{type(e).__name__}: {e}"[:160]


def _dispatch(subs, title, body_text, suppress_presence, url=_DEFAULT_URL):
    """Send `title`/`body_text` to every sub in `subs`, optionally skipping
    ones whose presence entry says they're already looking at the app.
    Returns the {"sent", "suppressed", "pruned", "failed"} counts, plus an
    "error" string whenever something went wrong — a caller (and the
    Settings UI behind it) must be able to tell "delivered" from "the push
    service refused it", which counts alone don't say."""
    claims = _vapid_claims()
    if claims is None:
        # No contact configured: every send would 403. Say so once, instead
        # of a row of identical failures that don't name the cause.
        return {"sent": 0, "suppressed": 0, "pruned": 0, "failed": len(subs),
                "error": "no push contact configured (set the owner email in "
                         "Settings, or EXOCORTEX_PUSH_CONTACT)"}
    pem_path = str(_vapid_pem_path())
    _ensure_vapid()  # make sure the key file actually exists before we loop
    presence = {}
    if suppress_presence:
        presence = store.read("push_presence.json", {"endpoints": {}}).get("endpoints", {}) or {}
    now = time.time()
    sent = suppressed = failed = 0
    to_prune = []
    first_error = None
    for sub in subs:
        endpoint = sub.get("endpoint")
        if not endpoint:
            continue
        if suppress_presence:
            pres = presence.get(_endpoint_hash(endpoint))
            if pres and (now - pres.get("visible_at", 0)) <= _PRESENCE_SUPPRESS_SEC:
                suppressed += 1
                continue
        result, detail = _send_push(sub, title, body_text, pem_path, claims, url)
        if result == "sent":
            sent += 1
        elif result == "prune":
            to_prune.append(endpoint)
        else:
            failed += 1
            first_error = first_error or detail
    pruned = _prune_subs(to_prune)
    counts = {"sent": sent, "suppressed": suppressed, "pruned": pruned, "failed": failed}
    if first_error:
        counts["error"] = first_error
    return counts


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
        # The agent events describe a session, so they compose their own title
        # and are presence-suppressed: if she's already looking at the app,
        # "the session finished" is something she can see for herself.
        #
        # A "reminder" is the opposite on both counts. It brings its own words
        # (scripts/todo_push_dispatcher.py sends the to-do's text) and its own
        # destination, and it is NOT presence-suppressed — a time she set is a
        # commitment she made to herself, and it should arrive whether or not
        # the app happens to be open. Suppressing it would mean the reminder
        # goes quiet exactly when she's at the screen anyway.
        suppress = True
        url = _DEFAULT_URL
        if event == "stop":
            title = f"✓ {session_name} finished"
        elif event == "notification":
            title = f"⏳ {session_name} needs input"
        elif event == "reminder":
            title = (data.get("title") or "").strip()[:_TITLE_TRUNCATE] or "Reminder"
            suppress = False
            # Relative in-app paths only — this string becomes the SW's
            # notificationclick target, and an absolute URL from here would
            # let a caller aim a tap anywhere.
            requested = (data.get("url") or "").strip()
            if requested.startswith("/") and not requested.startswith("//"):
                url = requested
        else:
            return jsonify({"error": "unknown event"}), 400
        body_text = (data.get("body") or "")[:_BODY_TRUNCATE]
        subs = store.read("push_subscriptions.json", {"subs": []}).get("subs", []) or []
        counts = _dispatch(subs, title, body_text, suppress_presence=suppress, url=url)
        return jsonify({"ok": True, **counts})

    @app.route("/api/push/test", methods=["POST"])
    def push_test():
        """Authed, manual "does this work" button — sends to every sub
        regardless of presence, since it exists precisely for testing with
        the app open in front of you.

        `ok` here means A PUSH WAS ACTUALLY ACCEPTED, not "the request
        parsed". This is the one surface whose entire job is answering "does
        push work?", so it must never report success for a send the push
        service refused — a green "sent!" over a silent phone is worse than
        no button at all."""
        subs = store.read("push_subscriptions.json", {"subs": []}).get("subs", []) or []
        if not subs:
            return jsonify({"ok": False, "sent": 0, "suppressed": 0, "pruned": 0,
                            "failed": 0, "error": "no device is subscribed yet"})
        counts = _dispatch(subs, "Exocortex", "Push works!", suppress_presence=False)
        return jsonify({"ok": counts["sent"] > 0, **counts})
