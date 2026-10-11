"""llm.py — the provider seam: pick a provider, ask it, report sign-in state.

No real CLI is ever run: `subprocess.run` is swapped for a fake, and the
credentials file is a tmp file pointed at through CLAUDE_CONFIG_DIR.
"""
import json
import subprocess
import time

import pytest

import llm


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv(llm.PROVIDER_ENV, raising=False)
    return tmp_path


def _fake_run(stdout="", returncode=0, stderr="", seen=None):
    def run(argv, **kwargs):
        if seen is not None:
            seen.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)
    return run


def test_ask_returns_the_cli_reply_and_sends_the_prompt_on_stdin(claude_home, monkeypatch):
    seen = []
    monkeypatch.setattr(llm.subprocess, "run", _fake_run(" hello \n", seen=seen))
    assert llm.ask("say hi") == "hello"
    argv, kwargs = seen[0]
    assert argv[1:] == ["-p", "--model", "claude-haiku-4-5"] and kwargs["input"] == "say hi"


def test_ask_maps_the_strong_tier_to_a_bigger_model(claude_home, monkeypatch):
    seen = []
    monkeypatch.setattr(llm.subprocess, "run", _fake_run("ok", seen=seen))
    llm.ask("x", tier="strong")
    assert seen[0][0][3] == "claude-sonnet-5"


def test_ask_raises_one_error_type_on_a_failed_exit(claude_home, monkeypatch):
    monkeypatch.setattr(llm.subprocess, "run", _fake_run("", returncode=1, stderr="boom"))
    with pytest.raises(llm.LLMError, match="boom"):
        llm.ask("x")


def test_ask_raises_one_error_type_on_a_timeout(claude_home, monkeypatch):
    def run(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, 1)
    monkeypatch.setattr(llm.subprocess, "run", run)
    with pytest.raises(llm.LLMError):
        llm.ask("x")


def test_status_is_signed_out_with_no_credentials(claude_home):
    assert llm.status() == {"provider": "claude", "signed_in": False, "detail": "not signed in"}


def test_status_is_signed_in_with_a_live_login(claude_home):
    later = (time.time() + 86400) * 1000
    (claude_home / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"refreshTokenExpiresAt": later}}))
    assert llm.status()["signed_in"] is True


def test_status_is_signed_out_once_the_login_expires(claude_home):
    earlier = (time.time() - 60) * 1000
    (claude_home / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"refreshTokenExpiresAt": earlier}}))
    assert llm.status() == {"provider": "claude", "signed_in": False, "detail": "login expired"}


def test_an_unknown_provider_is_reported_not_raised_by_status(claude_home, monkeypatch):
    monkeypatch.setenv(llm.PROVIDER_ENV, "nope")
    assert llm.status()["signed_in"] is False
    with pytest.raises(llm.LLMError):
        llm.ask("x")
