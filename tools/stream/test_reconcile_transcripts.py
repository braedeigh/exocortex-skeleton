#!/usr/bin/env python3
"""
test_reconcile_transcripts.py — unit tests for the transcript-reconciler.

Mirrors test_stream.py's isolation pattern: every test points TULKU_STREAM_ROOT at a
fresh tempdir vault and TULKU_RECONCILER_PROJECT_DIRS at a fresh tempdir standing in
for ~/.claude/projects/<munged-cwd>. reconcile_transcripts resolves both lazily (like
stream.stream_root()), so setting the env vars in setUp is enough. _state_path(),
_lock_path(), and _failure_log_path() are lazy accessors (not plain module-level
paths) and are patched directly, same pattern as keeper_capture._ui_captured_path()
in test_keeper_capture.py.
"""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import keeper_capture         # noqa: E402 — owns the shared off-record gate
import reconcile_transcripts  # noqa: E402
import stream                 # noqa: E402

SENTINEL_LINE = ("<!-- KEEPER_SESSION_ACTIVE — sentinel for the capture hook. "
                  "Do not remove. -->")


def _thread_sentinel_line(slug):
    return (f"<!-- THREAD_SESSION_ACTIVE: {slug} — sentinel for the capture hook. "
            "Do not remove. -->")


def _user(text, ts, session="s1", extra=None):
    entry = {
        "type": "user",
        "isSidechain": False,
        "message": {"content": text},
        "timestamp": ts,
        "sessionId": session,
    }
    if extra:
        entry.update(extra)
    return entry


def _sentinel_entry(ts, session="s1"):
    # Real /journalstart expansions land in the transcript with isMeta: True (verified
    # against a live transcript) — the command body is harness-injected, not typed by
    # her, so it must arm the session without itself being a candidate prompt.
    return _user(
        "You are now the Keeper.\n\n" + SENTINEL_LINE + "\n\nRun the sequence.",
        ts, session, extra={"isMeta": True},
    )


def _thread_sentinel_entry(slug, ts, session="s1"):
    # Mirrors _sentinel_entry's isMeta shape — the /thread expansion is
    # harness-injected the same way /journalstart's is.
    return _user(
        "The owner tapped Talk about this thread.\n\n" + _thread_sentinel_line(slug)
        + "\n\nDo this now.",
        ts, session, extra={"isMeta": True},
    )


def _tool_result_with_sentinel(ts, session="s1"):
    return {
        "type": "user",
        "isSidechain": False,
        "message": {"content": [{"type": "tool_result", "content": SENTINEL_LINE}]},
        "timestamp": ts,
        "sessionId": session,
    }


class ReconcilerTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.vault = root / "vault"
        self.projects = root / "projects"
        self.state_dir = root / "keeper_state"
        self.vault.mkdir()
        self.projects.mkdir()
        self.state_dir.mkdir()

        self._prev_stream_root = os.environ.get("TULKU_STREAM_ROOT")
        self._prev_proj_dirs = os.environ.get("TULKU_RECONCILER_PROJECT_DIRS")
        os.environ["TULKU_STREAM_ROOT"] = str(self.vault)
        os.environ["TULKU_RECONCILER_PROJECT_DIRS"] = str(self.projects)

        self._prev_state_path = reconcile_transcripts._state_path
        self._prev_lock_path = reconcile_transcripts._lock_path
        self._prev_failure_log = reconcile_transcripts._failure_log_path
        self._state_path_val = self.state_dir / "reconciler_state.json"
        self._lock_path_val = self.state_dir / "reconciler.lock"
        self._failure_log_val = self.state_dir / "capture-failures.jsonl"
        reconcile_transcripts._state_path = lambda: self._state_path_val
        reconcile_transcripts._lock_path = lambda: self._lock_path_val
        reconcile_transcripts._failure_log_path = lambda: self._failure_log_val

    def tearDown(self):
        reconcile_transcripts._state_path = self._prev_state_path
        reconcile_transcripts._lock_path = self._prev_lock_path
        reconcile_transcripts._failure_log_path = self._prev_failure_log
        if self._prev_stream_root is None:
            os.environ.pop("TULKU_STREAM_ROOT", None)
        else:
            os.environ["TULKU_STREAM_ROOT"] = self._prev_stream_root
        if self._prev_proj_dirs is None:
            os.environ.pop("TULKU_RECONCILER_PROJECT_DIRS", None)
        else:
            os.environ["TULKU_RECONCILER_PROJECT_DIRS"] = self._prev_proj_dirs
        self._tmp.cleanup()

    def _write_transcript(self, name, lines):
        path = self.projects / name
        with path.open("w", encoding="utf-8") as f:
            for obj in lines:
                f.write(json.dumps(obj) + "\n")
        return path

    def _append(self, path, *objs):
        with path.open("a", encoding="utf-8") as f:
            for obj in objs:
                f.write(json.dumps(obj) + "\n")

    def _state(self):
        return json.loads(self._state_path_val.read_text(encoding="utf-8"))

    def _make_thread_file(self, slug):
        d = self.vault / "Threads"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{slug}.md").write_text("stub", encoding="utf-8")


