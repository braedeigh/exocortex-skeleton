#!/usr/bin/env python3
"""
test_stream.py — unit tests for stream.py, the deterministic card-pool spine.

Every test points TULKU_STREAM_ROOT at a fresh tempdir (never the live vault) so the
pool/manifest/index/view machinery can be exercised freely and thrown away. stream.py
resolves its root lazily (`stream_root()` reads the env var on every call), so setting
the env var in setUp is enough — no reload needed.
"""
import json
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
        cid_b = stream.record(who="B", body="from the owner", ts=ts)
        cid_k = stream.record(who="K", body="from keeper", ts=ts)
        self.assertEqual(cid_b, "2026-07-06.0843b")
        self.assertEqual(cid_k, "2026-07-06.0843k")

    def test_concurrent_records_same_minute_lose_nothing(self):
        # The mint->write TOCTOU guard: N threads recording in the same minute
        # for the same speaker must produce N distinct cards — the pool lock
        # makes probe+write one step, so no card can overwrite another.
        import threading
        ts = datetime(2026, 7, 6, 9, 0, 0)
        ids, errors = [], []
        lock = threading.Lock()

        def mint(n):
            try:
                cid = stream.record(who="B", body=f"turn {n}", ts=ts)
                with lock:
                    ids.append(cid)
            except Exception as exc:  # pragma: no cover - failure path
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=mint, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(set(ids)), 8)
        bodies = {stream.read_card(cid).body for cid in ids}
        self.assertEqual(bodies, {f"turn {n}" for n in range(8)})

    def test_write_card_leaves_no_temp_droppings(self):
        ts = datetime(2026, 7, 6, 9, 30, 0)
        stream.record(who="B", body="atomic write", ts=ts)
        leftovers = list(stream.pool_dir().glob("*.tmp"))
        self.assertEqual(leftovers, [])


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

    def test_day_legend_from_vault_config(self):
        # The owner's name is data, not code: _system/data/config.json's
        # day_legend key personalizes the rendered legend line.
        cfg = Path(self._tmp.name) / "_system" / "data" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps({"day_legend": "B = Alice | K = Keeper"}))
        stream.record(who="B", body="hello", ts=datetime(2026, 7, 6, 8, 0, 0))
        text = stream.render_day_text("2026-07-06")
        self.assertIn("`B = Alice | K = Keeper`", text)

    def test_day_legend_env_wins_over_config(self):
        cfg = Path(self._tmp.name) / "_system" / "data" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps({"day_legend": "B = Alice | K = Keeper"}))
        os.environ["STREAM_DAY_LEGEND"] = "B = Env | K = Keeper"
        try:
            stream.record(who="B", body="hello", ts=datetime(2026, 7, 6, 8, 0, 0))
            self.assertIn("`B = Env | K = Keeper`", stream.render_day_text("2026-07-06"))
        finally:
            os.environ.pop("STREAM_DAY_LEGEND", None)

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
    def _write_sage_manifest(self):
        d = stream.manifests_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / "sage.md").write_text(
            "---\nselect: tag=sage\nrender: inline\nout: people/views/sage.md\n---\n",
            encoding="utf-8",
        )

    def test_tag_then_render_then_untag_then_render(self):
        cid = stream.record(who="B", body="talked to sage today", ts=datetime(2026, 7, 6, 11, 0, 0))
        stream.add_tags(cid, ["sage"])
        self.assertEqual(stream.read_card(cid).tags, ["sage"])

        self._write_sage_manifest()
        stream.render_manifest("sage")
        out_path = stream.stream_root() / "people" / "views" / "sage.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertIn(f"[[{cid}]]", content)
        self.assertIn("talked to sage today", content)

        stream.remove_tags(cid, ["sage"])     # re-renders the manifest itself
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
        (d / "sage.md").write_text(
            "---\nselect: tag=sage\nrender: inline\nout: people/views/sage.md\n---\n",
            encoding="utf-8",
        )
        cid = stream.record(
            who="B", body="talked to sage", ts=datetime(2026, 7, 6, 14, 10, 0), tags=["sage"],
        )
        stream.render_manifest("sage")
        stream.edit_card(cid, "talked to sage about the weekend")
        out_path = stream.stream_root() / "people" / "views" / "sage.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertIn("talked to sage about the weekend", content)

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
        (d / "sage.md").write_text(
            "---\nselect: tag=sage\nrender: inline\nout: people/views/sage.md\n---\n",
            encoding="utf-8",
        )
        cid = stream.record(
            who="B", body="talked to sage", ts=datetime(2026, 7, 6, 16, 10, 0), tags=["sage"],
        )
        stream.render_manifest("sage")
        stream.delete_card(cid)
        out_path = stream.stream_root() / "people" / "views" / "sage.md"
        content = out_path.read_text(encoding="utf-8")
        self.assertNotIn(f"[[{cid}]]", content)
        self.assertNotIn("talked to sage", content)

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


