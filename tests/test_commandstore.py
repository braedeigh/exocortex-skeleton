"""commandstore.py — the slash-command ledger read out of Claude Code transcripts.

Two layers, mirroring the house split (see CLAUDE.md's testing notes):
`parse_line` is pure and gets asserted directly on hand-built transcript
lines, and the ingest/report path runs against a real (tmp_path) database
with a fake ~/.claude/projects tree.

The cases that earn a test are the ones that can silently go wrong: counting
a command that was only *quoted* in an attachment, counting a subagent's
line as the owner's, double-counting a resumed session, and the incremental
watermark skipping a file that actually grew.
"""
import json

import pytest

import commandstore


def line(**over):
    """One transcript JSONL line, defaults being a plain owner /spark run."""
    d = {
        "type": "user",
        "uuid": over.pop("uuid", "u1"),
        "timestamp": over.pop("timestamp", "2026-08-01T18:30:00.000Z"),
        "sessionId": "s1",
        "cwd": "/opt/exocortex",
        "isSidechain": False,
        "message": {"content": over.pop(
            "text", "<command-name>/spark</command-name>")},
    }
    d.update(over)
    return json.dumps(d)


def test_parses_name_and_strips_slash():
    row = commandstore.parse_line(line())
    assert row["name"] == "spark"
    assert row["kind"] == "skill"
    assert row["arg_chars"] == 0


def test_args_are_counted_never_stored():
    """The owner's prose is personal; only its length belongs in telemetry."""
    row = commandstore.parse_line(line(
        text="<command-name>/spark</command-name>"
             "<command-args>something private</command-args>"))
    assert row["arg_chars"] == len("something private")
    assert "something private" not in json.dumps(row)


def test_harness_commands_are_marked_builtin():
    assert commandstore.parse_line(line(
        text="<command-name>/compact</command-name>"))["kind"] == "builtin"


def test_quoted_marker_in_an_attachment_is_not_a_run():
    """A file snippet riding along on the line mentions the marker in its own
    text; only the message body counts."""
    raw = json.loads(line())
    raw["message"]["content"] = "look at this file"
    raw["attachment"] = {"snippet": "<command-name>/terra</command-name>"}
    assert commandstore.parse_line(json.dumps(raw)) is None


def test_subagent_lines_are_not_the_owner():
    assert commandstore.parse_line(line(isSidechain=True)) is None


def test_assistant_lines_are_ignored():
    assert commandstore.parse_line(line(type="assistant")) is None


def test_malformed_json_is_skipped_not_raised():
    assert commandstore.parse_line("<command-name>/spark</command-name> {oops") is None


def test_day_and_hour_are_local_not_utc():
    """Stored already converted — "which hour do I call /spark" is meaningless
    in UTC. Asserted against the same conversion rather than a fixed number so
    the test doesn't depend on the machine's zone."""
    row = commandstore.parse_line(line(timestamp="2026-08-01T02:30:00.000Z"))
    expect = commandstore._local("2026-08-01T02:30:00.000Z")
    assert row["day"] == expect.strftime("%Y-%m-%d")
    assert row["hour"] == expect.hour


@pytest.fixture
def projects(tmp_path, data_dir, monkeypatch):
    """A fake ~/.claude/projects, with the store already isolated by data_dir."""
    root = tmp_path / "projects"
    (root / "-opt-exocortex").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_PROJECTS_DIR", str(root))
    return root


def write(root, name, lines):
    p = root / "-opt-exocortex" / name
    p.write_text("\n".join(lines) + "\n")
    return p


def test_ingest_counts_runs(projects):
    write(projects, "a.jsonl", [line(uuid="u1"), line(uuid="u2")])
    assert commandstore.ingest()["rows"] == 2
    assert commandstore.summary()[0]["runs"] == 2


def test_same_line_in_two_files_counts_once(projects):
    """A forked or resumed session leaves the same uuid in more than one
    transcript; the ledger must not read that as two invocations."""
    write(projects, "a.jsonl", [line(uuid="shared")])
    write(projects, "b.jsonl", [line(uuid="shared")])
    commandstore.ingest()
    assert commandstore.summary()[0]["runs"] == 1


def test_rerunning_ingest_adds_nothing(projects):
    write(projects, "a.jsonl", [line(uuid="u1")])
    commandstore.ingest()
    again = commandstore.ingest()
    assert again["rows"] == 0
    assert again["skipped"] == 1


def test_appended_lines_are_picked_up(projects):
    """The watermark must resume, not skip — an open session's transcript
    grows all day."""
    p = write(projects, "a.jsonl", [line(uuid="u1")])
    commandstore.ingest()
    with open(p, "a") as fh:
        fh.write(line(uuid="u2") + "\n")
    assert commandstore.ingest()["rows"] == 1
    assert commandstore.summary()[0]["runs"] == 2


def test_rewritten_shorter_file_is_reread_from_the_top(projects):
    p = write(projects, "a.jsonl", [line(uuid="u1"), line(uuid="u2")])
    commandstore.ingest()
    p.write_text(line(uuid="u3") + "\n")   # shorter than before
    commandstore.ingest()
    assert {r["name"]: r["runs"] for r in commandstore.summary()} == {"spark": 3}


def test_summary_hides_builtins_unless_asked(projects):
    write(projects, "a.jsonl", [
        line(uuid="u1"),
        line(uuid="u2", text="<command-name>/compact</command-name>"),
    ])
    commandstore.ingest()
    assert [r["name"] for r in commandstore.summary()] == ["spark"]
    assert [r["name"] for r in commandstore.summary(kind=None)] == ["compact", "spark"]


def test_by_hour_returns_every_bucket(projects):
    write(projects, "a.jsonl", [line(uuid="u1")])
    commandstore.ingest()
    hours = commandstore.by_hour()
    assert len(hours) == 24
    assert sum(h["runs"] for h in hours) == 1


def test_rebuild_is_a_clean_reread(projects):
    write(projects, "a.jsonl", [line(uuid="u1")])
    commandstore.ingest()
    assert commandstore.rebuild()["rows"] == 1
    assert commandstore.summary()[0]["runs"] == 1


def test_a_local_command_shadows_the_harness_name(projects, monkeypatch):
    """This install ships its own /help. Filing those runs under the harness's
    /help hid a real skill from the only view built to show it."""
    commands = projects.parent / "commands"
    commands.mkdir()
    (commands / "help.md").write_text("# help")
    write(projects, "a.jsonl", [
        line(uuid="u1", text="<command-name>/help</command-name>"),
        line(uuid="u2", text="<command-name>/compact</command-name>"),
    ])
    commandstore.ingest()
    # /help is hers, so it ranks as a skill; /compact isn't installed and stays
    # a built-in.
    assert [r["name"] for r in commandstore.summary()] == ["help"]
    assert [r["name"] for r in commandstore.summary(kind="builtin")] == ["compact"]


def test_a_retired_skill_is_still_a_skill(projects):
    """Nothing is installed here, so only the named set classifies — and a
    command that isn't on it stays a skill even with no file behind it."""
    write(projects, "a.jsonl", [line(uuid="u1", text="<command-name>/gone</command-name>")])
    commandstore.ingest()
    assert commandstore.summary()[0]["name"] == "gone"
