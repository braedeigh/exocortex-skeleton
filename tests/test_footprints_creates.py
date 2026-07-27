"""The footprint extractor's `creates` detection (scripts/extract_footprints.py).

A file the agent WROTE into existence fresh is distinguished from one it merely
overwrote/edited by the Write tool_RESULT line — "File created successfully at:
<path>" for a new file vs. "The file <path> has been updated" for an overwrite.
Terrain rings a created file green while its agent is active, so this is the
seam that must not silently break. Pure-data layer: build a fake conversation
jsonl and harvest it, no store/routes involved.
"""
import json

from scripts.extract_footprints import harvest_conversation


def _assistant_tool_use(name, tool_id, **inp):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tool_id, "name": name, "input": inp},
    ]}}


def _tool_result(tool_id, text):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tool_id, "content": text},
    ]}}


def _write_jsonl(path, events):
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")


def test_write_to_new_path_counts_as_created(tmp_path):
    new_file = tmp_path / "brand_new.ts"
    log = tmp_path / "conv.jsonl"
    _write_jsonl(log, [
        _assistant_tool_use("Write", "t1", file_path=str(new_file), content="x"),
        _tool_result("t1", f"File created successfully at: {new_file} "
                           "(file state is current in your context)"),
    ])
    files = harvest_conversation(str(log), str(tmp_path))
    entry = files[str(new_file)]
    assert entry["creates"] == 1
    assert entry["writes"] == 1   # a create is always a write too
    assert entry["reads"] == 0


def test_overwrite_is_a_write_not_a_create(tmp_path):
    existing = tmp_path / "existing.ts"
    existing.write_text("old", encoding="utf-8")
    log = tmp_path / "conv.jsonl"
    _write_jsonl(log, [
        _assistant_tool_use("Write", "t1", file_path=str(existing), content="new"),
        _tool_result("t1", f"The file {existing} has been updated successfully. "
                           "(file state is current in your context)"),
    ])
    files = harvest_conversation(str(log), str(tmp_path))
    entry = files[str(existing)]
    assert entry["creates"] == 0
    assert entry["writes"] == 1


def test_edit_of_existing_file_never_creates(tmp_path):
    existing = tmp_path / "existing.ts"
    existing.write_text("old", encoding="utf-8")
    log = tmp_path / "conv.jsonl"
    _write_jsonl(log, [
        _assistant_tool_use("Edit", "t1", file_path=str(existing),
                            old_string="old", new_string="new"),
        _tool_result("t1", f"The file {existing} has been updated successfully."),
    ])
    files = harvest_conversation(str(log), str(tmp_path))
    assert files[str(existing)]["creates"] == 0
    assert files[str(existing)]["writes"] == 1


def test_created_path_survives_list_shaped_result_content(tmp_path):
    """Some CC versions wrap the result text in a content-block list rather
    than a bare string — the marker must still be found."""
    new_file = tmp_path / "made.py"
    log = tmp_path / "conv.jsonl"
    _write_jsonl(log, [
        _assistant_tool_use("Write", "t1", file_path=str(new_file), content="x"),
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": [
                {"type": "text", "text": f"File created successfully at: {new_file}"},
            ]},
        ]}},
    ])
    files = harvest_conversation(str(log), str(tmp_path))
    assert files[str(new_file)]["creates"] == 1
