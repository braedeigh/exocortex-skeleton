"""Tests for scripts/stage_change.py -- the narrow door any agent uses to
propose a change into the pending approval queue (routes/pending.py) without
writing data files directly.

Mirrors conftest.py's "isolated data, always" rule: every test depends on
`data_dir` (directly, or transitively via the subprocess smoke test's own
tmp_path). All but the last test call the module's functions directly
(imported, not subprocess) -- same pattern test_claude_transcripts.py uses
for scripts/claude_transcripts.py. The last test drives the actual CLI
entry point via subprocess with --data-dir, to prove argv parsing and the
stdout/stderr JSON contract work end to end outside the test harness.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

import store
from scripts import stage_change


SCRIPT_PATH = Path(stage_change.__file__).resolve()


def _pending():
    return store.read("pending_changes", {"pending": []})["pending"]


def test_stages_valid_profile_change(data_dir):
    entry = stage_change.stage_change("profile", {"owner_name": "Bradie"})
    assert entry["kind"] == "profile"
    assert entry["payload"] == {"owner_name": "Bradie"}
    assert isinstance(entry["id"], str) and entry["id"]
    assert _pending() == [entry]


def test_rejects_unknown_kind(data_dir):
    with pytest.raises(stage_change.StageError) as exc_info:
        stage_change.stage_change("delete_everything", {})
    msg = str(exc_info.value)
    assert "delete_everything" in msg
    for kind in stage_change.KNOWN_KINDS:
        assert kind in msg  # the "fail loudly, list valid kinds" contract
    assert _pending() == []


def test_rejects_non_object_payload(data_dir):
    with pytest.raises(stage_change.StageError):
        stage_change.stage_change("todo", ["not", "an", "object"])
    assert _pending() == []


def test_rejects_profile_payload_with_bad_email(data_dir):
    with pytest.raises(stage_change.StageError) as exc_info:
        stage_change.stage_change("profile", {"owner_email": "not-an-email"})
    msg = str(exc_info.value)
    assert "owner_email" in msg  # the schema violation text (json path) surfaces
    assert _pending() == []


def test_rejects_profile_payload_with_unknown_key(data_dir):
    with pytest.raises(stage_change.StageError) as exc_info:
        stage_change.stage_change("profile", {"owner_name": "Bradie", "is_admin": True})
    assert "is_admin" in str(exc_info.value)
    assert _pending() == []


def test_queue_accumulates_across_two_stages(data_dir):
    stage_change.stage_change("profile", {"owner_name": "A"})
    stage_change.stage_change("todo", {"text": "water plants", "theme": "home"})
    pending = _pending()
    assert len(pending) == 2
    assert {p["kind"] for p in pending} == {"profile", "todo"}


def test_cli_smoke_via_subprocess(tmp_path):
    """End-to-end check of the actual entry point: --data-dir, argv parsing,
    and the stdout JSON contract -- everything above imports the module
    in-process against the monkeypatched data_dir fixture instead."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "profile",
         json.dumps({"owner_name": "Bradie"}), "--data-dir", str(tmp_path)],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip())
    assert out == {"staged": True, "id": out["id"], "kind": "profile"}

    stored = json.loads((tmp_path / "pending_changes.json").read_text())
    assert len(stored["pending"]) == 1
    assert stored["pending"][0]["id"] == out["id"]
    assert stored["pending"][0]["payload"] == {"owner_name": "Bradie"}


def test_cli_smoke_reports_failure_on_stderr(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "not_a_real_kind", "{}",
         "--data-dir", str(tmp_path)],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode != 0
    err = json.loads(result.stderr.strip())
    assert "not_a_real_kind" in err["error"]
