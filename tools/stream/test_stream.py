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


def _own_journal_db(case, folder):
    """Give a test its own exo.db and data dir. The engine finds the database
    through TULKU_STREAM_DB, then EXOCORTEX_DATA_DIR — and an agent session on
    the live install carries EXOCORTEX_DATA_DIR pointing at the owner's real
    data — so without this a test card could land in the live journal (and the
    day views would read the live to-dos). Restored when the test ends."""
    for name, value in (("TULKU_STREAM_DB", str(Path(folder) / "exo.db")),
                        ("EXOCORTEX_DATA_DIR", str(Path(folder) / "data"))):
        previous = os.environ.get(name)
        case.addCleanup(lambda n=name, p=previous: os.environ.pop(n, None) if p is None
                        else os.environ.__setitem__(n, p))
        os.environ[name] = value


class StreamTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_root = os.environ.get("TULKU_STREAM_ROOT")
        os.environ["TULKU_STREAM_ROOT"] = self._tmp.name
        _own_journal_db(self, self._tmp.name)

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


class SessionProvenanceTests(StreamTestCase):
    """`session` is the conversation a card was highlighted out of. It has to
    survive a write/read round trip, stay absent by default, and — the part that
    matters for the ~1200 cards already on disk — parse fine on cards written
    before the field existed."""

    def test_session_round_trips(self):
        cid = stream.record(
            who="K", body="something the keeper said", session="2026-08-01.143012",
        )
        self.assertEqual(stream.read_card(cid).session, "2026-08-01.143012")

    def test_session_defaults_to_none(self):
        cid = stream.record(who="B", body="an ordinary captured line")
        self.assertIsNone(stream.read_card(cid).session)

    def test_card_written_before_the_field_existed_still_parses(self):
        card = stream.parse_card_text(
            "---\n"
            "id: 2026-07-06.0843b\n"
            "who: B\n"
            "ts: 2026-07-06 08:43:12\n"
            "reply_to: null\n"
            "tags: []\n"
            "kind: line\n"
            "---\n"
            "an old card, no refs and no session\n"
        )
        self.assertIsNone(card.session)
        self.assertEqual(card.refs, [])

    def test_cli_passes_session_through(self):
        result = subprocess.run(
            [sys.executable, STREAM_PY, "record", "--who", "K",
             "--session", "2026-08-01.143012"],
            input="pulled from a room", capture_output=True, text=True,
            env=dict(os.environ),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        cid = result.stdout.strip().splitlines()[-1]
        self.assertEqual(stream.read_card(cid).session, "2026-08-01.143012")


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


class SystemSpeakerTests(StreamTestCase):
    """S — a reminder the app sent: its own speaker, id letter and day line."""

    def test_system_card_mints_with_an_s_id(self):
        ts = datetime(2026, 10, 16, 18, 0, 0)
        cid = stream.record(who="S", body="Reminder (set by you): Permafest", ts=ts)
        self.assertEqual(cid, "2026-10-16.1800s")
        self.assertEqual(stream.read_card(cid).who, "S")

    def test_system_card_renders_as_its_own_line(self):
        ts = datetime(2026, 10, 16, 18, 0, 0)
        stream.record(who="S", body="Reminder: Permafest", ts=ts)
        day = stream.render_day("2026-10-16")
        text = day.read_text() if hasattr(day, "read_text") else str(day)
        self.assertIn("S: Reminder: Permafest", text)

    def test_unknown_speaker_is_still_refused(self):
        with self.assertRaises(stream.StreamError):
            stream.record(who="X", body="nobody")

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

    def test_validate_detects_words_rewritten_around_the_engine(self):
        """A row whose words were changed by raw SQL (not through `edit`) no
        longer matches its fingerprint, and validate says so."""
        cid = stream.record(who="B", body="what I said", ts=datetime(2026, 7, 6, 10, 0, 0))
        with stream._db() as conn:
            conn.execute("UPDATE cards SET body = 'what someone wrote instead' WHERE id = ?", (cid,))

        ok, messages = stream.validate()
        self.assertFalse(ok)
        self.assertTrue(any("fingerprint" in m and cid in m for m in messages), messages)

    def test_validate_detects_cycle(self):
        cid_a = stream.record(who="B", body="a2", ts=datetime(2026, 7, 6, 10, 5, 0))
        cid_b = stream.record(who="B", body="b2", ts=datetime(2026, 7, 6, 10, 6, 0), reply_to=cid_a)
        stream.link_cards(cid_a, cid_b, "answers")

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


class EditHistoryTests(StreamTestCase):
    """An edit keeps the old text, stamps the card, and shows on the day it
    was made — the owner's rule: changes are marked on the date they happen."""

    def _log(self):
        path = stream.edited_log_path()
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def test_edit_logs_the_text_before_and_after(self):
        cid = stream.record(who="B", body="first words", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "second words", by="owner", now=datetime(2026, 9, 24, 16, 5, 0))
        entry = self._log()[0]
        self.assertEqual(
            (entry["id"], entry["before"], entry["after"], entry["edited_at"], entry["by"]),
            (cid, "first words", "second words", "2026-09-24 16:05:00", "owner"),
        )

    def test_every_edit_is_kept_in_order(self):
        cid = stream.record(who="B", body="v1", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "v2", now=datetime(2026, 9, 24, 16, 0, 0))
        stream.edit_card(cid, "v3", now=datetime(2026, 9, 25, 8, 0, 0))
        self.assertEqual([(e["before"], e["after"]) for e in self._log()], [("v1", "v2"), ("v2", "v3")])

    def test_edit_stamps_the_card_but_keeps_its_time(self):
        cid = stream.record(who="B", body="v1", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "v2", now=datetime(2026, 9, 24, 16, 5, 0))
        card = stream.read_card(cid)
        self.assertEqual((card.ts, card.edited), ("2026-07-06 09:00:00", "2026-09-24 16:05:00"))

    def test_unedited_card_has_no_edited_line(self):
        cid = stream.record(who="B", body="never touched", ts=datetime(2026, 7, 6, 9, 0, 0))
        self.assertNotIn("edited:", stream.card_path(cid).read_text(encoding="utf-8"))

    def test_saving_the_same_text_is_not_an_edit(self):
        cid = stream.record(who="B", body="same", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "same\n", now=datetime(2026, 9, 24, 16, 5, 0))
        self.assertIsNone(stream.read_card(cid).edited)
        self.assertFalse(stream.edited_log_path().exists())

    def test_edit_shows_on_the_day_it_was_made(self):
        cid = stream.record(who="B", body="old news", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.record(who="B", body="a line on the edit day", ts=datetime(2026, 9, 24, 15, 0, 0))
        stream.edit_card(cid, "the corrected account of it", now=datetime(2026, 9, 24, 16, 5, 0))
        day_text = (stream.daily_dir() / "2026-09-24.md").read_text(encoding="utf-8")
        self.assertIn("✎ edited an entry from 2026-07-06: “the corrected account of it” — 4:05 PM", day_text)

    def test_same_day_edit_gets_no_separate_marker(self):
        cid = stream.record(who="B", body="typo hre", ts=datetime(2026, 9, 24, 15, 0, 0))
        stream.edit_card(cid, "typo here", now=datetime(2026, 9, 24, 15, 1, 0))
        self.assertEqual(stream.edit_markers("2026-09-24"), [])

    def test_several_edits_to_one_card_in_a_day_show_once(self):
        cid = stream.record(who="B", body="v1", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "v2", now=datetime(2026, 9, 24, 16, 0, 0))
        stream.edit_card(cid, "v3", now=datetime(2026, 9, 24, 17, 0, 0))
        markers = stream.edit_markers("2026-09-24")
        self.assertEqual([(m.card_id, m.edited_at, m.snippet) for m in markers],
                         [(cid, "2026-09-24 17:00:00", "v3")])

    def test_a_garbled_log_line_is_skipped(self):
        cid = stream.record(who="B", body="v1", ts=datetime(2026, 7, 6, 9, 0, 0))
        stream.edit_card(cid, "v2", now=datetime(2026, 9, 24, 16, 0, 0))
        with stream.edited_log_path().open("a", encoding="utf-8") as fh:
            fh.write("{not json\n")
        self.assertEqual(len(stream.load_edit_log()), 1)

    def test_cli_edit_records_who_asked(self):
        stream.record(who="B", body="hi", ts=datetime(2026, 7, 6, 14, 20, 0))
        result = subprocess.run(
            [sys.executable, STREAM_PY, "edit", "2026-07-06.1420b", "--by", "cards-route"],
            input="hello\n", capture_output=True, text=True, env=dict(os.environ),
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self._log()[0]["by"], "cards-route")


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


class DeletionRecordTests(StreamTestCase):
    """A delete hides the row and keeps it: the row is its own record of what
    went, when, and who asked."""

    def _row(self, cid):
        with stream._db() as conn:
            return conn.execute("SELECT body, deleted_at, deleted_by FROM cards WHERE id = ?",
                                (cid,)).fetchone()

    def test_delete_keeps_the_words_and_who_asked(self):
        cid = stream.record(who="B", body="the words that went\nsecond line",
                            ts=datetime(2026, 7, 6, 17, 0, 0), tags=["gut"])
        stream.record(who="B", body="keeps the day alive", ts=datetime(2026, 7, 6, 17, 1, 0))
        stream.delete_card(cid, by="test")

        body, deleted_at, deleted_by = self._row(cid)
        self.assertEqual(body, "the words that went\nsecond line")
        self.assertIsNotNone(deleted_at)
        self.assertEqual(deleted_by, "test")
        self.assertFalse(stream.card_exists(cid))
        self.assertNotIn(cid, {c.id for c in stream.load_all_cards()})

    def test_a_deleted_id_is_never_minted_again(self):
        cid = stream.record(who="B", body="first", ts=datetime(2026, 7, 6, 17, 20, 0))
        stream.delete_card(cid, by="test")
        again = stream.record(who="B", body="second", ts=datetime(2026, 7, 6, 17, 20, 30))
        self.assertNotEqual(again, cid)

    def test_cli_records_who_asked_then_env_then_cli_literal(self):
        for minute in (10, 11, 12, 13):
            stream.record(who="B", body=f"card {minute}", ts=datetime(2026, 7, 6, 19, minute, 0))
        subprocess.run([sys.executable, STREAM_PY, "delete", "2026-07-06.1910b", "--by", "cards-route"],
                       capture_output=True, text=True, env=dict(os.environ), check=True)
        subprocess.run([sys.executable, STREAM_PY, "delete", "2026-07-06.1911b"],
                       capture_output=True, text=True, env=dict(os.environ, STREAM_DELETE_BY="keeper"),
                       check=True)
        subprocess.run([sys.executable, STREAM_PY, "delete", "2026-07-06.1912b"],
                       capture_output=True, text=True, env=dict(os.environ), check=True)
        self.assertEqual([self._row(f"2026-07-06.19{m}b")[2] for m in (10, 11, 12)],
                         ["cards-route", "keeper", "cli"])


class TwentyFourHourLockTests(StreamTestCase):
    """Rule 2 of docs/journal-database.md: a card can be edited or deleted for
    24 hours after it was saved, then never — enforced in SQLite itself."""

    def _old_card(self, cid="2026-07-01.0900b", body="said long ago"):
        """A card saved more than a day ago, put straight into the table."""
        with stream._db() as conn:
            stream.journaldb.insert_card(conn, id=cid, who="B", said_at="2026-07-01 09:00:00",
                                         body=body, saved_at="2026-07-01 09:00:00")
        return cid

    def test_the_database_refuses_changing_or_deleting_an_old_card(self):
        """At the SQL level, whoever is asking: no engine, no app code."""
        cid = self._old_card()
        with stream._db() as conn:
            for sql in ("UPDATE cards SET body = 'rewritten' WHERE id = ?",
                        "UPDATE cards SET who = 'K' WHERE id = ?",
                        "UPDATE cards SET said_at = '2026-07-01 10:00:00' WHERE id = ?",
                        "UPDATE cards SET deleted_at = '2026-11-16 00:00:00' WHERE id = ?",
                        "UPDATE cards SET saved_at = '2099-01-01 00:00:00' WHERE id = ?",
                        "DELETE FROM cards WHERE id = ?"):
                with self.assertRaises(stream.sqlite3.DatabaseError, msg=sql):
                    conn.execute(sql, (cid,))
            # Filing around a locked card still works: labels and links are rows of their own.
            conn.execute("UPDATE cards SET session = 'conv-1' WHERE id = ?", (cid,))
            self.assertEqual(conn.execute("SELECT body FROM cards WHERE id = ?", (cid,)).fetchone()[0],
                             "said long ago")

    def test_a_late_arrival_gets_its_full_day(self):
        """The clock runs from when the row was saved, not when it was said: a
        card recorded today about last week can still be fixed today."""
        cid = stream.record(who="B", body="said last week, saved now", ts=datetime(2026, 7, 1, 9, 0, 0))
        card = stream.edit_card(cid, "said last week, fixed now", by="test")
        self.assertEqual(card.body, "said last week, fixed now")

    def test_the_engine_refuses_kindly_and_points_at_a_note(self):
        cid = self._old_card()
        for change in (lambda: stream.edit_card(cid, "new words", by="test"),
                       lambda: stream.delete_card(cid, by="test")):
            with self.assertRaises(stream.StreamError) as caught:
                change()
            self.assertIn("locked", str(caught.exception))
            self.assertIn("--note-on", str(caught.exception))
        self.assertEqual(stream.read_card(cid).body, "said long ago")

    def test_a_note_on_a_locked_card_is_a_new_card_linked_to_it(self):
        old = self._old_card()
        note = stream.record(who="B", body="looking back, I was wrong", note_on=old)
        with stream._db() as conn:
            self.assertEqual(conn.execute(
                "SELECT kind FROM card_links WHERE from_card = ? AND to_card = ?", (note, old)).fetchone(),
                ("note",))
        self.assertEqual(stream.read_card(note).ts[:10], datetime.now().strftime("%Y-%m-%d"))
        # Labels can still be put on the old card itself.
        self.assertIn("hindsight", stream.add_tags(old, ["hindsight"], by="owner").tags)


class HoldingFileTests(StreamTestCase):
    """Rule 4: saving a card never fails because of the database."""

    def _break_db(self):
        """Point the engine at a database path it can't open."""
        self._real_db = os.environ["TULKU_STREAM_DB"]
        os.environ["TULKU_STREAM_DB"] = str(Path(self._tmp.name) / "no-such-dir" / "exo.db")

    def _mend_db(self):
        os.environ["TULKU_STREAM_DB"] = self._real_db

    def test_a_card_the_database_cant_take_is_held_then_lands(self):
        stream.record(who="B", body="before the outage", ts=datetime(2026, 7, 6, 8, 0, 0))
        self._break_db()
        provisional = stream.record(who="B", body="said during the outage",
                                    ts=datetime(2026, 7, 6, 8, 5, 0), tags=["worries"])
        self.assertEqual(provisional, "2026-07-06.0805b")
        self.assertEqual([e["body"] for e in stream.held_cards()], ["said during the outage"])
        self._mend_db()

        # The next ordinary write drains the holding file first-come.
        stream.record(who="B", body="after the outage", ts=datetime(2026, 7, 6, 8, 10, 0))
        self.assertEqual(stream.held_cards(), [])
        held = stream.read_card("2026-07-06.0805b")
        self.assertEqual((held.body, held.tags), ("said during the outage", ["worries"]))
        day = (stream.daily_dir() / "2026-07-06.md").read_text(encoding="utf-8")
        self.assertIn("said during the outage", day)

    def test_draining_twice_never_doubles_a_card(self):
        self._break_db()
        stream.record(who="B", body="once only", ts=datetime(2026, 7, 6, 9, 0, 0))
        self._mend_db()
        # Simulate a drain that wrote the row but died before clearing the file.
        entry = stream.held_cards()[0]
        stream._write_entry(entry, strict=False)
        self.assertEqual(stream.drain_holding(), 0)
        self.assertEqual([c.body for c in stream.load_all_cards()], ["once only"])
        self.assertEqual(stream.held_cards(), [])

    def test_the_cli_echoes_an_id_even_when_held(self):
        self._break_db()
        result = subprocess.run([sys.executable, STREAM_PY, "record", "--who", "B"],
                                input="held via cli\n", capture_output=True, text=True,
                                env=dict(os.environ))
        self._mend_db()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^\d{4}-\d{2}-\d{2}\.\d{4}b\d*$")
        self.assertEqual(len(stream.held_cards()), 1)


class LabelRuleTests(StreamTestCase):
    """Rules 6-7: labels carry who added them and why, and the owner's hand
    outranks every agent's."""

    def test_the_owners_removal_is_remembered_and_her_label_is_hers(self):
        cid = stream.record(who="B", body="a long talk", ts=datetime(2026, 7, 6, 11, 0, 0))
        stream.add_tags(cid, ["ezra"], by="people-cricket", run="2026-07-07", reason="names him")
        stream.remove_tags(cid, ["ezra"], by="owner", reason="a different Ezra")
        self.assertEqual(stream.add_tags(cid, ["ezra"], by="people-cricket").outcomes, {"ezra": "refused"})
        self.assertNotIn("ezra", stream.read_card(cid).tags)

        stream.add_tags(cid, ["long-covid"], by="owner")
        self.assertEqual(stream.remove_tags(cid, ["long-covid"], by="thread-tending").outcomes,
                         {"long-covid": "refused"})
        self.assertIn("long-covid", stream.read_card(cid).tags)
        # She can change her own mind.
        self.assertEqual(stream.add_tags(cid, ["ezra"], by="owner").outcomes, {"ezra": "added"})

        with stream._db() as conn:
            history = conn.execute(
                "SELECT added_by, run, reason, removed_by, removed_why FROM card_labels cl"
                " JOIN labels l ON l.id = cl.label_id WHERE l.slug = 'ezra' ORDER BY cl.id").fetchall()
        self.assertEqual(history, [("people-cricket", "2026-07-07", "names him", "owner", "a different Ezra"),
                                   ("owner", None, None, None, None)])

    def test_new_slugs_are_classified_from_the_vault(self):
        root = Path(self._tmp.name)
        (root / "people").mkdir()
        (root / "people" / "sage.md").write_text("---\nname: Sage\n---\n", encoding="utf-8")
        (root / "Threads").mkdir()
        (root / "Threads" / "worries.md").write_text("---\nstatus: dormant\n---\n", encoding="utf-8")
        stream.record(who="B", body="x", ts=datetime(2026, 7, 6, 12, 0, 0),
                      tags=["sage", "worries", "mandala", "exo-command"])
        with stream._db() as conn:
            kinds = dict(conn.execute("SELECT slug, kind || '/' || status FROM labels"))
        self.assertEqual(kinds, {"sage": "person/active", "worries": "thread/dormant",
                                 "mandala": "topic/active", "exo-command": "source/active"})

    def test_voice_tags_become_capture_facts_and_still_read_as_tags(self):
        cid = stream.record(who="B", body="heard aloud", tags=["voice", "via:kitchen-pi", "exo-command"])
        with stream._db() as conn:
            self.assertEqual(conn.execute("SELECT door, device FROM cards WHERE id = ?", (cid,)).fetchone(),
                             ("voice", "kitchen-pi"))
            self.assertEqual(sorted(t for (t,) in conn.execute(
                "SELECT tag FROM card_tags WHERE card_id = ?", (cid,))),
                ["exo-command", "via:kitchen-pi", "voice"])
        self.assertEqual(stream.read_card(cid).tags, ["voice", "via:kitchen-pi", "exo-command"])


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