class TodoMarkerWeaveTests(StreamTestCase):
    """render_day_text weaves 'marked to-do complete' lines in from todos.json —
    see stream.todo_completion_markers / stream._marker_for_item. Every test here
    points EXOCORTEX_DATA_DIR at its own tempdir so todos.json is fully isolated
    from the card pool tempdir StreamTestCase already sets up."""

    def setUp(self):
        super().setUp()
        self._data_tmp = tempfile.TemporaryDirectory()
        self._prev_data_dir = os.environ.get("EXOCORTEX_DATA_DIR")
        os.environ["EXOCORTEX_DATA_DIR"] = self._data_tmp.name

    def tearDown(self):
        if self._prev_data_dir is None:
            os.environ.pop("EXOCORTEX_DATA_DIR", None)
        else:
            os.environ["EXOCORTEX_DATA_DIR"] = self._prev_data_dir
        self._data_tmp.cleanup()
        super().tearDown()

    def _write_todos(self, raw: str) -> None:
        (Path(self._data_tmp.name) / "todos.json").write_text(raw, encoding="utf-8")

    def _seed_todos(self, items) -> None:
        self._write_todos(json.dumps({"now": {"items": items}}))

    def test_timed_marker_weaves_between_the_right_cards(self):
        day = "2026-07-20"
        stream.record(who="B", body="card A", ts=datetime(2026, 7, 20, 8, 0, 0))
        stream.record(who="B", body="card B", ts=datetime(2026, 7, 20, 8, 10, 0))
        self._seed_todos([
            {"id": "a", "text": "water the plants", "done": True,
             "done_at": "2026-07-20T08:05"},
        ])
        text = stream.render_day_text(day)
        self.assertIn("✓ marked to-do complete: water the plants — 8:05 AM", text)
        # ordering: card A, then the marker, then card B
        pos_a = text.index("card A")
        pos_marker = text.index("marked to-do complete")
        pos_b = text.index("card B")
        self.assertTrue(pos_a < pos_marker < pos_b, text)
        # only one gap header: all three events are within GAP_SECONDS of
        # each other, so *[...]* should appear exactly once.
        self.assertEqual(text.count("*["), 1)

    def test_tie_at_the_same_minute_renders_marker_before_the_card(self):
        day = "2026-07-20"
        stream.record(who="B", body="same minute card", ts=datetime(2026, 7, 20, 8, 5, 0))
        self._seed_todos([
            {"id": "a", "text": "tied task", "done": True,
             "done_at": "2026-07-20T08:05"},
        ])
        text = stream.render_day_text(day)
        pos_marker = text.index("marked to-do complete")
        pos_card = text.index("same minute card")
        self.assertTrue(pos_marker < pos_card, text)
        self.assertEqual(text.count("*["), 1)   # one header shared by the tied pair

    def test_finished_note_renders_as_curly_quoted_suffix(self):
        day = "2026-07-20"
        stream.record(who="B", body="anchor card", ts=datetime(2026, 7, 20, 8, 0, 0))
        self._seed_todos([
            {"id": "a", "text": "call the vet", "done": True,
             "done_at": "2026-07-20T08:02", "finished_note": "went great"},
        ])
        text = stream.render_day_text(day)
        self.assertIn(
            "✓ marked to-do complete: call the vet — 8:02 AM — “went great”",
            text,
        )

    def test_day_only_claim_renders_untimed_in_the_tail(self):
        day = "2026-07-20"
        stream.record(who="B", body="only card", ts=datetime(2026, 7, 20, 8, 0, 0))
        self._seed_todos([
            {"id": "a", "text": "file taxes", "done": True,
             "done_at": "2026-07-19T23:00",              # tap landed on a different day
             "finished_on": "2026-07-20"},                # day-only claim overrides it
        ])
        text = stream.render_day_text(day)
        # not woven into the timeline (no time attached to it)
        self.assertNotIn("marked to-do complete: file taxes —", text)
        # tail block: a blank line, then the untimed line, at the very end
        self.assertTrue(text.endswith("\n✓ marked to-do complete: file taxes\n"), text)
        card_pos = text.index("only card")
        tail_pos = text.index("marked to-do complete: file taxes")
        self.assertTrue(card_pos < tail_pos, text)

    def test_legacy_date_only_done_at_also_lands_untimed_in_the_tail(self):
        day = "2026-07-20"
        stream.record(who="B", body="only card", ts=datetime(2026, 7, 20, 8, 0, 0))
        self._seed_todos([
            {"id": "a", "text": "renew passport", "done": True, "done_at": "2026-07-20"},
        ])
        text = stream.render_day_text(day)
        self.assertIn("\n✓ marked to-do complete: renew passport\n", text)
        self.assertNotIn("renew passport —", text)

    def test_missing_todos_json_renders_exactly_as_without_the_feature(self):
        day = "2026-07-20"
        stream.record(who="B", body="solo card", ts=datetime(2026, 7, 20, 8, 0, 0))
        # no todos.json written at all in self._data_tmp
        text = stream.render_day_text(day)
        self.assertNotIn("marked to-do complete", text)
        self.assertEqual(
            text,
            "# 2026-07-20\n\n`B = you | K = keeper`\n\n---\n\n*[8:00 AM]*\n\nB: solo card\n",
        )

    def test_corrupt_todos_json_renders_exactly_as_without_the_feature(self):
        day = "2026-07-20"
        stream.record(who="B", body="solo card", ts=datetime(2026, 7, 20, 8, 0, 0))
        baseline = stream.render_day_text(day)
        self._write_todos("{ not valid json ][")
        text = stream.render_day_text(day)
        self.assertNotIn("marked to-do complete", text)
        self.assertEqual(text, baseline)

    def test_unexpected_top_level_shape_yields_no_markers(self):
        day = "2026-07-20"
        stream.record(who="B", body="solo card", ts=datetime(2026, 7, 20, 8, 0, 0))
        baseline = stream.render_day_text(day)
        self._write_todos(json.dumps(["not", "a", "dict"]))
        text = stream.render_day_text(day)
        self.assertEqual(text, baseline)

    def test_zero_card_day_stays_none_even_with_a_matching_marker(self):
        day = "2026-01-01"
        self._seed_todos([
            {"id": "a", "text": "no cards this day", "done": True,
             "done_at": "2026-01-01T09:00"},
        ])
        self.assertIsNone(stream.render_day_text(day))
        self.assertIsNone(stream.render_day(day))
        self.assertFalse((stream.daily_dir() / f"{day}.md").exists())

    def test_marker_change_after_render_causes_drift_until_rerendered(self):
        """Documents the accepted edge from render_day_text's docstring: the weave
        is computed live from todos.json, so a completion recorded after the last
        render leaves the on-disk view stale until the next render — `validate`'s
        drift check catches it, and re-rendering heals it."""
        day = "2026-07-20"
        stream.record(who="B", body="anchor card", ts=datetime(2026, 7, 20, 8, 0, 0))
        ok, messages = stream.validate()
        self.assertTrue(ok, messages)

        self._seed_todos([
            {"id": "a", "text": "newly completed", "done": True,
             "done_at": "2026-07-20T08:05"},
        ])
        ok2, messages2 = stream.validate()
        self.assertFalse(ok2)
        day_path = stream.daily_dir() / f"{day}.md"
        self.assertTrue(any(m.startswith(f"DRIFT {day_path}") for m in messages2), messages2)

        stream.render_day(day)
        ok3, messages3 = stream.validate()
        self.assertTrue(ok3, messages3)


