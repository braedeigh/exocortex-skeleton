"""Terrain mirror — the live map, published OUT to a public host that holds
none of the data behind it.

The private box builds the terrain payload it already builds for its own map
(routes/terrain.py) and POSTs it here every few seconds
(scripts/publish_terrain.py). This module is the far end: it takes the
payload in at POST /api/observatory/terrain/ingest, keeps the newest one on
disk, and hands it back when a visitor asks for the map — so a public mirror
can draw a map that is seconds behind the private box while owning no vault,
no exo.db and no git history.

WHY IT'S SHAPED AS A PUSH. The alternative is publishing the private box
itself. Then every route on the machine holding the vault faces the open
internet, and the only wall between a stranger and her journals is the
public-path gate being correct on every path, forever. Pushing inverts that:
the connection is outbound, nothing reaches in, and a visitor can't read a
personal file because the file ISN'T THERE. The privacy stops being a code
path that has to hold and becomes a fact about the disk.

What travels is the map payload and nothing else: paths, commit timestamps,
session identity, run buckets. No file contents ever — a mirror's
/terrain/file serves out of its own skeleton checkout (shareable code, public
on GitHub already) and answers `private` for everything it doesn't have.

SESSIONS ARRIVE ANONYMIZED, AND ARE ANONYMIZED AGAIN HERE. Every non-Coding
session loses its name and its id to terrain._redact_sessions before a
stranger sees it, and the publisher fetches this box's map over HTTP with no
cookie — so it reads as a stranger and the artifact it pushes is already
redacted. That is one link, and a mirror is the wrong place to have exactly
one: a publisher run with a cookie, or pointed at a box that hasn't been
updated, would push the owner's own copy and this module would serve it
verbatim. So `published()` redacts what it hands out regardless. The function
is idempotent (it no-ops on a payload already carrying `sessions_redacted`),
so the normal path costs a dict lookup and the abnormal one is still safe.

ONE ARTIFACT, EVERY TIER. The publisher sends the UNCAPPED payload once; this
module re-cuts it per request through terrain._cap_files, the same ranking the
private box uses, so the visitor's Files slider lands on the same files it
would have there. Sending one artifact instead of four keeps the push small
(~215 KB gzipped) and keeps the tiers from drifting apart.

Touches: routes/terrain.py (the shared cap ranking, and the GET that consults
this module when config.public_only()), public_config.py (the ingest door is
exempt from the session gate, like /api/push/notify — it authenticates
itself), scripts/publish_terrain.py (the other end), store.py (DATA_DIR).

Prompt that produced it: "I want the public map to display the terrain map in
real time as it's being worked on, pushed out to a mirror rather than exposing
the private box."
"""
from datetime import datetime
from flask import request, jsonify
import fcntl
import gzip
import hmac
import json
import secrets

import config
import store

# The door takes a whole map at once, so it needs a real ceiling rather than
# the usual few-KB JSON body: ~1.7 MB uncompressed today, and a repo that
# doubles shouldn't start failing. Anything past this is refused unread.
_MAX_INGEST_BYTES = 32 * 1024 * 1024


def _secret_path():
    return store.DATA_DIR / "terrain_mirror_secret"


def secret():
    """The shared secret the publisher authenticates with, generated on first
    need. Same lock pattern as routes/push.py's hook secret: the common path
    (the file already exists) never takes the lock at all.

    The same 64 hex characters live on both machines — generated here or on
    the private box, whichever asks first, then copied across by hand once."""
    path = _secret_path()
    if path.exists():
        return path.read_text().strip()
    lock_path = path.with_suffix(path.suffix + ".lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        if not path.exists():
            path.write_text(secrets.token_hex(32))
            path.chmod(0o600)
    return path.read_text().strip()


def _artifact_path():
    return store.DATA_DIR / "terrain_mirror" / "payload.json.gz"


# Decompressing and parsing ~1.7 MB of JSON on every map request would be the
# mirror's whole CPU budget, so the parsed payload is held in memory and
# reused until the file on disk changes. Keyed by path AND mtime: the
# publisher writes by atomic replace, so a new mtime means a new map — and
# the path is in the key because a test (or a re-pointed DATA_DIR) can swap
# the file underneath without the clock moving.
_loaded = {"key": None, "payload": None}


def store_payload(raw_json):
    """Write the newest published map, atomically. Gzipped on disk because
    that's how it arrived and how it's cheapest to keep; the replace is what
    makes a reader either see the whole old map or the whole new one."""
    path = _artifact_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wb") as out:
        out.write(raw_json)
    tmp.replace(path)


def _load():
    """The published payload, parsed — or None if nothing has been published
    yet. Cached until the artifact's mtime moves."""
    path = _artifact_path()
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        return None
    if _loaded["key"] == key:
        return _loaded["payload"]
    try:
        with gzip.open(path, "rb") as fh:
            payload = json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError):
        return None   # a torn artifact reads as "not published", never a 500
    if not isinstance(payload, dict):
        return None
    _loaded.update(key=key, payload=payload)
    return payload