class BootstrapTests(ReconcilerTestCase):
    def test_bootstrap_arms_and_mints_nothing_then_next_prompt_mints(self):
        path = self._write_transcript("s1.jsonl", [
            _sentinel_entry("2026-07-14T13:00:00.000Z"),
            _user("hey keeper, today was rough", "2026-07-14T13:05:00.000Z"),
        ])

        rc = reconcile_transcripts.main()
        self.assertEqual(rc, 0)
        self.assertEqual(stream.load_all_cards(), [])   # bootstrap mints nothing

        state = self._state()
        self.assertTrue(state[str(path)]["armed"])
        self.assertEqual(state[str(path)]["offset"], path.stat().st_size)

        self._append(path, _user("new message after bootstrap", "2026-07-14T14:10:15.500Z"))
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].body, "new message after bootstrap")
        self.assertEqual(cards[0].who, "B")

        expected_local = datetime.fromisoformat("2026-07-14T14:10:15.500+00:00").astimezone()
        self.assertEqual(cards[0].ts, expected_local.strftime("%Y-%m-%d %H:%M:%S"))

    def test_bootstrap_writes_state_for_empty_project_dirs(self):
        rc = reconcile_transcripts.main()
        self.assertEqual(rc, 0)
        self.assertEqual(self._state(), {})
        self.assertEqual(stream.load_all_cards(), [])


