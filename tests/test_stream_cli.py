"""The journal engine's CLI door (tools/stream/stream.py `main`).

Pins `--body-file`: a card body read from a file instead of stdin, so a gated
keeper session (tools/act_ask_gate.py refuses pipes, redirects, backticks and
literal newlines in a Bash line) can mint the day's context card as one bare
command. The body itself may carry every character the gate bans — that's the
whole point — and must land in the card byte-for-byte.
"""
import io

import pytest

from tools.stream import stream


@pytest.fixture
def stream_root(tmp_path, monkeypatch):
    """A fresh, empty vault for the engine. Root resolution is lazy (read on
    every call), so pointing the env var at tmp_path is enough."""
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(tmp_path))
    return tmp_path


BODY = 'Day 3 | live: `todo-closer` | "quoted" > $(not run) <b>\nKeeper: Test'


def test_record_body_file_mints_card_with_gate_hostile_body(stream_root, capsys):
    body = stream_root / "ctx.md"
    body.write_text(BODY, encoding="utf-8")
    rc = stream.main(["record", "--who", "K", "--kind", "context",
                      "--ts", "2026-09-17 03:10:00", "--body-file", str(body)])
    assert rc == 0
    cid = capsys.readouterr().out.strip()
    card = stream.read_card(cid)
    assert card.kind == "context"
    assert card.body == BODY


def test_record_falls_back_to_stdin_without_body_file(stream_root, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("a plain question?"))
    rc = stream.main(["record", "--who", "K", "--ts", "2026-09-17 09:00:00"])
    assert rc == 0
    cid = capsys.readouterr().out.strip()
    assert stream.read_card(cid).body == "a plain question?"


def test_record_missing_body_file_is_an_error_not_a_card(stream_root, capsys):
    rc = stream.main(["record", "--who", "K", "--body-file", str(stream_root / "nope.md")])
    assert rc == 1
    assert "--body-file" in capsys.readouterr().err
    assert not list(stream.pool_dir().glob("*.md")) if stream.pool_dir().exists() else True


def test_edit_body_file_replaces_body(stream_root, capsys):
    body = stream_root / "one.md"
    body.write_text("first", encoding="utf-8")
    assert stream.main(["record", "--who", "B", "--ts", "2026-09-17 10:00:00",
                        "--body-file", str(body)]) == 0
    cid = capsys.readouterr().out.strip()
    body.write_text("second | `edited`", encoding="utf-8")
    assert stream.main(["edit", cid, "--body-file", str(body)]) == 0
    assert stream.read_card(cid).body == "second | `edited`"
