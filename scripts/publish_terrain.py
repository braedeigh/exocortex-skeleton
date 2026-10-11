#!/usr/bin/env python3
"""Publish this box's terrain map to a public mirror, every few seconds.

The private box holds the repos, the vault and the session logs; the mirror
holds none of them. So the map is built HERE — the same payload the owner's
own map draws from — and pushed OUT to the mirror's ingest door
(routes/terrain_mirror.py), which keeps the newest one and serves it to
visitors. The connection only ever goes outward: nothing on the public
internet can reach this machine, and a visitor can't read a personal file
because the mirror doesn't have one.

What it sends is the UNCAPPED payload (`?limit=all`, ~215 KB gzipped), once.
The mirror re-cuts it per request through the same ranking this box uses, so
every tier of the visitor's Files slider is correct from the one artifact.

IT ONLY PUSHES WHEN THE MAP CHANGED. `generated_at` moves on every build, so
the comparison ignores it and hashes the rest: between commits and agent
touches the map is genuinely identical, and an idle afternoon sends nothing
at all. That's what makes a ~15s cadence cheap enough to leave running. The
fingerprint is kept on disk, not just in memory, so a `--once` run from cron
skips an unchanged map exactly as the loop does.

The payload comes from this box's own HTTP endpoint rather than by importing
the builder, so the mirror shows exactly what the private map shows, cache
and all — including the 5-second live cache while a session is working, which
is what makes a watcher see the work land as it happens.

Both machines hold the same secret at DATA_DIR/terrain_mirror_secret (0600),
generated on first need by whichever side asks first and copied across once.

Usage:
    scripts/publish_terrain.py --once            # one push, then exit
    scripts/publish_terrain.py                   # loop, ~15s, until killed
    scripts/publish_terrain.py --interval 30
    scripts/publish_terrain.py --once --force    # push even if unchanged

Configuration (flags win over the environment):
    --mirror  / EXOCORTEX_TERRAIN_MIRROR_URL   the mirror's base URL
    --local   / EXOCORTEX_TERRAIN_LOCAL_URL    this box (default localhost:5000)

Prompt that produced it: "I want the public map to display the terrain map in
real time as it's being worked on, pushed out to a mirror rather than exposing
the private box."
"""
import argparse
import gzip
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store                                       # noqa: E402
from routes import terrain_mirror                  # noqa: E402

_DEFAULT_LOCAL = "http://127.0.0.1:5000"
# Where the last-pushed fingerprint is remembered between runs. Beside the
# mirror's own artifact dir (gitignored), because it's the same conversation.
_STATE_NAME = "terrain_mirror/last_pushed"
_DEFAULT_INTERVAL = 15
_TIMEOUT_SEC = 60


def _state_path():
    return store.DATA_DIR / _STATE_NAME


def read_last_fingerprint():
    """What was last pushed, from the previous run. Missing or unreadable
    reads as "nothing pushed yet", which costs one redundant push and never
    a wrong one."""
    try:
        return _state_path().read_text().strip() or None
    except OSError:
        return None


def write_last_fingerprint(fingerprint):
    """Remember what just landed. Best-effort: a map that got there but
    couldn't be recorded is worth a duplicate push next tick, not a crash."""
    if not fingerprint:
        return
    try:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fingerprint)
    except OSError:
        pass


def fetch_map(local_url):
    """This box's own uncapped terrain payload, as raw JSON bytes."""
    url = f"{local_url.rstrip('/')}/api/observatory/terrain?limit=all"
    with urllib.request.urlopen(url, timeout=_TIMEOUT_SEC) as response:
        return response.read()


def map_fingerprint(raw):
    """What the map SAYS, ignoring when it was said — so an unchanged map
    doesn't get pushed just because it was rebuilt. Returns None if the body
    doesn't parse, which the caller treats as "push it and let the far end
    judge"."""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if isinstance(payload, dict):
        payload = {k: v for k, v in payload.items() if k != "generated_at"}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def push(mirror_url, raw, secret):
    """Send one map to the mirror's ingest door, gzipped. Returns its reply
    as a dict; raises urllib's own errors for the caller to report."""
    url = f"{mirror_url.rstrip('/')}/api/observatory/terrain/ingest"
    request = urllib.request.Request(
        url, data=gzip.compress(raw, 6), method="POST",
        headers={"Content-Type": "application/json",
                 "Content-Encoding": "gzip",
                 "X-Terrain-Secret": secret})
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SEC) as response:
        return json.loads(response.read().decode("utf-8"))


def publish_once(mirror_url, local_url, secret, last_fingerprint, force=False):
    """One cycle: read the map, push it if it moved. Returns the fingerprint
    to compare against next time — unchanged on failure, so a mirror that was
    down gets the map on the next tick rather than being skipped as 'already
    sent'."""
    raw = fetch_map(local_url)
    fingerprint = map_fingerprint(raw)
    if not force and fingerprint is not None and fingerprint == last_fingerprint:
        return last_fingerprint, None
    reply = push(mirror_url, raw, secret)
    write_last_fingerprint(fingerprint)
    return fingerprint, reply


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mirror", default=os.environ.get("EXOCORTEX_TERRAIN_MIRROR_URL", ""),
                        help="the mirror's base URL, e.g. https://example.org")
    parser.add_argument("--local", default=os.environ.get("EXOCORTEX_TERRAIN_LOCAL_URL", _DEFAULT_LOCAL),
                        help=f"this box's base URL (default {_DEFAULT_LOCAL})")
    parser.add_argument("--interval", type=float, default=_DEFAULT_INTERVAL,
                        help=f"seconds between pushes when looping (default {_DEFAULT_INTERVAL})")
    parser.add_argument("--once", action="store_true", help="one push, then exit")
    parser.add_argument("--force", action="store_true", help="push even when the map hasn't changed")
    args = parser.parse_args()

    if not args.mirror:
        parser.error("no mirror URL — pass --mirror or set EXOCORTEX_TERRAIN_MIRROR_URL")
    secret = terrain_mirror.secret()

    fingerprint = None if args.force else read_last_fingerprint()
    while True:
        started = time.monotonic()
        try:
            fingerprint, reply = publish_once(args.mirror, args.local, secret,
                                              fingerprint, force=args.force)
            if reply is not None:
                print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} published "
                      f"{reply.get('repos')} repos (built {reply.get('generated_at')})",
                      flush=True)
        except (urllib.error.URLError, OSError, ValueError) as err:
            # A mirror that's down, a laptop that just woke: say so and keep
            # the loop alive. The next tick retries; nothing here is worth
            # taking the publisher down for.
            print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} push failed: {err}",
                  file=sys.stderr, flush=True)
        if args.once:
            return 0
        time.sleep(max(0.0, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
