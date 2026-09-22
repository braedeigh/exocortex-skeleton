"""The uploads listing the terrain payload carries for the spiral coil.

`_uploads_listing` is the one thing standing between the coil and an empty
map: the archive's files never survive the payload's hottest-N cut (their git
heat is bulk-commit noise), so this listing is the ONLY place the coil's dots
come from. It is also the only place that says WHERE the archive is, since
EXOCORTEX_UPLOAD_ARCHIVE_DIR can move it — a prefix that doesn't match the
repo-relative paths in `files` would leave the client scanning for a folder
that, as far as it can tell, isn't there.

Both of those fail silently and look like "no uploads this month", so they're
pinned here.
"""
import pytest

import store
from routes import terrain


@pytest.fixture
def archive(data_dir, monkeypatch, tmp_path):
    """An uploads archive inside a fake repo root, with the terrain repos
    pointed at it — so relative_to finds it the way it finds the real one."""
    root = tmp_path / "vault"
    folder = root / "data" / "uploads-archive"
    folder.mkdir(parents=True)
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", folder)
    monkeypatch.setattr(terrain.observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": tmp_path / "skeleton"},
        {"id": "vault", "name": "Personal vault", "root": root},
    ))
    return folder


def test_lists_every_file_repo_relative(archive):
    for name in ("20260920_140908.png", "20260919_173846.jpeg", "20260101_000000_paste.txt"):
        (archive / name).write_bytes(b"x")

    listing = terrain._uploads_listing()

    assert listing["repo"] == "vault"
    assert listing["prefix"] == "data/uploads-archive/"
    # Repo-relative, matching the shape of `repos[].files[].path` — the client
    # matches the two against each other.
    assert set(listing["paths"]) == {
        "data/uploads-archive/20260920_140908.png",
        "data/uploads-archive/20260919_173846.jpeg",
        "data/uploads-archive/20260101_000000_paste.txt",
    }


def test_is_not_capped_the_way_files_are(archive):
    """The whole point. The payload's own file list would keep none of these."""
    for i in range(400):
        (archive / f"202603{i % 28 + 1:02d}_12{i % 60:02d}00_{i}.png").write_bytes(b"x")

    listing = terrain._uploads_listing()

    assert len(listing["paths"]) == 400


def test_follows_the_archive_when_the_install_moves_it(archive, monkeypatch, tmp_path):
    """EXOCORTEX_UPLOAD_ARCHIVE_DIR can put the folder anywhere in the vault;
    the prefix has to follow it, because the client is told rather than
    assuming."""
    moved = archive.parent.parent / "elsewhere" / "shots"
    moved.mkdir(parents=True)
    (moved / "20260920_140908.png").write_bytes(b"x")
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", moved)

    listing = terrain._uploads_listing()

    assert listing["prefix"] == "elsewhere/shots/"
    assert listing["paths"] == ["elsewhere/shots/20260920_140908.png"]


def test_ignores_subfolders(archive):
    (archive / "20260920_140908.png").write_bytes(b"x")
    (archive / "old").mkdir()
    (archive / "old" / "20260101_000000.png").write_bytes(b"x")

    listing = terrain._uploads_listing()

    assert listing["paths"] == ["data/uploads-archive/20260920_140908.png"]


def test_says_nothing_rather_than_guessing_when_there_is_no_archive(
    data_dir, monkeypatch, tmp_path
):
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", tmp_path / "never-made")

    assert terrain._uploads_listing() is None


def test_says_nothing_when_the_archive_is_outside_every_repo(
    data_dir, monkeypatch, tmp_path
):
    """A detached data dir has no coil — which is honest, and better than
    inventing a repo to hang it off."""
    outside = tmp_path / "elsewhere" / "uploads-archive"
    outside.mkdir(parents=True)
    (outside / "20260920_140908.png").write_bytes(b"x")
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", outside)
    monkeypatch.setattr(terrain.observatory, "_terrain_repos", lambda: (
        {"id": "vault", "name": "Personal vault", "root": tmp_path / "vault"},
    ))

    assert terrain._uploads_listing() is None


def test_keeps_the_newest_at_the_ceiling(archive, monkeypatch):
    """Past the ceiling it's the OLDEST that get dropped — the coil is read
    from its newest dot outward, so that's the end that can be spared."""
    monkeypatch.setattr(terrain, "_UPLOAD_LIST_MAX", 3)
    for day in (1, 2, 3, 4, 5):
        (archive / f"2026032{day}_120000.png").write_bytes(b"x")

    listing = terrain._uploads_listing()

    assert listing["paths"] == [
        "data/uploads-archive/20260325_120000.png",
        "data/uploads-archive/20260324_120000.png",
        "data/uploads-archive/20260323_120000.png",
    ]
