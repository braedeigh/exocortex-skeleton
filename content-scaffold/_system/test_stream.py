#!/usr/bin/env python3
"""
test_stream.py — unit tests for stream.py, the deterministic card-pool spine.

Every test points TULKU_STREAM_ROOT at a fresh tempdir (never the live vault) so the
pool/manifest/index/view machinery can be exercised freely and thrown away. stream.py
resolves its root lazily (`stream_root()` reads the env var on every call), so setting
the env var in setUp is enough — no reload needed.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stream  # noqa: E402

STREAM_PY = str(Path(__file__).resolve().parent / "stream.py")


class StreamTestCase(unittest.TestCase):
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

    def _snapshot(self, root: Path) -> dict:
        """Every rendered .md file under Journal/Daily, _system/data/index, and
        people/views, keyed by path relative to root -> raw bytes."""
        data = {}
        bases = [stream.daily_dir(), stream.index_dir(), root / "people" / "views"]
        for base in bases:
            if not base.exists():
                continue
            for p in sorted(base.rglob("*.md")):
                data[str(p.relative_to(root))] = p.read_bytes()
        return data


class RecordRoundTripTests(StreamTestCase):
    def test_record_round_trip_multiline_trailing_spaces(self):
        ts = datetime(2026, 7, 6, 8, 43, 12)
        body = "line one   \nline two with trailing spaces   \nline three"
        cid = stream.record(
            who="B", body=body, ts=ts, tags=["exocortex", "architecture"], kind="line",
        )
        self.assertEqual(cid, "2026-07-06.0843b")

        card = stream.read_card(cid)
        self.assertEqual(card.id, cid)
        self.assertEqual(card.who, "B")
        self.assertEqual(card.ts, "2026-07-06 08:43:12")
        self.assertIsNone(card.reply_to)
        self.assertEqual(card.tags, ["exocortex", "architecture"])
        self.assertEqual(card.kind, "line")
        self.assertEqual(card.body, body)          # byte-exact, trailing spaces intact

    def test_record_empty_stdin_rejected(self):
        with self.assertRaises(stream.StreamError):
            stream.record(who="B", body="   \n   \n")
        self.assertEqual(stream.load_all_cards(), [])

    def test_record_via_cli_empty_stdin_exits_nonzero(self):
        env = dict(os.environ)
        result = subprocess.run(
            [sys.executable, STREAM_PY, "record", "--who", "B"],
            input="   \n", capture_output=True, text=True, env=env,
        )
        self.assertNotEqual(result.returncode, 0)


class IdCollisionTests(StreamTestCase):
    def test_same_minute_same_speaker_gets_counter(self):
        ts = datetime(2026, 7, 6, 8, 43, 0)
        cid1 = stream.record(who="B", body="first", ts=ts)
        cid2 = stream.record(who="B", body="second", ts=ts)
        cid3 = stream.record(who="B", body="third", ts=ts)
        self.assertEqual(cid1, "2026-07-06.0843b")
        self.assertEqual(cid2, "2026-07-06.0843b2")
        self.assertEqual(cid3, "2026-07-06.0843b3")

    def test_different_speaker_same_minute_no_collision(self):
        ts = datetime(2026, 7, 6, 8, 43, 0)
        cid_b = stream.record(who="B", body="from the operator", ts=ts)
        cid_k = stream.record(who="K", body="from keeper", ts=ts)
        self.assertEqual(cid_b, "2026-07-06.0843b")
        self.assertEqual(cid_k, "2026-07-06.0843k")


class DayViewTests(StreamTestCase):
    def test_gaps_speaker_formatting_and_context_placement(self):
        day = "2026-07-06"
        stream.record(
            who="K", body="Context: test day.", ts=datetime(2026, 7, 6, 7, 0, 0), kind="context",
        )
        t0 = datetime(2026, 7, 6, 8, 0, 0)
        stream.record(who="B", body="first message", ts=t0)
        t1 = datetime(2026, 7, 6, 8, 2, 0)     # +2 min: inside the 600s gap window
        stream.record(who="K", body="second message", ts=t1)
        t2 = datetime(2026, 7, 6, 8, 17, 0)    # +15 min from t1: exceeds the gap
        stream.record(who="B", body="third message", ts=t2)

        text = stream.render_day_text(day)
        expected = (
            "# 2026-07-06\n"
            "\n"
            "`B = you | K = keeper`\n"
            "\n"
            "Context: test day.\n"
            "\n"
            "---\n"
            "\n"
            "*[8:00 AM]*\n"
            "\n"
            "B: first message\n"
            "\n"
            "K: *second message*\n"
            "\n"
            "*[8:17 AM]*\n"
            "\n"
            "B: third message\n"
        )
        self.assertEqual(text, expected)

    def test_day_with_no_cards_renders_nothing(self):
        self.assertIsNone(stream.render_day_text("2026-01-01"))
        self.assertIsNone(stream.render_day("2026-01-01"))
        self.assertFalse((stream.daily_dir() / "2026-01-01.md").exists())

    def test_multiline_body_prefix_only_first_line(self):
        stream.record(
            who="B", body="line one\nline two\nline three",
            ts=datetime(2026, 7, 6, 9, 0, 0),
        )
        stream.record(
            who="K", body="k one\nk two", ts=datetime(2026, 7, 6, 9, 1, 0),
        )
        text = stream.render_day_text("2026-07-06")
        self.assertIn("\nB: line one\nline two\nline three\n", text)
        self.assertIn("\nK: *k one\nk two*\n", text)


class ReplyToAndValidateTests(StreamTestCase):
    def test_valid_reply_to_and_unknown_reply_to(self):
        cid_q = stream.record(who="K", body="question?", ts=datetime(2026, 7, 6, 9, 0, 0))
        cid_a = stream.record(
            who="B", body="answer", ts=datetime(2026, 7, 6, 9, 1, 0), reply_to=cid_q,
        )
        self.assertEqual(stream.read_card(cid_a).reply_to, cid_q)

        with self.assertRaises(stream.StreamError):
            stream.record(
                who="B", body="dangling", ts=datetime(2026, 7, 6, 9, 2, 0),
                reply_to="2026-01-01.0000k",
            )

        env = dict(os.environ)
        result = subprocess.run(
            [sys.executable, STREAM_PY, "record", "--who", "B", "--reply-to", "2026-01-01.0000k"],
            input="hi\n", capture_output=True, text=True, env=env,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_validate_detects_hand_broken_reply_to(self):
        cid = stream.record(who="B", body="a", ts=datetime(2026, 7, 6, 10, 0, 0))
        card = stream.read_card(cid)
        card.reply_to = "2026-01-01.0000k"       # hand-break it: nothing resolves to this
        stream.write_card(card)

        ok, messages = stream.validate()
        self.assertFalse(ok)
        self.assertTrue(any("reply_to" in m and cid in m for m in messages), messages)

    def test_validate_detects_cycle(self):
        cid_a = stream.record(who="B", body="a2", ts=datetime(2026, 7, 6, 10, 5, 0))
        cid_b = stream.record(who="B", body="b2", ts=datetime(2026, 7, 6, 10, 6, 0))
        card_a = stream.read_card(cid_a)
        card_b = stream.read_card(cid_b)
        card_a.reply_to = cid_b
        card_b.reply_to = cid_a
        stream.write_card(card_a)
        stream.write_card(card_b)

        ok, messages = stream.validate()
        self.assertFalse(ok)
        self.assertTrue(any(m.startswith("CYCLE") for m in messages), messages)


class TagUntagManifestTests(StreamTestCase):
    def _write_sally_manifest(self):
        d = stream.manifests_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "sally.md").write_text(
            "---\nselect: tag=sally\nrender: inline\nout: people/views/sally.md\n---\n",
            encoding="utf-8",
        )

    def test_tag_then_render_then_untag_then_render(self):
        cid = stream.record(who="B", body="talked to sally today", ts=datetime(2026, 7, 6, 11, 0, 0))
        stream.add_tags(cid, ["sally"])
        self.assertEqual(stream.read_card(cid).tags, ["sally"])

        self._write_sally_manifest()
        stream.render_manifest("sally")
        out_path = stream.stream_root() / "people" / "views" / "sally.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertIn(f"[[{cid}]]", content)
        self.assertIn("talked to sally today", content)

        stream.remove_tags(cid, ["sally"])     # re-renders the manifest itself
        content2 = out_path.read_text(encoding="utf-8")
        self.assertNotIn(f"[[{cid}]]", content2)
        self.assertEqual(stream.read_card(cid).tags, [])

    def test_tag_dedupes_and_preserves_order(self):
        cid = stream.record(who="B", body="x", ts=datetime(2026, 7, 6, 11, 30, 0))
        stream.add_tags(cid, ["a", "b"])
        stream.add_tags(cid, ["b", "c"])
        self.assertEqual(stream.read_card(cid).tags, ["a", "b", "c"])


class EditCardTests(StreamTestCase):
    def test_edit_replaces_body_and_rerenders_day_and_month(self):
        cid = stream.record(who="B", body="original body", ts=datetime(2026, 7, 6, 14, 0, 0))
        card = stream.edit_card(cid, "revised body")
        self.assertEqual(card.body, "revised body")
        self.assertEqual(stream.read_card(cid).body, "revised body")

        day_text = (stream.daily_dir() / "2026-07-06.md").read_text(encoding="utf-8")
        self.assertIn("revised body", day_text)
        self.assertNotIn("original body", day_text)

        index_text = (stream.index_dir() / "2026-07.md").read_text(encoding="utf-8")
        self.assertIn("revised body", index_text)

    def test_edit_preserves_frontmatter(self):
        cid = stream.record(
            who="K", body="q", ts=datetime(2026, 7, 6, 14, 5, 0), tags=["x"], kind="context",
        )
        card = stream.edit_card(cid, "new q")
        self.assertEqual(card.who, "K")
        self.assertEqual(card.tags, ["x"])
        self.assertEqual(card.kind, "context")
        self.assertEqual(card.reply_to, None)

    def test_edit_rerenders_matching_manifest(self):
        d = stream.manifests_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "sally.md").write_text(
            "---\nselect: tag=sally\nrender: inline\nout: people/views/sally.md\n---\n",
            encoding="utf-8",
        )
        cid = stream.record(
            who="B", body="talked to sally", ts=datetime(2026, 7, 6, 14, 10, 0), tags=["sally"],
        )
        stream.render_manifest("sally")
        stream.edit_card(cid, "talked to sally about the weekend")
        out_path = stream.stream_root() / "people" / "views" / "sally.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertIn("talked to sally about the weekend", content)

    def test_edit_rejects_empty_body(self):
        cid = stream.record(who="B", body="keep me", ts=datetime(2026, 7, 6, 14, 15, 0))
        with self.assertRaises(stream.StreamError):
            stream.edit_card(cid, "   \n  ")
        self.assertEqual(stream.read_card(cid).body, "keep me")

    def test_edit_missing_card_raises(self):
        with self.assertRaises(stream.StreamError):
            stream.edit_card("2026-01-01.0000k", "body")

    def test_edit_rejects_unsafe_id(self):
        for bad in ("../escape", "sub/dir", "..", "a/../b"):
            with self.assertRaises(stream.StreamError):
                stream.edit_card(bad, "body")

    def test_edit_via_cli(self):
        stream.record(who="B", body="hi", ts=datetime(2026, 7, 6, 14, 20, 0))
        cid = "2026-07-06.1420b"
        env = dict(os.environ)
        result = subprocess.run(
            [sys.executable, STREAM_PY, "edit", cid],
            input="edited via cli\n", capture_output=True, text=True, env=env,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), cid)
        self.assertEqual(stream.read_card(cid).body, "edited via cli")


class DeleteCardTests(StreamTestCase):
    def test_delete_removes_card_file(self):
        cid = stream.record(who="B", body="a", ts=datetime(2026, 7, 6, 15, 0, 0))
        stream.record(who="B", body="b", ts=datetime(2026, 7, 6, 15, 1, 0))    # keeps the day alive
        stream.delete_card(cid)
        self.assertFalse(stream.card_path(cid).exists())
        with self.assertRaises(stream.StreamError):
            stream.read_card(cid)

    def test_delete_last_card_of_day_removes_day_view(self):
        day = "2026-07-06"
        cid = stream.record(who="B", body="only card today", ts=datetime(2026, 7, 6, 15, 5, 0))
        self.assertTrue((stream.daily_dir() / f"{day}.md").exists())

        stream.delete_card(cid)
        self.assertFalse((stream.daily_dir() / f"{day}.md").exists())

    def test_delete_non_last_card_of_day_rerenders_day(self):
        day = "2026-07-06"
        cid1 = stream.record(who="B", body="first", ts=datetime(2026, 7, 6, 15, 10, 0))
        stream.record(who="B", body="second", ts=datetime(2026, 7, 6, 15, 11, 0))
        stream.delete_card(cid1)
        day_text = (stream.daily_dir() / f"{day}.md").read_text(encoding="utf-8")
        self.assertIn("second", day_text)
        self.assertNotIn("first", day_text)

    def test_delete_last_card_of_month_removes_month_index(self):
        month = "2026-07"
        cid = stream.record(who="B", body="only card this month", ts=datetime(2026, 7, 6, 16, 0, 0))
        self.assertTrue((stream.index_dir() / f"{month}.md").exists())

        stream.delete_card(cid)
        self.assertFalse((stream.index_dir() / f"{month}.md").exists())

    def test_delete_rerenders_matching_manifest(self):
        d = stream.manifests_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "sally.md").write_text(
            "---\nselect: tag=sally\nrender: inline\nout: people/views/sally.md\n---\n",
            encoding="utf-8",
        )
        cid = stream.record(
            who="B", body="talked to sally", ts=datetime(2026, 7, 6, 16, 10, 0), tags=["sally"],
        )
        stream.render_manifest("sally")
        stream.delete_card(cid)
        out_path = stream.stream_root() / "people" / "views" / "sally.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertNotIn(f"[[{cid}]]", content)
        self.assertNotIn("talked to sally", content)

    def test_delete_missing_card_raises(self):
        with self.assertRaises(stream.StreamError):
            stream.delete_card("2026-01-01.0000k")

    def test_delete_rejects_unsafe_id(self):
        for bad in ("../escape", "sub/dir", "..", "a/../b"):
            with self.assertRaises(stream.StreamError):
                stream.delete_card(bad)

    def test_delete_via_cli(self):
        stream.record(who="B", body="hi", ts=datetime(2026, 7, 6, 16, 20, 0))
        cid = "2026-07-06.1620b"
        env = dict(os.environ)
        result = subprocess.run(
            [sys.executable, STREAM_PY, "delete", cid], capture_output=True, text=True, env=env,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), f"deleted {cid}")
        self.assertFalse(stream.card_path(cid).exists())


class ValidateDriftTests(StreamTestCase):
    def test_drift_detected_and_cleared(self):
        day = "2026-07-06"
        stream.record(who="B", body="hello", ts=datetime(2026, 7, 6, 12, 0, 0))
        ok, messages = stream.validate()
        self.assertTrue(ok, messages)

        day_path = stream.daily_dir() / f"{day}.md"
        original = day_path.read_text(encoding="utf-8")
        day_path.write_text(original + "\nhand-edited nonsense\n", encoding="utf-8")

        ok2, messages2 = stream.validate()
        self.assertFalse(ok2)
        self.assertTrue(any(m.startswith(f"DRIFT {day_path}") for m in messages2), messages2)

        stream.render_day(day)
        ok3, messages3 = stream.validate()
        self.assertTrue(ok3, messages3)


class DeterminismTests(StreamTestCase):
    def test_render_all_twice_is_byte_identical(self):
        stream.record(who="B", body="one", ts=datetime(2026, 7, 6, 13, 0, 0), tags=["x"])
        stream.record(who="K", body="two", ts=datetime(2026, 7, 6, 13, 5, 0))
        stream.record(who="B", body="three, next month", ts=datetime(2026, 8, 1, 9, 0, 0), tags=["x"])

        d = stream.manifests_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "x.md").write_text(
            "---\nselect: tag=x\nrender: inline\nout: people/views/x.md\n---\n",
            encoding="utf-8",
        )

        root = stream.stream_root()
        stream.render_all()
        snap1 = self._snapshot(root)
        stream.render_all()
        snap2 = self._snapshot(root)
        self.assertTrue(snap1)          # sanity: something was actually rendered
        self.assertEqual(snap1, snap2)


class CliTests(StreamTestCase):
    def test_help_output(self):
        result = subprocess.run(
            [sys.executable, STREAM_PY, "--help"], capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0)
        for verb in ("record", "render", "tag", "untag", "edit", "delete", "validate"):
            self.assertIn(verb, result.stdout)


if __name__ == "__main__":
    unittest.main()
