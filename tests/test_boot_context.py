"""The Keeper's boot package (scripts/boot_context.py).

Each test builds a tiny fake vault in tmp_path and points the store at it, so
nothing here reads real journal files.
"""
import json
from datetime import date

import pytest

import store
from scripts import boot_context


@pytest.fixture
def vault(data_dir, tmp_path, monkeypatch):
    content = tmp_path / "content"
    (content / "Journal" / "Daily").mkdir(parents=True)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    return content


def _manifest(data_dir, manifest):
    (data_dir / "keeper_boot.json").write_text(json.dumps(manifest))


def test_named_files_come_in_manifest_order(vault, data_dir):
    (vault / "A.md").write_text("alpha rules")
    (vault / "B.md").write_text("beta rules")
    _manifest(data_dir, {"sections": [{"title": "Rules", "files": ["B.md", "A.md"]}]})
    out = boot_context.build(date(2026, 9, 25))
    assert out.index("beta rules") < out.index("alpha rules")


def test_last_n_takes_the_newest_files_oldest_first(vault, data_dir):
    daily = vault / "Journal" / "Daily"
    for day in ("2026-09-20", "2026-09-21", "2026-09-22"):
        (daily / f"{day}.md").write_text(f"entry {day}")
    _manifest(data_dir, {"sections": [{"dir": "Journal/Daily", "glob": "*.md", "last": 2}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "entry 2026-09-20" not in out
    assert out.index("entry 2026-09-21") < out.index("entry 2026-09-22")


def test_numbered_names_sort_as_numbers(vault, data_dir):
    diary = vault / "diary"
    diary.mkdir()
    (diary / "99-old.md").write_text("old keeper")
    (diary / "205-new.md").write_text("new keeper")
    _manifest(data_dir, {"sections": [{"dir": "diary", "glob": "[0-9]*.md", "last": 1}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "new keeper" in out and "old keeper" not in out


def test_long_files_are_cut_with_a_pointer_to_the_rest(vault, data_dir):
    (vault / "Big.md").write_text("x" * 500)
    _manifest(data_dir, {"sections": [{"files": ["Big.md"], "max_chars": 100}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "cut at 100 characters" in out
    assert "x" * 101 not in out


def test_weekday_sections_only_appear_on_their_day(vault, data_dir):
    (vault / "SUNDAY.md").write_text("sunday passes")
    _manifest(data_dir, {"sections": [{"files": ["SUNDAY.md"], "weekday": "sunday"}]})
    assert "sunday passes" not in boot_context.build(date(2026, 9, 25))   # a Friday
    assert "sunday passes" in boot_context.build(date(2026, 9, 27))       # a Sunday


def test_missing_file_is_named_not_dropped(vault, data_dir):
    _manifest(data_dir, {"sections": [{"files": ["Nope.md"]}]})
    out = boot_context.build(date(2026, 9, 25))
    assert "Nope.md" in out and "missing" in out


def test_no_manifest_falls_back_to_the_default_and_says_so(vault, data_dir):
    (vault / "CLAUDE.md").write_text("seed keeper")
    out = boot_context.build(date(2026, 9, 25))
    assert "seed keeper" in out and "built-in default" in out


def test_broken_manifest_falls_back_instead_of_crashing(vault, data_dir):
    (data_dir / "keeper_boot.json").write_text("{not json")
    out = boot_context.build(date(2026, 9, 25))
    assert "unreadable" in out


def test_package_says_the_keeper_may_read_beyond_it(vault, data_dir):
    out = boot_context.build(date(2026, 9, 25))
    assert "not your" in out and "boundary" in out


def test_coming_up_is_the_last_section(vault, data_dir):
    import comingup
    comingup.add_item({"title": "Festival", "date": "2026-10-02"}, "manual")
    (vault / "CLAUDE.md").write_text("rules")
    out = boot_context.build(date(2026, 9, 25))
    assert out.rindex("## Coming up") > out.index("rules")
    assert "Festival" in out


def test_manifest_root_is_relative_to_the_data_dir(data_dir, tmp_path, monkeypatch):
    elsewhere = tmp_path / "vault-content"
    elsewhere.mkdir()
    (elsewhere / "R.md").write_text("rooted file")
    monkeypatch.setattr(store, "CONTENT_DIR", tmp_path / "wrong")
    _manifest(data_dir, {"root": "vault-content", "sections": [{"files": ["R.md"]}]})
    # data_dir IS tmp_path here, so root "vault-content" resolves beside it
    assert "rooted file" in boot_context.build(date(2026, 9, 25))
