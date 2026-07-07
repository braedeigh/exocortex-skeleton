"""Trust-header handoff from the Rust reverse proxy (exocortex-rs).

The proxy sits in front of Flask and, for requests from a logged-in user,
injects `X-Exo-Proxied: <slug>:<unix_ts>:<mac>` where mac is lowercase-hex
HMAC-SHA256(secret, f"{slug}:{unix_ts}"). The proxy unconditionally strips
this header from client-originated traffic, so a valid mac can only come
from the proxy itself.

No Flask imports here on purpose — this module is pure logic so it can be
unit-tested without dragging in server.py's startup machinery.

Fully inert with no env configured: if EXO_PROXY_SECRET_FILE is unset (or
unreadable), load_secret() returns None and verify_header() always returns
None, so behavior is unchanged from before this module existed.
"""
import hashlib
import hmac
import os

MAX_SKEW_SEC = 300


def load_secret(logger=None) -> bytes | None:
    """Load the shared HMAC secret from EXO_PROXY_SECRET_FILE, if configured.

    Returns None (feature inert) when the env var is unset. Logs one warning
    via `logger` (if given) when the env var is set but the file can't be
    read or doesn't hold valid hex.
    """
    path = os.environ.get("EXO_PROXY_SECRET_FILE")
    if not path:
        return None
    try:
        return bytes.fromhex(open(path).read().strip())
    except (OSError, ValueError) as e:
        if logger:
            logger.warning(f"EXO_PROXY_SECRET_FILE set but unusable ({path}): {e}")
        return None


def verify_header(header_value: str | None, secret: bytes | None, now: float) -> str | None:
    """Validate an X-Exo-Proxied header value; return the slug, or None.

    Never raises on malformed input (bad hex, wrong part count, non-integer
    timestamp all just yield None).
    """
    if not header_value or not secret:
        return None
    parts = header_value.split(":")
    if len(parts) != 3:
        return None
    slug, ts_str, mac = parts
    if not slug:
        return None
    try:
        ts = int(ts_str)
    except ValueError:
        return None
    if abs(now - ts) > MAX_SKEW_SEC:
        return None
    expected = hmac.new(secret, f"{slug}:{ts}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac):
        return None
    return slug
