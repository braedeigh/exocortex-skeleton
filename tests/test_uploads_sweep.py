"""Terminal uploads age out of `uploads/` after 24h and are FILED into the
uploads archive. Nothing here is ever deleted.

The sweep used to unlink, and these tests used to assert that it did. The
premise underneath it — "anything worth keeping gets moved out by whoever
consumed it" — was false: nothing consumes an upload, so the sweep was the only
thing that ever touched one, and it deleted all of them.

The thing worth knowing when editing this file: every assertion below deliberately
checks BOTH ends — gone from the inbox AND present in the archive. Checking only
that a file left the inbox is exactly the assertion that stayed green while the
old behaviour destroyed things, and it is the assertion a copy-paste will
reintroduce.
"""
import os
import time

import pytest

import data_helpers
import store


def _aged(path, hours):
    """Backdate a file so the sweep sees it as `hours` old."""
    past = time.time() - hours * 3600
    os.utime(path, (past, past))


def test_an_aged_upload_is_filed_not_deleted(tmp_path):
    inbox, archive = tmp_path / "uploads", tmp_path / "archive"
    inbox.mkdir()
    old = inbox / "20260326_232944_IMG_3136.png"
    old.write_text("her photo")
    _aged(old, 25)

    filed = data_helpers.sweep_uploads(inbox, archive)

    assert filed == 1
    assert not old.exists()
    landed = archive / "20260326_232944_IMG_3136.png"
    assert landed.exists()
    assert landed.read_text() == "her photo"   # moved whole, not truncated


def test_a_fresh_upload_is_left_alone(tmp_path):
    inbox, archive = tmp_path / "uploads", tmp_path / "archive"
    inbox.mkdir()
    fresh = inbox / "20260612_fresh.png"
    fresh.write_text("keep me")

    assert data_helpers.sweep_uploads(inbox, archive) == 0
    assert fresh.exists()
    assert not archive.exists()   # nothing to file, so nothing is created


def test_filing_never_clobbers_an_existing_archive_entry(tmp_path):
    """Paste filenames collided before microseconds were added, and an archive
    that loses the older file on a name clash is not an archive."""
    inbox, archive = tmp_path / "uploads", tmp_path / "archive"
    inbox.mkdir()
    archive.mkdir()
    (archive / "20260825_164142_paste.txt").write_text("the first one")
    incoming = inbox / "20260825_164142_paste.txt"
    incoming.write_text("the second one")
    _aged(incoming, 25)

    assert data_helpers.sweep_uploads(inbox, archive) == 1
    assert (archive / "20260825_164142_paste.txt").read_text() == "the first one"
    assert (archive / "20260825_164142_paste-2.txt").read_text() == "the second one"


def test_a_file_that_cannot_be_filed_stays_in_the_inbox(tmp_path):
    """The safe direction. A failed move loses nothing; a failed unlink already had."""
    inbox = tmp_path / "uploads"
    inbox.mkdir()
    blocked = tmp_path / "archive"
    blocked.write_text("not a directory")   # mkdir() over a file raises OSError
    old = inbox / "old.png"
    old.write_text("still here")
    _aged(old, 25)

    assert data_helpers.sweep_uploads(inbox, blocked) == 0
    assert old.exists()
    assert old.read_text() == "still here"


def test_sweep_on_missing_inbox_is_a_noop(tmp_path):
    assert data_helpers.sweep_uploads("/nonexistent/uploads", tmp_path / "archive") == 0


def test_sweep_respects_custom_age(tmp_path):
    inbox, archive = tmp_path / "uploads", tmp_path / "archive"
    inbox.mkdir()
    f = inbox / "two_hours_old.txt"
    f.write_text("x")
    _aged(f, 2)

    assert data_helpers.sweep_uploads(inbox, archive, max_age_hours=24) == 0
    assert f.exists()
    assert data_helpers.sweep_uploads(inbox, archive, max_age_hours=1) == 1
    assert not f.exists()
    assert (archive / "two_hours_old.txt").exists()


def test_the_destination_cannot_be_left_unsaid(tmp_path):
    """Both roots are required ON PURPOSE — see sweep_uploads' docstring.

    With a default archive, a test passing only an inbox would file its fixtures
    into the real one and still pass every assertion, because "the file left the
    inbox" stays true. This test exists so that guarantee is checked, not assumed.
    """
    with pytest.raises(TypeError):
        data_helpers.sweep_uploads(tmp_path)


def test_the_throttled_door_files_into_the_live_roots(data_dir, monkeypatch):
    """The one place the real roots get resolved — and it resolves them at call
    time, so the data_dir fixture's re-pointing is honoured."""
    monkeypatch.setattr(data_helpers, "_last_upload_sweep", 0.0)
    store.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    old = store.UPLOAD_DIR / "aged.png"
    old.write_text("photo")
    _aged(old, 25)

    assert data_helpers.sweep_uploads_throttled() == 1
    assert not old.exists()
    assert (store.UPLOAD_ARCHIVE_DIR / "aged.png").read_text() == "photo"


def test_the_throttle_holds_for_an_hour(data_dir, monkeypatch):
    monkeypatch.setattr(data_helpers, "_last_upload_sweep", 0.0)
    store.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    first = store.UPLOAD_DIR / "first.png"
    first.write_text("x")
    _aged(first, 25)
    assert data_helpers.sweep_uploads_throttled() == 1

    second = store.UPLOAD_DIR / "second.png"
    second.write_text("y")
    _aged(second, 25)

    assert data_helpers.sweep_uploads_throttled() == 0   # inside the hour
    assert second.exists()
