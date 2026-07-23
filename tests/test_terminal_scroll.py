"""The wheel-scroll "jump to end" contract (routes/terminal.py:_scroll_wheel).

A full-screen TUI (Claude, less) owns its own scrollback, so "jump to end"
can't be a single fixed burst of wheel events — a deep scrollback undershoots
and the button "just jumps down bit by bit" (dev note f5c7f249). The fix
feeds bursts and watches capture-pane: stop when a burst no longer changes
what's painted (we hit the edge), capped so a self-repainting pane (Claude
mid-generation) can't loop forever.
"""
from unittest import mock

from routes import terminal


class FakeTmux:
    """Stands in for terminal._tmux: records commands, scripts capture-pane
    output so the pane 'moves' for a set number of bursts, then stabilizes."""

    def __init__(self, moves_for_bursts):
        self.moves_for_bursts = moves_for_bursts
        self.sends = 0
        self.captures = 0

    def __call__(self, cmd):
        result = mock.Mock()
        if cmd.startswith("send-keys"):
            self.sends += 1
            result.stdout = ""
        elif cmd.startswith("capture-pane"):
            self.captures += 1
            # A distinct frame per capture while still scrolling, then the
            # same frame forever once the edge is reached.
            frame = min(self.captures, self.moves_for_bursts)
            result.stdout = f"pane frame {frame}"
        else:
            result.stdout = ""
        return result


def _run_end_scroll(moves_for_bursts):
    fake = FakeTmux(moves_for_bursts)
    with mock.patch.object(terminal, "_tmux", fake), \
         mock.patch.object(terminal.time, "sleep"):
        terminal._scroll_wheel("chat", "down", "end", {})
    return fake


def test_end_scroll_keeps_bursting_until_pane_stops_moving():
    # Pane keeps changing for 5 bursts -> needs 6 sends (the 6th proves the
    # pane stopped), not a single fixed burst.
    fake = _run_end_scroll(moves_for_bursts=5)
    assert fake.sends == 6


def test_end_scroll_stops_immediately_when_already_at_end():
    # Already at the edge: first burst changes nothing beyond the first
    # capture, so it takes exactly 2 sends (one real, one confirming).
    fake = _run_end_scroll(moves_for_bursts=1)
    assert fake.sends == 2


def test_end_scroll_is_capped_when_pane_never_settles():
    # A pane that repaints forever (Claude mid-generation) must not loop
    # unboundedly — the burst cap is the ceiling.
    fake = _run_end_scroll(moves_for_bursts=10_000)
    assert fake.sends == terminal._WHEEL_END_MAX_BURSTS


def test_lines_scroll_is_a_single_send():
    # The swipe path is untouched by the end-jump loop: one send, no capture.
    fake = FakeTmux(moves_for_bursts=0)
    with mock.patch.object(terminal, "_tmux", fake):
        terminal._scroll_wheel("chat", "up", "lines", {"lines": 10})
    assert fake.sends == 1
    assert fake.captures == 0
