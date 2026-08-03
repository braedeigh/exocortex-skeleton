"""Tests for the night crew's screenshot logic (tools/nightcrew/shots.py).

Plain English: the morning card leads with before/after pictures, so two things
have to be right — WHICH page gets photographed, and the throwaway auth that
stops every shot being of the login screen. Both are pure enough to test; the
browser and the server aren't, and aren't tested here.

The route-inference tests use the repo's REAL routes directory, because the
whole point of that function is that it reads the actual router instead of
carrying a hand-maintained map that would drift.
"""
import hashlib
import hmac
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import proxy_auth  # noqa: E402
from tools.nightcrew import shots  # noqa: E402


# --- which page gets photographed ------------------------------------------

def test_feature_change_resolves_through_the_real_router():
    assert shots.route_for(["frontend/src/features/journal/DevNotesPanel.tsx"]) == "/journal"


def test_changed_route_file_names_its_own_page():
    assert shots.route_for(["frontend/src/routes/inventory.tsx"]) == "/inventory"


def test_index_route_is_the_root_path():
    assert shots.route_for(["frontend/src/routes/index.tsx"]) == "/"


def test_backend_only_change_has_no_page():
    """Honest None beats a guess: a screenshot of the wrong page is worse than
    no screenshot, because it looks like evidence."""
    assert shots.route_for(["routes/todos.py", "store.py"]) is None


def test_unknown_feature_yields_no_page():
    assert shots.route_for(["frontend/src/features/notafeature/X.tsx"]) is None


def test_empty_change_list_yields_no_page():
    assert shots.route_for([]) is None


def test_features_touched_dedupes_and_keeps_order():
    assert shots.features_touched([
        "frontend/src/features/journal/a.tsx",
        "frontend/src/features/journal/b.tsx",
        "frontend/src/features/kitchen/c.tsx",
    ]) == ["journal", "kitchen"]


def test_route_file_takes_priority_over_feature_inference():
    """If the agent touched a route file, that page is the answer — no need to
    go looking for whichever route happens to import a changed feature."""
    assert shots.route_for([
        "frontend/src/features/journal/x.tsx",
        "frontend/src/routes/kitchen.tsx",
    ]) == "/kitchen"


# --- the throwaway auth ----------------------------------------------------

def test_minted_header_verifies_against_the_real_verifier():
    """The header this mints must satisfy the SAME function server.py's gate
    uses — otherwise every shot is silently of the login page."""
    secret = os.urandom(32).hex()
    header = shots.mint_header(secret, slug="nightcrew")
    assert proxy_auth.verify_header(header, bytes.fromhex(secret), __import__("time").time()) == "nightcrew"


def test_header_from_a_different_secret_is_rejected():
    header = shots.mint_header(os.urandom(32).hex())
    other = os.urandom(32)
    assert proxy_auth.verify_header(header, other, __import__("time").time()) is None


def test_stale_header_is_rejected():
    """Skew-bounded like the real thing — a shot's header is minted seconds
    before use, so a stale one means something is wrong, not slow."""
    secret = os.urandom(32).hex()
    header = shots.mint_header(secret, now=1000)
    assert proxy_auth.verify_header(header, bytes.fromhex(secret), 1000 + 10_000) is None


def test_mint_header_shape_matches_the_documented_protocol():
    secret = os.urandom(32).hex()
    slug, ts, mac = shots.mint_header(secret, slug="nightcrew", now=1234).split(":")
    assert (slug, ts) == ("nightcrew", "1234")
    expected = hmac.new(bytes.fromhex(secret), b"nightcrew:1234", hashlib.sha256).hexdigest()
    assert mac == expected


# --- scratch data ----------------------------------------------------------

def test_scratch_copies_json_and_nothing_heavy(tmp_path):
    """Only the top-level JSON is copied — the media directories are what make
    the real data dir 500MB+, and no rendered page needs them."""
    src = tmp_path / "real"
    (src / "uploads-archive").mkdir(parents=True)
    (src / "todos.json").write_text("{}")
    (src / "uploads-archive" / "big.bin").write_bytes(b"x" * 1024)
    dest = shots.scratch_data(src, tmp_path / "scratch")
    assert [p.name for p in dest.glob("*")] == ["todos.json"]
    assert not (dest / "uploads-archive").exists()


def test_free_port_returns_a_usable_port():
    assert 1024 < shots.free_port() < 65536


def test_shot_script_is_cjs_not_esm():
    """frontend/package.json is "type": "module", so a .js file is parsed as
    ESM and the script's `require` would be undefined. This cost a debugging
    round; the extension is load-bearing."""
    import inspect
    src = inspect.getsource(shots.shoot)
    assert ".nightcrew-shot.cjs" in src


def test_shot_script_does_not_wait_for_network_idle():
    """The app polls forever (roster every 5.5s), so networkidle never fires and
    every screenshot times out. Cost a debugging round; pinned here."""
    # Checks the waitUntil VALUE, not the word anywhere — the comment above
    # that line names networkidle in order to warn against it.
    assert "waitUntil: 'networkidle'" not in shots._SHOT_JS
    assert "waitUntil: 'domcontentloaded'" in shots._SHOT_JS
