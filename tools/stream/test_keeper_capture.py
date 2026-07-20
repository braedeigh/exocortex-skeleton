#!/usr/bin/env python3
"""
test_keeper_capture.py — unit tests for the hook's UI-capture dedup.

The web app mints Chat-tab sends as B cards at the server and records each one's
hash in ui_captured.jsonl; the hook must consume a matching entry instead of
double-minting, but keep minting for anything the server never saw (direct
terminal typing). Tests patch keeper_capture._ui_captured_path() to point at a
tempdir file — the pure dedup function never touches the pool, so nothing else
needs isolating.
"""
import hashlib
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import keeper_capture  # noqa: E402


def _entry(text, ts=None):
    return json.dumps({
        "ts": time.time() if ts is None else ts,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    })


class UiAlreadyCapturedTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = keeper_capture._ui_captured_path
        self._path = Path(self._tmp.name) / "ui_captured.jsonl"
        keeper_capture._ui_captured_path = lambda: self._path

    def tearDown(self):
        keeper_capture._ui_captured_path = self._prev
        self._tmp.cleanup()

    def _write(self, *lines):
        self._path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_matching_recent_entry_is_consumed_once(self):
        self._write(_entry("hello keeper"))
        self.assertTrue(keeper_capture._ui_already_captured("hello keeper"))
        # entry consumed: the same words typed again (directly) must mint
        self.assertFalse(keeper_capture._ui_already_captured("hello keeper"))

    def test_unseen_prompt_mints_and_preserves_other_entries(self):
        self._write(_entry("something else"))
        self.assertFalse(keeper_capture._ui_already_captured("hello keeper"))
        self.assertTrue(keeper_capture._ui_already_captured("something else"))

    def test_stale_entry_does_not_swallow_a_turn(self):
        self._write(_entry("hello keeper", ts=time.time() - 3600))
        self.assertFalse(keeper_capture._ui_already_captured("hello keeper"))

    def test_missing_file_fails_open_to_minting(self):
        self.assertFalse(keeper_capture._ui_already_captured("hello keeper"))

    def test_garbage_lines_are_skipped_not_fatal(self):
        self._write("not json at all", _entry("hello keeper"))
        self.assertTrue(keeper_capture._ui_already_captured("hello keeper"))

    def test_duplicate_sends_each_consume_their_own_entry(self):
        self._write(_entry("yeah"), _entry("yeah"))
        self.assertTrue(keeper_capture._ui_already_captured("yeah"))
        self.assertTrue(keeper_capture._ui_already_captured("yeah"))
        self.assertFalse(keeper_capture._ui_already_captured("yeah"))


if __name__ == "__main__":
    unittest.main()
