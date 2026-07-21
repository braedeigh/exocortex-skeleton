"""Pure unit tests for proxy_auth.verify_header — no Flask, no server.py.

proxy_auth.py has no Flask imports on purpose (see its docstring), so these
tests exercise it directly without any app/data_dir fixtures.
"""
import hashlib
import hmac

import proxy_auth

SECRET = b"secret-key-32-bytes-long!!!!!!!!"
NOW = 1_700_000_000.0


def _header(slug, ts, secret=SECRET):
    mac = hmac.new(secret, f"{slug}:{ts}".encode(), hashlib.sha256).hexdigest()
    return f"{slug}:{ts}:{mac}"


def test_valid_header_returns_slug():
    header = _header("owner", int(NOW))
    assert proxy_auth.verify_header(header, SECRET, NOW) == "owner"


def test_expired_timestamp_rejected():
    header = _header("owner", int(NOW) - 301)
    assert proxy_auth.verify_header(header, SECRET, NOW) is None


def test_future_timestamp_rejected():
    header = _header("owner", int(NOW) + 301)
    assert proxy_auth.verify_header(header, SECRET, NOW) is None


def test_timestamp_within_skew_accepted():
    header_past = _header("owner", int(NOW) - 300)
    header_future = _header("owner", int(NOW) + 300)
    assert proxy_auth.verify_header(header_past, SECRET, NOW) == "owner"
    assert proxy_auth.verify_header(header_future, SECRET, NOW) == "owner"


def test_bad_mac_rejected():
    header = f"owner:{int(NOW)}:{'0' * 64}"
    assert proxy_auth.verify_header(header, SECRET, NOW) is None


def test_wrong_part_count_rejected():
    assert proxy_auth.verify_header("owner:123", SECRET, NOW) is None
    assert proxy_auth.verify_header("owner:123:abc:extra", SECRET, NOW) is None
    assert proxy_auth.verify_header("", SECRET, NOW) is None
    assert proxy_auth.verify_header(None, SECRET, NOW) is None


def test_non_hex_mac_does_not_raise():
    header = f"owner:{int(NOW)}:not-hex-at-all"
    assert proxy_auth.verify_header(header, SECRET, NOW) is None


def test_non_int_timestamp_does_not_raise():
    header = "owner:not-a-timestamp:deadbeef"
    assert proxy_auth.verify_header(header, SECRET, NOW) is None


def test_secret_none_always_returns_none():
    header = _header("owner", int(NOW))
    assert proxy_auth.verify_header(header, None, NOW) is None


def test_shared_cross_implementation_vector():
    """Deterministic vector shared with the Rust-side implementation."""
    secret = bytes.fromhex(
        "0011223344556677889900112233445566778899001122334455667788990011"
    )
    slug = "owner"
    ts = 1751900000
    mac = hmac.new(secret, f"{slug}:{ts}".encode(), hashlib.sha256).hexdigest()
    header = f"{slug}:{ts}:{mac}"
    assert proxy_auth.verify_header(header, secret, float(ts)) == "owner"
