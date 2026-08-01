"""Route tests for the PWA-driven Claude Code re-login (routes/claude_auth.py).

Everything here fakes the tmux layer: `_tmux` is the single choke point every
pane read and keypress goes through, so a stub that records its argv and
replays canned `capture-pane` output exercises the whole flow without a
terminal, a real `claude`, or the box's actual credentials.

The load-bearing test is `test_start_spawns_a_pane_wide_enough_for_the_url`.
The OAuth URL is ~450 characters; in a normal-width pane it wraps and the
scrape returns a truncated URL that fails authorization later with an
unhelpful error. Pane width is the only thing preventing that, so it's pinned
here against a real captured URL rather than left to a comment.
"""
import json

import pytest
from flask import Flask

from routes import claude_auth


# A real URL from the live CLI (v2.1.220), with the opaque values scrubbed.
# Length is what matters — it's what makes the pane width load-bearing.
LIVE_URL = (
    "https://claude.com/cai/oauth/authorize?code=true"
    "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code"
    "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
    "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference"
    "+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload"
    "&code_challenge=" + "c" * 43 + "&code_challenge_method=S256"
    "&state=" + "s" * 43
)

PANE_MENU = " Select login method:\n ❯ 1. Claude account with subscription\n"
PANE_READY = (
    " Browser didn't open? Use the url below to sign in (c to copy)\n"
    f"{LIVE_URL}\n"
    " Paste code here if prompted >\n"
)


class FakeTmux:
    """Stands in for `claude_auth._tmux`. `pane` is what capture-pane returns;
    `alive` is what has-session reports. Every call is recorded so tests can
    assert on the argv that reached tmux."""

    def __init__(self, pane="", alive=True):
        self.pane = pane
        self.alive = alive
        self.calls = []

    def __call__(self, *args, timeout=10):
        self.calls.append(args)
        if args[0] == "has-session":
            return _Proc(0 if self.alive else 1)
        if args[0] == "capture-pane":
            return _Proc(0, self.pane)
        if args[0] == "kill-session":
            self.alive = False
        return _Proc(0)

    def sent_text(self):
        """Every literal string typed into the pane (`send-keys -l <text>`)."""
        return [a[-1] for a in self.calls
                if a[0] == "send-keys" and "-l" in a]


class _Proc:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def client(monkeypatch):
    # No driver thread in tests: /start would otherwise spawn one that polls a
    # stubbed pane forever and outlives the test.
    monkeypatch.setattr(claude_auth.threading, "Thread",
                        lambda *a, **k: type("T", (), {"start": lambda self: None})())
    app = Flask(__name__)
    claude_auth.register(app)
    return app.test_client()


def _fake_tmux(monkeypatch, **kwargs):
    fake = FakeTmux(**kwargs)
    monkeypatch.setattr(claude_auth, "_tmux", fake)
    return fake


def _fake_expiry(monkeypatch, value):
    monkeypatch.setattr(claude_auth, "_refresh_expiry", lambda: value)


# --- status ---------------------------------------------------------------

def test_status_is_idle_with_no_pane(client, monkeypatch):
    _fake_tmux(monkeypatch, alive=False)
    _fake_expiry(monkeypatch, None)
    body = client.get("/api/claude-auth/status").get_json()
    assert body["state"] == "idle"
    assert body["url"] is None


def test_status_reports_runway_from_the_credentials_file(client, monkeypatch):
    import time
    _fake_tmux(monkeypatch, alive=False)
    _fake_expiry(monkeypatch, time.time() + 10 * 86400)
    body = client.get("/api/claude-auth/status").get_json()
    assert body["days_left"] == pytest.approx(10.0, abs=0.1)
    assert body["expires_at"] is not None


def test_status_surfaces_the_url_once_the_pane_is_ready(client, monkeypatch):
    _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, None)
    body = client.get("/api/claude-auth/status").get_json()
    assert body["state"] == "awaiting_code"
    assert body["url"] == LIVE_URL


def test_url_scrape_keeps_the_whole_query_string(client, monkeypatch):
    """A URL cut short still *looks* like a URL, so assert the tail survives —
    a truncated one fails only later, at authorization."""
    _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, None)
    url = client.get("/api/claude-auth/status").get_json()["url"]
    assert url.endswith("state=" + "s" * 43)
    assert "code_challenge_method=S256" in url


