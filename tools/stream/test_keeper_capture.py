#!/usr/bin/env python3
"""
test_keeper_capture.py — unit tests for the hook's UI-capture dedup, and for the
dual arming modes (keeper / thread) added 2026-07-20.

The web app mints Chat-tab sends as B cards at the server and records each one's
hash in ui_captured.jsonl; the hook must consume a matching entry instead of
double-minting, but keep minting for anything the server never saw (direct
terminal typing). Tests patch keeper_capture._ui_captured_path() to point at a
tempdir file — the pure dedup function never touches the pool, so nothing else
needs isolating.

The arming-mode tests below mirror test_reconcile_transcripts.py's isolation
pattern (TULKU_STREAM_ROOT pointed at a fresh tempdir vault) since minting and
Threads/<slug>.md existence both go through stream.py's lazily-resolved root.
"""
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import keeper_capture  # noqa: E402
import stream          # noqa: E402

KEEPER_SENTINEL_LINE = (
    "<!-- KEEPER_SESSION_ACTIVE — sentinel for the capture hook. Do not remove. -->"
)


def _thread_sentinel_line(slug):
    return f"<!-- THREAD_SESSION_ACTIVE: {slug} — sentinel for the capture hook. Do not remove. -->"


def _user_entry(text, extra=None):
    entry = {"type": "user", "message": {"content": text}}
    if extra:
        entry.update(extra)
    return entry


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


class OffRecordSuppressedTestCase(unittest.TestCase):
    """The off-the-record gate. Same {ts, sha256} lines as ui_captured, opposite
    meaning and — critically — no consumption: the reconciler reads this file
    too, and whichever door ran first would otherwise eat the other's answer."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = keeper_capture._off_record_path
        self._path = Path(self._tmp.name) / "off_record.jsonl"
        keeper_capture._off_record_path = lambda: self._path

    def tearDown(self):
        keeper_capture._off_record_path = self._prev
        self._tmp.cleanup()

    def _write(self, *lines):
        self._path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_matching_entry_suppresses_the_mint(self):
        self._write(_entry("a private line"))
        self.assertTrue(keeper_capture._off_record_suppressed("a private line"))

    def test_entry_is_not_consumed(self):
        self._write(_entry("a private line"))
        self.assertTrue(keeper_capture._off_record_suppressed("a private line"))
        # the reconciler asks the same question about the same transcript line
        self.assertTrue(keeper_capture._off_record_suppressed("a private line"))

    def test_unlisted_prompt_still_mints(self):
        self._write(_entry("a private line"))
        self.assertFalse(keeper_capture._off_record_suppressed("an ordinary line"))

    def test_entry_older_than_the_window_stops_suppressing(self):
        self._write(_entry("a private line",
                           ts=time.time() - keeper_capture.OFF_RECORD_WINDOW_SEC - 1))
        self.assertFalse(keeper_capture._off_record_suppressed("a private line"))

    def test_missing_file_fails_open_to_minting(self):
        # The common case is "she has never gone off the record" — that must not
        # read as "suppress everything", which would swallow the whole journal.
        self.assertFalse(keeper_capture._off_record_suppressed("a private line"))

    def test_garbage_lines_are_skipped_not_fatal(self):
        self._write("not json at all", _entry("a private line"))
        self.assertTrue(keeper_capture._off_record_suppressed("a private line"))


class EntryModeTestCase(unittest.TestCase):
    """_entry_mode: the shared per-entry fence + sentinel parse, reused verbatim
    by reconcile_transcripts.py."""

    def test_keeper_sentinel_arms_keeper(self):
        entry = _user_entry("hi\n\n" + KEEPER_SENTINEL_LINE)
        self.assertEqual(keeper_capture._entry_mode(entry), ("keeper", None))

    def test_thread_sentinel_arms_thread_with_slug(self):
        entry = _user_entry("hi\n\n" + _thread_sentinel_line("long-covid"))
        self.assertEqual(keeper_capture._entry_mode(entry), ("thread", "long-covid"))

    def test_slug_is_lowercased_and_stripped(self):
        entry = _user_entry("<!-- THREAD_SESSION_ACTIVE: Long-Covid -->")
        self.assertEqual(keeper_capture._entry_mode(entry), ("thread", "long-covid"))

    def test_invalid_slug_does_not_arm(self):
        entry = _user_entry("<!-- THREAD_SESSION_ACTIVE: not_valid! -->")
        self.assertIsNone(keeper_capture._entry_mode(entry))

    def test_both_sentinels_present_keeper_wins(self):
        text = KEEPER_SENTINEL_LINE + "\n" + _thread_sentinel_line("long-covid")
        self.assertEqual(keeper_capture._entry_mode(_user_entry(text)), ("keeper", None))

    def test_tool_result_does_not_arm(self):
        entry = {"type": "user", "message": {"content": [
            {"type": "tool_result", "content": _thread_sentinel_line("long-covid")},
        ]}}
        self.assertIsNone(keeper_capture._entry_mode(entry))

    def test_synthetic_prefixed_block_does_not_arm(self):
        entry = _user_entry("<task-notification>" + _thread_sentinel_line("long-covid"))
        self.assertIsNone(keeper_capture._entry_mode(entry))

    def test_assistant_type_does_not_arm(self):
        entry = {"type": "assistant", "message": {"content": _thread_sentinel_line("long-covid")}}
        self.assertIsNone(keeper_capture._entry_mode(entry))

    def test_no_sentinel_returns_none(self):
        self.assertIsNone(keeper_capture._entry_mode(_user_entry("just chatting")))


class ScanTranscriptModeTestCase(unittest.TestCase):
    """_scan_transcript_mode: one pass over a whole transcript file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, entries):
        path = Path(self._tmp.name) / "t.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return str(path)

    def test_thread_sentinel_arms_thread(self):
        path = self._write([_user_entry(_thread_sentinel_line("dating-and-romance"))])
        self.assertEqual(keeper_capture._scan_transcript_mode(path),
                          ("thread", "dating-and-romance"))

    def test_keeper_appearing_after_thread_upgrades_to_keeper(self):
        path = self._write([
            _user_entry(_thread_sentinel_line("dating-and-romance")),
            _user_entry("some chatter"),
            _user_entry(KEEPER_SENTINEL_LINE),
        ])
        self.assertEqual(keeper_capture._scan_transcript_mode(path), ("keeper", None))

    def test_first_valid_thread_slug_sticks(self):
        path = self._write([
            _user_entry(_thread_sentinel_line("dating-and-romance")),
            _user_entry(_thread_sentinel_line("catastrophe-engine")),
        ])
        self.assertEqual(keeper_capture._scan_transcript_mode(path),
                          ("thread", "dating-and-romance"))

    def test_no_sentinel_anywhere_returns_none(self):
        path = self._write([_user_entry("just chatting"), _user_entry("more chatting")])
        self.assertIsNone(keeper_capture._scan_transcript_mode(path))

    def test_missing_path_returns_none(self):
        self.assertIsNone(keeper_capture._scan_transcript_mode(""))