class ArmingTests(ReconcilerTestCase):
    def test_transcript_without_sentinel_never_mints(self):
        path = self._write_transcript("s2.jsonl", [
            _user("just chatting", "2026-07-14T10:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap
        self._append(path, _user("more chat, still no sentinel", "2026-07-14T10:05:00.000Z"))
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])

    def test_sentinel_in_tool_result_does_not_arm(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        path = self._write_transcript("s3.jsonl", [
            _tool_result_with_sentinel("2026-07-14T09:00:00.000Z"),
            _user("hello", "2026-07-14T09:05:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])
        self.assertFalse(self._state()[str(path)]["armed"])

    def test_new_transcript_prompts_before_sentinel_skipped_after_minted(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_transcript("s4.jsonl", [
            _user("before arming, should not mint", "2026-07-14T08:00:00.000Z"),
            _sentinel_entry("2026-07-14T08:05:00.000Z"),
            _user("after arming, should mint", "2026-07-14T08:10:00.000Z"),
        ])
        reconcile_transcripts.main()
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].body, "after arming, should mint")


class DedupTests(ReconcilerTestCase):
    def test_body_dedup_against_existing_card_and_across_runs(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        stream.record(who="B", body="already said this", ts=datetime(2026, 7, 14, 9, 0, 0))

        self._write_transcript("s5.jsonl", [
            _sentinel_entry("2026-07-14T08:55:00.000Z"),
            _user("already said this", "2026-07-14T09:00:05.000Z"),
            _user("brand new message", "2026-07-14T09:01:00.000Z"),
        ])
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        bodies = [c.body for c in cards]
        self.assertIn("brand new message", bodies)
        self.assertEqual(bodies.count("already said this"), 1)   # not duplicated
        self.assertEqual(len(cards), 2)

        # second run over the same (now fully consumed) transcript mints nothing more
        reconcile_transcripts.main()
        self.assertEqual(len(stream.load_all_cards()), 2)


class OffRecordTests(ReconcilerTestCase):
    """A turn she sent off the record is in the transcript and missing from the
    pool — exactly the shape of a turn the server lost, which is what this whole
    module exists to repair. The server's off_record.jsonl breadcrumb is the only
    thing that tells the two apart."""

    def _write_off_record(self, *prompts):
        path = self.vault / ".keeper" / "off_record.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(
            json.dumps({"ts": time.time(),
                        "sha256": hashlib.sha256(p.encode("utf-8")).hexdigest()}) + "\n"
            for p in prompts
        ), encoding="utf-8")

    def test_off_record_prompt_is_never_restored(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_off_record("a private line")
        self._write_transcript("s9.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("a private line", "2026-07-14T07:01:00.000Z"),
            _user("an ordinary line", "2026-07-14T07:02:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual([c.body for c in stream.load_all_cards()], ["an ordinary line"])

    def test_a_stale_breadcrumb_stops_suppressing(self):
        reconcile_transcripts.main()
        path = self.vault / ".keeper" / "off_record.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "ts": time.time() - keeper_capture.OFF_RECORD_WINDOW_SEC - 1,
            "sha256": hashlib.sha256(b"a private line").hexdigest(),
        }) + "\n", encoding="utf-8")
        self._write_transcript("s10.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("a private line", "2026-07-14T07:01:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual([c.body for c in stream.load_all_cards()], ["a private line"])


class SkipRuleTests(ReconcilerTestCase):
    def test_skip_rules_never_mint(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_transcript("s6.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("/endsession", "2026-07-14T07:01:00.000Z"),
            _user("[Request interrupted by user]", "2026-07-14T07:02:00.000Z"),
            _user("<system-reminder>some harness note</system-reminder>", "2026-07-14T07:03:00.000Z"),
            _user("[uploaded: /home/owner/paste/20260714_075555_paste.txt]", "2026-07-14T07:04:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])

    def test_captioned_and_photo_uploads_are_skipped(self):
        """The two shapes that leaked and minted a duplicate card per upload for three
        weeks: an upload marker with her caption after it (a fullmatch never fired), and
        a photo (the rule only recognized _paste.txt). The server already minted both
        under the accumulated body, so dedup-by-body can't catch them."""
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_transcript("s11.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("[uploaded: /home/owner/paste/20260714_075555_paste.txt]\nwhat do we think",
                  "2026-07-14T07:01:00.000Z"),
            _user("[uploaded: /home/owner/uploads/20260714_075600_IMG_2933.png]",
                  "2026-07-14T07:02:00.000Z"),
            _user("[uploaded: /home/owner/uploads/20260714_075700_IMG_2934.png]\nthis one too",
                  "2026-07-14T07:03:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])

    def test_upload_marker_mid_sentence_still_mints(self):
        """Prefix-anchored, not a substring search — her talking *about* an upload is an
        ordinary turn and must still be repaired if the server missed it."""
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_transcript("s12.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("why does it say [uploaded: foo.png] instead of my text",
                  "2026-07-14T07:01:00.000Z"),
        ])
        reconcile_transcripts.main()
        self.assertEqual(
            [c.body for c in stream.load_all_cards()],
            ["why does it say [uploaded: foo.png] instead of my text"],
        )

    def test_isMeta_and_isSidechain_are_not_candidates(self):
        reconcile_transcripts.main()   # bootstrap on empty project dirs
        self._write_transcript("s8.jsonl", [
            _sentinel_entry("2026-07-14T07:00:00.000Z"),
            _user("harness caveat", "2026-07-14T07:01:00.000Z", extra={"isMeta": True}),
            _user("sub-agent turn", "2026-07-14T07:02:00.000Z", extra={"isSidechain": True}),
        ])
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])


class PartialLineTests(ReconcilerTestCase):
    def test_partial_trailing_line_not_consumed_until_complete(self):
        path = self._write_transcript("s7.jsonl", [_sentinel_entry("2026-07-14T06:00:00.000Z")])
        reconcile_transcripts.main()   # bootstrap arms, offset = end of sentinel line

        full_line = json.dumps(_user("this will be split", "2026-07-14T06:05:00.000Z"))
        half = len(full_line) // 2
        with path.open("a", encoding="utf-8") as f:
            f.write(full_line[:half])   # no trailing newline -> partial line

        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])
        state = self._state()
        offset_before = state[str(path)]["offset"]
        with path.open("rb") as f:
            f.seek(offset_before)
            remainder = f.read()
        self.assertEqual(remainder.decode("utf-8"), full_line[:half])

        with path.open("a", encoding="utf-8") as f:
            f.write(full_line[half:] + "\n")
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].body, "this will be split")


