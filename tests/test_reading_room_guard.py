"""Doc-protection guard (routes/reading_room.py).

The guard denies a write-capable, app-spawned session (builder / spinoff) the
file-writing tools on the hand-curated identity docs — the seed scaffold, the
project CLAUDE.md, persona lore, vault doctrine — by handing the turn a
`permissions.deny` block via `claude --settings`. It binds to the SESSION TYPE
(has-write-tools + not opted out), never to the files themselves, so the
owner's own direct vault terminal is untouched. These tests pin the two store
roots and assert the resolved deny rules and the _build_cmd wiring.
"""
import json

import pytest

import store
from routes import reading_room as rr


@pytest.fixture
def roots(monkeypatch, tmp_path):
    """Pin the two roots the guard resolves from: the skeleton checkout
    (store.BUILD_DIR) and the vault root (store.CONTENT_DIR's parent)."""
    build = tmp_path / "skeleton"
    vault = tmp_path / "vault"
    monkeypatch.setattr(store, "BUILD_DIR", build)
    monkeypatch.setattr(store, "CONTENT_DIR", vault / "tulku")
    return build, vault


def test_protected_globs_cover_both_roots(roots):
    build, vault = roots
    globs = rr._protected_doc_globs()
    for root in (build, vault):
        assert f"{root}/content-scaffold/**" in globs
        assert f"{root}/claude-commands/**" in globs
        assert str(root / "CLAUDE.md") in globs
        assert str(root / "docs" / "BEDROCK.md") in globs


def test_deny_rules_are_absolute_and_per_write_tool(roots):
    build, _ = roots
    deny = json.loads(rr._guard_settings_json())["permissions"]["deny"]
    # Every rule is a write tool over a filesystem-absolute path (the // form).
    assert deny and all(r.split("(", 1)[1].startswith("//") for r in deny)
    scaffold = f"{build}/content-scaffold/**"
    for tool in ("Edit", "Write", "NotebookEdit"):
        assert f"{tool}(/{scaffold})" in deny
    # Read/Grep/Bash are never denied — the guard only removes the write verbs.
    assert not any(r.startswith(("Read(", "Grep(", "Bash(")) for r in deny)


def test_build_cmd_guards_a_write_capable_session(roots):
    config = {"allowed_tools": list(rr._BUILDER_TOOLS), "guard_docs": True}
    cmd = rr._build_cmd(config, resume_sid=None)
    assert "--settings" in cmd
    payload = json.loads(cmd[cmd.index("--settings") + 1])
    assert any("content-scaffold" in r for r in payload["permissions"]["deny"])


def test_build_cmd_skips_guard_for_read_only_session(roots):
    # The legacy read-only Keeper trio carries no write tool → nothing to guard.
    config = {"allowed_tools": list(rr._DEFAULT_ALLOWED_TOOLS), "guard_docs": True}
    assert "--settings" not in rr._build_cmd(config, resume_sid=None)


def test_build_cmd_honors_explicit_opt_out(roots):
    # `guard_docs: false` is the deliberate "re-cut a persona through the app"
    # seam — it drops the doc-guard's permissions. The act-vs-ask hook is a
    # SEPARATE safety net (act_gate, default on), so --settings can still carry
    # it; opting out of BOTH is what removes --settings entirely.
    cmd = rr._build_cmd({"allowed_tools": list(rr._BUILDER_TOOLS), "guard_docs": False},
                        resume_sid=None)
    payload = json.loads(cmd[cmd.index("--settings") + 1])
    assert "permissions" not in payload    # doc-guard off...
    assert "hooks" in payload              # ...but the act-gate hook remains
    assert "--settings" not in rr._build_cmd(
        {"allowed_tools": list(rr._BUILDER_TOOLS), "guard_docs": False, "act_gate": False},
        resume_sid=None)


def test_conv_config_defaults_guard_on_and_honors_false():
    # Absent field → guarded (every existing session); only an explicit False disables.
    assert rr._conv_config({"allowed_tools": ["Edit"]})["guard_docs"] is True
    assert rr._conv_config({"allowed_tools": ["Edit"], "guard_docs": False})["guard_docs"] is False