class SessionModeLatchTestCase(unittest.TestCase):
    """_session_mode: the one-way per-session latch, and its `.on` marker
    encoding (empty/`keeper` = keeper, `thread:<slug>` = thread)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_sessions_dir = keeper_capture._sessions_dir
        self._dir = Path(self._tmp.name) / "sessions"
        keeper_capture._sessions_dir = lambda: self._dir

    def tearDown(self):
        keeper_capture._sessions_dir = self._prev_sessions_dir
        self._tmp.cleanup()

    def _transcript(self, entries):
        path = Path(self._tmp.name) / "t.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return str(path)

    def test_unarmed_session_is_not_cached(self):
        path = self._transcript([_user_entry("no sentinel yet")])
        self.assertIsNone(keeper_capture._session_mode("sid1", path))
        self.assertFalse((self._dir / "sid1.on").exists())

    def test_thread_arm_latches_marker_and_persists_across_calls(self):
        path = self._transcript([_user_entry(_thread_sentinel_line("long-covid"))])
        mode = keeper_capture._session_mode("sid2", path)
        self.assertEqual(mode, ("thread", "long-covid"))
        marker = self._dir / "sid2.on"
        self.assertEqual(marker.read_text(encoding="utf-8"), "thread:long-covid")
        # latched: an empty transcript on a later call still returns the cached mode
        empty_path = self._transcript([])
        self.assertEqual(keeper_capture._session_mode("sid2", empty_path),
                          ("thread", "long-covid"))

    def test_keeper_arm_latches_keeper_marker(self):
        path = self._transcript([_user_entry(KEEPER_SENTINEL_LINE)])
        mode = keeper_capture._session_mode("sid3", path)
        self.assertEqual(mode, ("keeper", None))
        self.assertEqual((self._dir / "sid3.on").read_text(encoding="utf-8"), "keeper")

    def test_legacy_empty_marker_is_keeper(self):
        self._dir.mkdir(parents=True)
        (self._dir / "sid4.on").write_text("", encoding="utf-8")
        self.assertEqual(keeper_capture._session_mode("sid4", ""), ("keeper", None))

    def test_legacy_state_compat_pre_thread_marker_shape(self):
        # Every marker written before thread mode existed is an empty file —
        # exactly what the legacy test above covers. This test just documents
        # the equivalence explicitly for the spec's "legacy state compat" ask.
        self._dir.mkdir(parents=True)
        (self._dir / "sid5.on").write_text("", encoding="utf-8")
        self.assertEqual(keeper_capture._mode_from_marker(""), ("keeper", None))

    def test_no_session_id_falls_back_to_live_scan_each_call(self):
        path = self._transcript([_user_entry(_thread_sentinel_line("dating-and-romance"))])
        self.assertEqual(keeper_capture._session_mode("", path),
                          ("thread", "dating-and-romance"))


class ThreadFileExistsTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_root = os.environ.get("TULKU_STREAM_ROOT")
        os.environ["TULKU_STREAM_ROOT"] = self._tmp.name

    def tearDown(self):
        if self._prev_root is None:
            os.environ.pop("TULKU_STREAM_ROOT", None)
        else:
            os.environ["TULKU_STREAM_ROOT"] = self._prev_root
        self._tmp.cleanup()

    def test_true_when_thread_file_present(self):
        threads = Path(self._tmp.name) / "Threads"
        threads.mkdir()
        (threads / "long-covid.md").write_text("stub", encoding="utf-8")
        self.assertTrue(keeper_capture._thread_file_exists("long-covid"))

    def test_false_when_missing(self):
        self.assertFalse(keeper_capture._thread_file_exists("no-such-thread"))


class MainMintTestCase(unittest.TestCase):
    """End-to-end: main() reading hook stdin JSON and minting through stream.py,
    for both arming modes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_root = os.environ.get("TULKU_STREAM_ROOT")
        os.environ["TULKU_STREAM_ROOT"] = self._tmp.name
        self._prev_stdin = sys.stdin

    def tearDown(self):
        sys.stdin = self._prev_stdin
        if self._prev_root is None:
            os.environ.pop("TULKU_STREAM_ROOT", None)
        else:
            os.environ["TULKU_STREAM_ROOT"] = self._prev_root
        self._tmp.cleanup()

    def _write_transcript(self, entries):
        path = Path(self._tmp.name) / "t.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return str(path)

    def _run_hook(self, payload):
        sys.stdin = io.StringIO(json.dumps(payload))
        return keeper_capture.main()

    def test_thread_session_mints_tagged_card_when_thread_file_exists(self):
        threads = Path(self._tmp.name) / "Threads"
        threads.mkdir()
        (threads / "long-covid.md").write_text("stub", encoding="utf-8")
        path = self._write_transcript([_user_entry(_thread_sentinel_line("long-covid"))])

        rc = self._run_hook({"prompt": "how's my chest today", "session_id": "sidT",
                              "transcript_path": path})
        self.assertEqual(rc, 0)
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].body, "how's my chest today")
        self.assertEqual(cards[0].who, "B")
        self.assertEqual(cards[0].tags, ["long-covid"])

    def test_thread_session_mints_untagged_when_thread_file_missing(self):
        path = self._write_transcript([_user_entry(_thread_sentinel_line("no-such-thread"))])

        self._run_hook({"prompt": "typed into a bad alias", "session_id": "sidU",
                         "transcript_path": path})
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)          # capture is never lost to a bad tag
        self.assertEqual(cards[0].tags, [])

    def test_keeper_session_mints_untagged_as_before(self):
        path = self._write_transcript([_user_entry(KEEPER_SENTINEL_LINE)])

        self._run_hook({"prompt": "hey keeper", "session_id": "sidK", "transcript_path": path})
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, [])

    def test_unarmed_session_mints_nothing(self):
        path = self._write_transcript([_user_entry("just chatting, no sentinel")])

        self._run_hook({"prompt": "dev stuff", "session_id": "sidD", "transcript_path": path})
        self.assertEqual(stream.load_all_cards(), [])


if __name__ == "__main__":
    unittest.main()