def published(file_cap):
    """The published map, cut to `file_cap` and with its non-Coding sessions
    anonymized — what this mirror answers GET /api/observatory/terrain with.
    None when nothing has been published.

    Two fields are added that a locally-built payload doesn't carry:
    `mirror` (so the client knows it's looking at a published map) and
    `published_at`/`published_ts` (when the private box built it). The map's
    refresh chip ages off THAT rather than off the fetch, so a publisher that
    has stopped shows as a number that keeps growing instead of a map
    pretending to be live — the one failure mode a live map owes a visitor.

    None means nothing has been published, and the caller falls back to
    building from whatever data the host has of its own."""
    payload = _load()
    if payload is None:
        return None
    # Late import: routes/terrain.py imports this module at its top, so the
    # ranking is borrowed at call time rather than at import time.
    from routes import terrain
    # Anonymize non-Coding sessions, again. Nothing authenticates on a mirror,
    # so every reader here is a stranger and there is no view to choose
    # between; a payload that arrived redacted passes straight through.
    payload = terrain._redact_sessions(payload)
    repos_out = []
    for repo in payload.get("repos") or []:
        if not isinstance(repo, dict):
            continue
        files = repo.get("files") or []
        repos_out.append({**repo, "files": terrain._cap_files(files, file_cap)})
    return {**payload, "repos": repos_out, "file_cap": file_cap,
            "mirror": True,
            "published_at": payload.get("generated_at"),
            "published_ts": payload.get("generated_ts")}


def register(app):
    @app.route("/api/observatory/terrain/ingest", methods=["POST"])
    def observatory_terrain_ingest():
        """Take in one freshly built map from the private box.

        The door only exists on a mirror: on the private site it answers 404,
        so a leaked secret can't be used to poison the owner's own map (and
        the door doesn't announce itself where it has no business being).

        Exempt from the session gate (see PUBLIC_PATHS), so it authenticates
        itself — the X-Terrain-Secret header must match, compared in constant
        time. The body is the payload JSON, gzipped when the publisher says
        so, refused unread past _MAX_INGEST_BYTES."""
        if not config.public_only():
            return jsonify({"error": "not found"}), 404
        sent = request.headers.get("X-Terrain-Secret") or ""
        if not hmac.compare_digest(secret(), sent):
            return jsonify({"error": "forbidden"}), 403
        raw = request.get_data(cache=False)
        if len(raw) > _MAX_INGEST_BYTES:
            return jsonify({"error": "too large"}), 413
        if (request.headers.get("Content-Encoding") or "").lower() == "gzip":
            try:
                raw = gzip.decompress(raw)
            except (OSError, EOFError, ValueError):
                return jsonify({"error": "bad gzip"}), 400
        # Validate the shape before it lands: a map has repos. Anything else
        # would replace a good artifact with something the map can't draw.
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return jsonify({"error": "bad json"}), 400
        if not isinstance(payload, dict) or not isinstance(payload.get("repos"), list):
            return jsonify({"error": "not a terrain payload"}), 400
        store_payload(raw)
        return jsonify({"ok": True,
                        "received_at": datetime.now().isoformat(timespec="seconds"),
                        "generated_at": payload.get("generated_at"),
                        "repos": len(payload["repos"])})
