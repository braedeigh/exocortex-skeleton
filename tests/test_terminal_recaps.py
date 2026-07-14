"""Transcript-parsing helpers behind /api/terminal/recaps (routes/terminal.py).

These parse Claude Code's *internal* transcript JSONL, which can change shape
between releases — the contract under test is: extract the freshest recap
when the format is recognised, and return nothing (so the route degrades to
its visible error message) when it isn't.
"""
import json

from routes.terminal import _clean_recap, _extract_recap, RECAP_MAX_CHARS


def _assistant(text, **extra):
    return json.dumps({"message": {"role": "assistant",
                                   "content": [{"type": "text", "text": text}]}, **extra})


def _compact(text):
    return json.dumps({"message": {"role": "user", "content": text}})


COMPACT = ("This session is being continued from a previous conversation that ran "
           "out of context. The summary below covers the earlier portion.\n\n"
           "Summary:\n1. Primary Request and Intent:\n   Build the thing.")


def test_last_assistant_message_wins_over_earlier_compact():
    text, source = _extract_recap([_compact(COMPACT), _assistant("older"), _assistant("newest")])
    assert (text, source) == ("newest", "assistant")


def test_compact_recap_wins_when_it_is_last():
    text, source = _extract_recap([_assistant("older"), _compact(COMPACT)])
    assert source == "compact"
    assert text.startswith("This session is being continued")


def test_sidechain_messages_are_ignored():
    lines = [_assistant("main"), _assistant("subagent", isSidechain=True)]
    assert _extract_recap(lines) == ("main", "assistant")


def test_ordinary_user_messages_are_not_recaps():
    lines = [json.dumps({"message": {"role": "user", "content": "hey claude"}})]
    assert _extract_recap(lines) == (None, None)


def test_unrecognised_format_yields_nothing():
    # Malformed JSON, non-dict lines, and shapes with no message all degrade
    # to (None, None) — the route turns that into its visible error string.
    lines = ["not json{", json.dumps(["list"]), json.dumps({"type": "file-history-snapshot"})]
    assert _extract_recap(lines) == (None, None)


def test_clean_recap_strips_compact_boilerplate_and_flattens():
    cleaned = _clean_recap(COMPACT, "compact")
    assert cleaned.startswith("1. Primary Request and Intent:")
    assert "\n" not in cleaned


def test_clean_recap_truncates_long_text():
    cleaned = _clean_recap("x" * 1000, "assistant")
    assert len(cleaned) <= RECAP_MAX_CHARS
    assert cleaned.endswith("…")