class ThreadArmingTests(ReconcilerTestCase):
    def test_thread_sentinel_arms_and_mints_tagged_card(self):
        self._make_thread_file("long-covid")
        path = self._write_transcript("t1.jsonl", [
            _thread_sentinel_entry("long-covid", "2026-07-14T12:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap: arms, mints nothing
        self.assertEqual(stream.load_all_cards(), [])
        self.assertEqual(self._state()[str(path)].get("thread"), "long-covid")

        self._append(path, _user("how's my chest today", "2026-07-14T12:05:00.000Z"))
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].body, "how's my chest today")
        self.assertEqual(cards[0].who, "B")
        self.assertEqual(cards[0].tags, ["long-covid"])

    def test_invalid_slug_never_arms_thread_mode(self):
        path = self._write_transcript("t2.jsonl", [
            _thread_sentinel_entry("not_valid!", "2026-07-14T11:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap
        self._append(path, _user("should not mint", "2026-07-14T11:05:00.000Z"))
        reconcile_transcripts.main()
        self.assertEqual(stream.load_all_cards(), [])
        self.assertFalse(self._state()[str(path)]["armed"])

    def test_keeper_wins_when_both_sentinels_present(self):
        path = self._write_transcript("t3.jsonl", [
            _thread_sentinel_entry("long-covid", "2026-07-14T10:00:00.000Z"),
            _sentinel_entry("2026-07-14T10:01:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap scans the whole file at once
        state_entry = self._state()[str(path)]
        self.assertTrue(state_entry["armed"])
        self.assertNotIn("thread", state_entry)   # keeper, not thread

        self._append(path, _user("hey keeper", "2026-07-14T10:05:00.000Z"))
        reconcile_transcripts.main()
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, [])   # keeper mode never tags


class ThreadMintingTests(ReconcilerTestCase):
    def test_thread_mints_untagged_when_threads_file_missing(self):
        # No Threads/no-such-thread.md created — capture must never be lost to
        # an alias that doesn't resolve.
        path = self._write_transcript("t4.jsonl", [
            _thread_sentinel_entry("no-such-thread", "2026-07-14T09:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap
        self._append(path, _user("typed anyway", "2026-07-14T09:05:00.000Z"))
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, [])

    def test_thread_file_appearing_after_arming_still_tags_lazily(self):
        # The Threads/ file doesn't exist yet when the session arms — the check
        # happens per mint, not once at arm time.
        path = self._write_transcript("t5.jsonl", [
            _thread_sentinel_entry("late-arriving", "2026-07-14T08:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap: arms thread mode
        self._make_thread_file("late-arriving")   # now it exists
        self._append(path, _user("mint me tagged", "2026-07-14T08:05:00.000Z"))
        reconcile_transcripts.main()

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, ["late-arriving"])


class ThreadToKeeperUpgradeTests(ReconcilerTestCase):
    def test_thread_upgrades_to_keeper_across_separate_runs(self):
        self._make_thread_file("long-covid")
        path = self._write_transcript("t6.jsonl", [
            _thread_sentinel_entry("long-covid", "2026-07-14T07:00:00.000Z"),
        ])
        reconcile_transcripts.main()   # bootstrap: arms thread mode
        self.assertEqual(self._state()[str(path)].get("thread"), "long-covid")

        self._append(path, _user("first thread turn", "2026-07-14T07:05:00.000Z"))
        reconcile_transcripts.main()
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, ["long-covid"])

        # She runs /journalstart inside the same session later on — keeper wins
        # and the state upgrades, in a THIRD, later run of the reconciler.
        self._append(path, _sentinel_entry("2026-07-14T07:10:00.000Z"))
        self._append(path, _user("now talking to the keeper", "2026-07-14T07:15:00.000Z"))
        reconcile_transcripts.main()

        state_entry = self._state()[str(path)]
        self.assertTrue(state_entry["armed"])
        self.assertNotIn("thread", state_entry)   # upgraded, terminal

        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 2)
        upgraded = next(c for c in cards if c.body == "now talking to the keeper")
        self.assertEqual(upgraded.tags, [])   # keeper mode, never tagged


class LegacyStateCompatTests(ReconcilerTestCase):
    def test_pre_thread_state_entry_behaves_as_keeper(self):
        path = self._write_transcript("t7.jsonl", [
            _user("keeper turn under legacy state", "2026-07-14T06:05:00.000Z"),
        ])
        # Simulate a state file written before thread mode existed: {"armed": true},
        # no "thread" key at all.
        self._save_legacy_state({str(path): {"offset": 0, "armed": True}})

        reconcile_transcripts.main()
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, [])

    def _save_legacy_state(self, state):
        self._state_path_val.parent.mkdir(parents=True, exist_ok=True)
        self._state_path_val.write_text(json.dumps(state), encoding="utf-8")


class BootstrapThreadTests(ReconcilerTestCase):
    def test_bootstrap_detects_thread_mode_for_existing_transcript(self):
        self._make_thread_file("dating-and-romance")
        path = self._write_transcript("t8.jsonl", [
            _thread_sentinel_entry("dating-and-romance", "2026-07-14T05:00:00.000Z"),
            _user("predates the reconciler", "2026-07-14T05:05:00.000Z"),
        ])
        reconcile_transcripts.main()   # first-ever run: bootstrap, mints nothing

        self.assertEqual(stream.load_all_cards(), [])
        state_entry = self._state()[str(path)]
        self.assertTrue(state_entry["armed"])
        self.assertEqual(state_entry["thread"], "dating-and-romance")
        self.assertEqual(state_entry["offset"], path.stat().st_size)

        self._append(path, _user("after bootstrap", "2026-07-14T05:10:00.000Z"))
        reconcile_transcripts.main()
        cards = stream.load_all_cards()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].tags, ["dating-and-romance"])


if __name__ == "__main__":
    unittest.main()