def test_status_is_starting_while_the_menu_is_up(client, monkeypatch):
    _fake_tmux(monkeypatch, pane=PANE_MENU)
    _fake_expiry(monkeypatch, None)
    assert client.get("/api/claude-auth/status").get_json()["state"] == "starting"


# --- start ----------------------------------------------------------------

def test_start_spawns_a_pane_wide_enough_for_the_url(client, monkeypatch):
    """The regression guard. If the pane is ever narrower than the URL, the
    scrape silently truncates — so pin the width against the real URL length."""
    fake = _fake_tmux(monkeypatch, alive=False)
    _fake_expiry(monkeypatch, None)
    assert client.post("/api/claude-auth/start").status_code == 200
    new_session = next(a for a in fake.calls if a[0] == "new-session")
    width = int(new_session[new_session.index("-x") + 1])
    assert width > len(LIVE_URL)


def test_start_kills_any_previous_attempt(client, monkeypatch):
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, None)
    client.post("/api/claude-auth/start")
    assert fake.calls[0][0] == "kill-session"


# --- code -----------------------------------------------------------------

def test_code_is_refused_when_no_login_is_running(client, monkeypatch):
    _fake_tmux(monkeypatch, alive=False)
    _fake_expiry(monkeypatch, None)
    res = client.post("/api/claude-auth/code", json={"code": "a" * 20})
    assert res.status_code == 409


@pytest.mark.parametrize("bad", ["", "short", "has space", "quote'inject", "semi;colon"])
def test_malformed_codes_never_reach_the_pane(client, monkeypatch, bad):
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, 1.0)
    res = client.post("/api/claude-auth/code", json={"code": bad})
    assert res.status_code == 400
    assert fake.sent_text() == []


def test_code_reaches_tmux_as_one_literal_argument(client, monkeypatch):
    """Shell metacharacters in a code must be typed, not executed — which is
    why _tmux takes a list and never shell=True."""
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    moved = iter([100.0, 200.0])
    monkeypatch.setattr(claude_auth, "_refresh_expiry", lambda: next(moved))
    code = "abc123#" + "d" * 20
    client.post("/api/claude-auth/code", json={"code": code})
    assert fake.sent_text() == [code]


def test_successful_code_is_confirmed_by_the_credentials_file_moving(client, monkeypatch):
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    moved = iter([100.0, 500.0, 500.0])
    monkeypatch.setattr(claude_auth, "_refresh_expiry", lambda: next(moved))
    body = client.post("/api/claude-auth/code", json={"code": "a" * 20}).get_json()
    assert body["state"] == "done"
    # The pane is disposable once the login lands.
    assert any(c[0] == "kill-session" for c in fake.calls)


def test_a_code_that_changes_nothing_fails_and_keeps_the_pane(client, monkeypatch):
    """A mistyped code is the common case — she should be able to retype it
    without walking the whole flow again."""
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, 100.0)
    monkeypatch.setattr(claude_auth, "_WAIT_LOGIN_SEC", 0.2)
    monkeypatch.setattr(claude_auth, "_POLL_SEC", 0.05)
    res = client.post("/api/claude-auth/code", json={"code": "a" * 20})
    assert res.status_code == 400
    assert res.get_json()["state"] == "awaiting_code"
    assert not any(c[0] == "kill-session" for c in fake.calls)


# --- cancel ---------------------------------------------------------------

def test_cancel_drops_the_pane(client, monkeypatch):
    fake = _fake_tmux(monkeypatch, pane=PANE_READY)
    _fake_expiry(monkeypatch, None)
    body = client.post("/api/claude-auth/cancel").get_json()
    assert body["state"] == "idle"
    assert any(c[0] == "kill-session" for c in fake.calls)


# --- credentials parsing --------------------------------------------------

def test_expiry_reads_the_config_dir_override(tmp_path, monkeypatch):
    """CLAUDE_CONFIG_DIR is how this flow gets tested against a throwaway
    login instead of the box's real one — so it has to be honoured."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / ".credentials.json").write_text(json.dumps(
        {"claudeAiOauth": {"refreshTokenExpiresAt": 1787991763624}}))
    assert claude_auth._refresh_expiry() == pytest.approx(1787991763.624)


@pytest.mark.parametrize("payload", ["{}", "not json", '{"claudeAiOauth": {}}'])
def test_unreadable_credentials_degrade_to_none(tmp_path, monkeypatch, payload):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / ".credentials.json").write_text(payload)
    assert claude_auth._refresh_expiry() is None
