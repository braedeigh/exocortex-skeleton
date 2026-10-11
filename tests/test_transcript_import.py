"""transcript_import.py — ChatGPT and Claude.ai exports into one shape.

The samples in tests/fixtures/transcripts/ are MADE UP, shaped like the real
exports (see the format notes at the top of transcript_import.py). Each one
carries the awkward cases: ChatGPT's branch left behind by a regenerate, a
hidden system message, an image part, a reasoning block; Claude.ai's text
living only in content blocks, and an attachment.
"""
import json
import zipfile
from pathlib import Path

import pytest

import transcript_import as ti

FIXTURES = Path(__file__).parent / "fixtures" / "transcripts"
CHATGPT = FIXTURES / "chatgpt_conversations.json"
CLAUDE = FIXTURES / "claude_conversations.json"


def _by_id(conversations):
    return {c["source_id"]: c for c in conversations}


def test_chatgpt_reads_only_the_branch_the_user_last_saw():
    chat = _by_id(ti.read_export(CHATGPT))["cg-1"]
    texts = [m["text"] for m in chat["messages"]]
    assert texts == ["[image]\nWhy is my starter not rising?",
                     "It is probably too cold. Try a warmer spot."]


def test_chatgpt_keeps_roles_and_unix_times():
    chat = _by_id(ti.read_export(CHATGPT))["cg-1"]
    assert [(m["role"], m["at"]) for m in chat["messages"]] == [
        ("user", 1719830010.0), ("assistant", 1719830040.0)]
    assert chat["title"] == "Sourdough starter help" and chat["source"] == "chatgpt"


def test_chatgpt_without_current_node_falls_back_to_time_order_and_reads_code():
    chat = _by_id(ti.read_export(CHATGPT))["cg-3"]
    assert [m["text"] for m in chat["messages"]] == [
        "How do I sort a list of dicts by a key?", "sorted(items, key=lambda d: d['k'])"]


def test_a_conversation_with_no_readable_messages_is_dropped():
    assert "cg-2" not in _by_id(ti.read_export(CHATGPT))


def test_claude_reads_text_blocks_when_text_is_empty_and_skips_thinking():
    chat = _by_id(ti.read_export(CLAUDE))["cl-1"]
    assert chat["messages"][1] == {"role": "assistant", "text": "Hostas and ferns do well in shade.",
                                   "at": pytest.approx(1719932415.0)}


def test_claude_names_attachments_without_inlining_them():
    chat = _by_id(ti.read_export(CLAUDE))["cl-1"]
    assert chat["messages"][2]["text"] == "Here is my soil test.\n[attached: soil.txt]"
    assert "pH" not in chat["messages"][2]["text"]


def test_claude_maps_human_to_user_and_parses_iso_times():
    chat = _by_id(ti.read_export(CLAUDE))["cl-1"]
    assert chat["messages"][0]["role"] == "user"
    assert chat["created_at"] == pytest.approx(1719932400.0)
    assert chat["title"] == "Planning a garden bed" and chat["source"] == "claude"


def test_an_export_zip_is_read_from_the_conversations_file_inside_it(tmp_path):
    archive = tmp_path / "export.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.write(CLAUDE, "conversations.json")
        z.writestr("users.json", "[]")
    assert set(_by_id(ti.read_export(archive))) == {"cl-1"}


def test_a_zip_without_conversations_is_refused(tmp_path):
    archive = tmp_path / "other.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("photo.jpg", "x")
    with pytest.raises(ti.ImportFormatError):
        ti.read_export(archive)


def test_a_file_of_some_other_shape_is_refused(tmp_path):
    other = tmp_path / "conversations.json"
    other.write_text(json.dumps([{"hello": "world"}]))
    with pytest.raises(ti.ImportFormatError):
        ti.read_export(other)


def test_not_json_is_refused(tmp_path):
    bad = tmp_path / "conversations.json"
    bad.write_text("not json")
    with pytest.raises(ti.ImportFormatError):
        ti.read_export(bad)
