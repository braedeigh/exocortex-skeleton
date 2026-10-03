"""Bringing the old brief folders into the database (scripts/import_spinoff_briefs.py).

What these pin: every brief, context and handoff file in the live folder and
the archive ends up in the database word for word, tied to its session; the
session's entry is told which row is its brief, so its instructions still
reach it once the folder is gone; running it twice adds nothing; and no file
is moved or deleted.
"""
import pytest

import briefstore
import store
from routes import observatory
from scripts import import_spinoff_briefs as importer


@pytest.fixture
def folders(data_dir, monkeypatch):
    monkeypatch.setattr(store, "SPINOFF_DIR", data_dir / "spinoffs")
    monkeypatch.setattr(store, "SPINOFF_ARCHIVE_DIR", data_dir / "spinoff_archive")
    monkeypatch.delenv("EXOCORTEX_CONV_ID", raising=False)

    def folder(root, slug):
        path = root / slug
        path.mkdir(parents=True)
        return path

    live = folder(store.SPINOFF_DIR, "pond-colour")
    (live / "BRIEF.md").write_text("# Spinoff: paint the pond\n")
    (live / "CONTEXT.md").write_text(
        "## Protocol\n\n## Preloaded files (snapshot)\n\n### /repo/pond.py\n```\nBLUE = 1\n```\n")
    (live / "HANDOFF.md").write_text("Goal: blue. Left: the water.\n")
    (live / "notes.py").write_text("x = 1\n")
    filed = folder(store.SPINOFF_ARCHIVE_DIR, "old-job")
    (filed / "BRIEF.md").write_text("# Spinoff: an old job\n")
    (store.SPINOFF_DIR / ".kickoffs").mkdir()
    (store.SPINOFF_DIR / ".kickoffs" / "x.log").write_text("")
    observatory._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        index["2026-09-01.100000"] = {"title": "sender"}
        index["2026-09-01.110000"] = {
            "title": "spin: pond-colour", "spinoff_slug": "pond-colour",
            "started": "2026-09-01T11:00:00", "spawned_from": "2026-09-01.100000",
            "spawned_via": "skill",
            "system_prompt_file": str(live / "CONTEXT.md")}
    return live, filed


def test_every_file_lands_in_the_database_tied_to_its_session(folders):
    live, filed = folders
    counts = importer.run_import()
    assert (counts["briefs"], counts["contexts"], counts["handoffs"]) == (2, 1, 1)

    brief = briefstore.for_session("2026-09-01.110000")
    assert brief["body"] == "# Spinoff: paint the pond\n" and brief["slug"] == "pond-colour"
    assert brief["written_by"] == "2026-09-01.100000" and brief["preloaded"] == ["/repo/pond.py"]
    assert "BLUE = 1" in briefstore.context(brief["id"])
    assert briefstore.latest("old-job")["conv"] is None        # no session known: still kept

    matched, wrong, other = importer.check()
    assert (matched, wrong) == (4, []) and other == [str(live / "notes.py")]
    # Nothing was moved or deleted.
    assert (live / "BRIEF.md").exists() and (filed / "BRIEF.md").exists()


def test_a_second_run_adds_nothing(folders):
    importer.run_import()
    again = importer.run_import()
    assert (again["briefs"], again["contexts"], again["handoffs"], again["stamped"]) == (0, 0, 0, 0)
    assert len(briefstore.listing()) == 2


def test_a_session_whose_folder_is_removed_still_gets_its_instructions(folders, monkeypatch):
    """The point of the import for sessions that are still open: delete the
    folder, and the next turn is handed the same context from the database."""
    import shutil
    live, _ = folders
    importer.run_import()
    shutil.rmtree(live)
    started = []
    monkeypatch.setattr(observatory, "_mem_available_mb", lambda: None)
    monkeypatch.setattr(observatory, "_spawn_host",
                        lambda config, text, resume_sid, conv, log_path:
                        started.append(config) or True)
    assert observatory.begin_turn("2026-09-01.110000", "carry on")["ok"]
    assert "BLUE = 1" in open(started[0]["system_prompt_file"]).read()


def test_the_check_names_a_file_the_database_does_not_hold(folders):
    live, _ = folders
    importer.run_import()
    (live / "HANDOFF-2.md").write_text("written after the import\n")
    assert importer.check()[1] == [str(live / "HANDOFF-2.md")]
