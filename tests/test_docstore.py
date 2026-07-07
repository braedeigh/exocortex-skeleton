"""docstore: the doc-id namespace seam under the annotation layer."""
import pytest

from conftest import data_dir  # noqa: F401

import docstore


@pytest.fixture
def research_dir(tmp_path, monkeypatch):
    import store
    root = tmp_path / "research"
    root.mkdir()
    monkeypatch.setattr(store, "RESEARCH_DIR", root)
    return root


def test_entry_text_round_trip(data_dir):
    docstore.save_entry_text("2026-07-06.2151", "extracted paper text")
    r = docstore.resolve("entry:2026-07-06.2151")
    assert r == {"ok": True, "text": "extracted paper text", "title": ""}
    assert docstore.has_text("entry:2026-07-06.2151") is True


def test_entry_id_is_sanitized_into_a_safe_filename(data_dir):
    docstore.save_entry_text("weird/../id", "x")
    files = list(docstore._texts_dir().iterdir())
    assert len(files) == 1
    # Separators are flattened, so the file cannot escape doc_texts/.
    assert "/" not in files[0].name
    assert files[0].parent == docstore._texts_dir()
    assert docstore.resolve("entry:weird/../id")["ok"] is True


def test_entry_missing_is_not_found(data_dir):
    assert docstore.resolve("entry:nope") == {"ok": False, "error": "not_found"}
    assert docstore.has_text("entry:nope") is False


def test_note_resolves_with_title(data_dir, research_dir):
    (research_dir / "wearables.md").write_text("# Wearables\n\nbody text")
    r = docstore.resolve("note:wearables.md")
    assert r["ok"] is True
    assert r["title"] == "Wearables"
    assert "body text" in r["text"]


def test_note_traversal_is_blocked(data_dir, research_dir):
    (research_dir.parent / "secret.md").write_text("nope")
    r = docstore.resolve("note:../secret.md")
    assert r == {"ok": False, "error": "bad_path"}


def test_note_non_md_is_blocked(data_dir, research_dir):
    (research_dir / "raw.txt").write_text("x")
    assert docstore.resolve("note:raw.txt") == {"ok": False, "error": "bad_path"}


def test_unknown_namespace(data_dir):
    assert docstore.resolve("journal:2026/07/06.md") == {"ok": False, "error": "unknown_namespace"}
    assert docstore.resolve("") == {"ok": False, "error": "unknown_namespace"}
