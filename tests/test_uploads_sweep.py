"""Terminal uploads are transient: sweep_uploads deletes them after 24h."""
import os
import time

import data_helpers


def test_sweep_removes_only_files_older_than_cutoff(tmp_path):
    old = tmp_path / "20260326_old_paste.txt"
    old.write_text("stale")
    fresh = tmp_path / "20260612_fresh.png"
    fresh.write_text("keep me")
    past = time.time() - 25 * 3600
    os.utime(old, (past, past))

    removed = data_helpers.sweep_uploads(upload_dir=tmp_path)

    assert removed == 1
    assert not old.exists()
    assert fresh.exists()


def test_sweep_on_missing_dir_is_a_noop():
    assert data_helpers.sweep_uploads(upload_dir="/nonexistent/uploads") == 0


def test_sweep_respects_custom_age(tmp_path):
    f = tmp_path / "two_hours_old.txt"
    f.write_text("x")
    past = time.time() - 2 * 3600
    os.utime(f, (past, past))

    assert data_helpers.sweep_uploads(max_age_hours=24, upload_dir=tmp_path) == 0
    assert f.exists()
    assert data_helpers.sweep_uploads(max_age_hours=1, upload_dir=tmp_path) == 1
    assert not f.exists()
