"""The commons: where its folder resolves, and the fetch door's promises.

The promises worth guarding are the ones that would fail silently: a file
overwritten by a different one of the same name, the same bytes filed twice,
an over-limit file slipping in and blocking every backup push, and a checksum
that no longer matches going unnoticed.
"""
import json

import pytest

import commons
from scripts import commons_fetch


@pytest.fixture
def root(tmp_path, monkeypatch):
    commons_root = tmp_path / "commons"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(commons_root))
    return commons_root


def _file(tmp_path, name, body):
    path = tmp_path / name
    path.write_bytes(body)
    return path


def test_commons_dir_prefers_env_then_setting_then_default(data_dir, tmp_path, monkeypatch):
    monkeypatch.delenv("EXOCORTEX_COMMONS_DIR", raising=False)
    assert commons.commons_dir() == data_dir / "commons"
    (data_dir / "commons.json").write_text(json.dumps({"dir": str(tmp_path / "set")}))
    assert commons.commons_dir() == tmp_path / "set"
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(tmp_path / "env"))
    assert commons.commons_dir() == tmp_path / "env"


def test_add_file_records_source_and_checksum(root, tmp_path):
    status, entry = commons_fetch.add_file(
        _file(tmp_path, "pdp 2023.zip", b"rows"), "usda-pdp", {"title": "PDP", "year": "2023"})
    assert status == "added"
    assert (root / "usda-pdp" / "pdp_2023.zip").read_bytes() == b"rows"
    [listed] = commons.read_manifest()["files"]
    assert listed == entry and listed["sha256"] == commons.sha256_of(root / entry["path"])
    assert listed["year"] == "2023" and "note" not in listed


def test_same_bytes_are_not_filed_twice(root, tmp_path):
    commons_fetch.add_file(_file(tmp_path, "a.pdf", b"same"), "epa", {})
    status, _ = commons_fetch.add_file(_file(tmp_path, "b.pdf", b"same"), "epa", {})
    assert status == "already"
    assert len(commons.read_manifest()["files"]) == 1


def test_different_file_with_same_name_is_refused(root, tmp_path):
    commons_fetch.add_file(_file(tmp_path, "a.pdf", b"one"), "epa", {})
    (tmp_path / "again").mkdir()
    with pytest.raises(FileExistsError):
        commons_fetch.add_file(_file(tmp_path / "again", "a.pdf", b"two"), "epa", {})
    assert (root / "epa" / "a.pdf").read_bytes() == b"one"


def test_over_limit_file_is_refused(root, tmp_path, monkeypatch):
    monkeypatch.setattr(commons, "MAX_FILE_BYTES", 3)
    with pytest.raises(commons_fetch.TooBig):
        commons_fetch.add_file(_file(tmp_path, "big.zip", b"toolong"), "usda-pdp", {})
    assert commons.read_manifest()["files"] == []


def test_download_streams_file_into_commons(root, tmp_path):
    source = _file(tmp_path, "tds.pdf", b"%PDF-")
    assert commons_fetch.main([source.as_uri(), "--source", "fda-tds"]) == 0
    [entry] = commons.read_manifest()["files"]
    assert entry["path"] == "fda-tds/tds.pdf" and entry["url"] == source.as_uri()
    assert not list((root / "fda-tds").glob(".fetch-*"))


def test_verify_reports_changed_and_missing_files(root, tmp_path):
    commons_fetch.add_file(_file(tmp_path, "a.pdf", b"one"), "epa", {})
    commons_fetch.add_file(_file(tmp_path, "b.pdf", b"two"), "epa", {})
    assert commons.verify() == []
    (root / "epa" / "a.pdf").write_bytes(b"tampered")
    (root / "epa" / "b.pdf").unlink()
    assert sorted(commons.verify()) == [("epa/a.pdf", "checksum changed"), ("epa/b.pdf", "missing")]


def test_outside_git_file_is_filed_and_ignored_by_git(root, tmp_path, monkeypatch):
    monkeypatch.setattr(commons, "MAX_FILE_BYTES", 3)
    status, entry = commons_fetch.add_file(_file(tmp_path, "big.zip", b"toolong"), "usda-fdc", {},
                                           outside_git=True)
    assert (status, entry["in_git"], (root / ".gitignore").read_text().splitlines()[-1]) == (
        "added", False, "usda-fdc/big.zip")