class StreakMarkerWeaveTests(StreamTestCase):
    """render_day_text weaves '⏹ retired day count' lines in from streaks.json —
    see stream.streak_retirement_markers. Same isolation shape as
    TodoMarkerWeaveTests: EXOCORTEX_DATA_DIR points at a private tempdir."""

    def setUp(self):
        super().setUp()
        self._data_tmp = tempfile.TemporaryDirectory()
        self._prev_data_dir = os.environ.get("EXOCORTEX_DATA_DIR")
        os.environ["EXOCORTEX_DATA_DIR"] = self._data_tmp.name

    def tearDown(self):
        if self._prev_data_dir is None:
            os.environ.pop("EXOCORTEX_DATA_DIR", None)
        else:
            os.environ["EXOCORTEX_DATA_DIR"] = self._prev_data_dir
        self._data_tmp.cleanup()
        super().tearDown()

    def _seed_streaks(self, entries) -> None:
        (Path(self._data_tmp.name) / "streaks.json").write_text(
            json.dumps({"streaks": entries}), encoding="utf-8")

    def test_timed_retirement_weaves_with_frozen_count_and_note(self):
        day = "2026-07-20"
        stream.record(who="B", body="card A", ts=datetime(2026, 7, 20, 8, 0, 0))
        stream.record(who="B", body="card B", ts=datetime(2026, 7, 20, 8, 10, 0))
        self._seed_streaks([
            {"label": "on peptides", "since": "2026-02-22", "status": "retired",
             "retired_on": day, "retired_time": "08:05",
             "retired_note": "done for now"},
        ])
        text = stream.render_day_text(day)
        # 2026-02-22 -> 2026-07-20 is 148 days, frozen at retirement.
        self.assertIn("⏹ retired day count: on peptides — Day 148 — 8:05 AM — “done for now”", text)
        pos_a = text.index("card A")
        pos_marker = text.index("retired day count")
        pos_b = text.index("card B")
        self.assertTrue(pos_a < pos_marker < pos_b, text)

    def test_active_and_other_day_retirements_do_not_weave(self):
        day = "2026-07-20"
        stream.record(who="B", body="anchor card", ts=datetime(2026, 7, 20, 8, 0, 0))
        self._seed_streaks([
            {"label": "off weed", "since": "2026-02-22", "status": "active"},
            {"label": "of Prozac", "since": "2026-01-01", "status": "retired",
             "retired_on": "2026-07-19", "retired_time": "10:00"},
        ])
        text = stream.render_day_text(day)
        self.assertNotIn("retired day count", text)

    def test_untimed_retirement_lands_in_the_tail_block(self):
        day = "2026-07-20"
        stream.record(who="B", body="anchor card", ts=datetime(2026, 7, 20, 8, 0, 0))
        self._seed_streaks([
            {"label": "on peptides", "since": "2026-07-10", "status": "retired",
             "retired_on": day},
        ])
        text = stream.render_day_text(day)
        self.assertIn("⏹ retired day count: on peptides — Day 10", text)
        # untimed: renders after the timeline, without a clock suffix
        self.assertTrue(text.index("anchor card") < text.index("retired day count"))
        self.assertNotIn("Day 10 — ", text)

    def test_zero_card_day_stays_none_even_with_a_retirement(self):
        self._seed_streaks([
            {"label": "on peptides", "since": "2026-07-10", "status": "retired",
             "retired_on": "2026-07-20", "retired_time": "08:05"},
        ])
        self.assertIsNone(stream.render_day_text("2026-07-20"))


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
