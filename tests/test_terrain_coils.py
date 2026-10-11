"""The coil folders the terrain payload lists for the map's spirals.

`_coil_listings` is the one thing standing between a coil and an empty map:
a bulk-moved folder's files never survive the payload's hottest-N cut (their
git heat is commit noise), so this listing is the ONLY place those dots come
from. It is also the only place that says WHERE each folder is and what clock
its dots run on — a prefix that doesn't match the repo-relative paths in
`files` would leave the client scanning for a folder that, as far as it can
tell, isn't there.

All of that fails silently and looks like "a quiet month", so it's pinned
here. So is the refusal to list a folder outside the repos, which is the one
failure here that would be worse than silent.
"""
import pytest

import store
from routes import terrain


@pytest.fixture
def vault(data_dir, monkeypatch, tmp_path):
    """A fake vault repo with the terrain repos pointed at it, so the same
    relative_to resolution runs that runs against the real one."""
    root = tmp_path / "vault"
    (root / "data").mkdir(parents=True)
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", root / "data" / "uploads-archive")
    monkeypatch.setattr(terrain.observatory, "_terrain_repos", lambda: (
        {"id": "skeleton", "name": "App code", "root": tmp_path / "skeleton"},
        {"id": "vault", "name": "Personal vault", "root": root},
    ))
    return root


def _folder(root, rel, names):
    folder = root / rel
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        (folder / name).write_bytes(b"x")
    return folder


def _configure(coils):
    store.write("terrain_coils", {"coils": coils})


def test_defaults_to_the_uploads_archive_with_no_config(vault):
    """An install that has never heard of the config file behaves exactly as
    it did before there was one."""
    _folder(vault, "data/uploads-archive", ["20260920_140908.png"])

    listings = terrain._coil_listings()

    assert len(listings) == 1
    assert listings[0]["repo"] == "vault"
    assert listings[0]["prefix"] == "data/uploads-archive/"
    assert listings[0]["time"] == "stamp"
    assert listings[0]["paths"] == ["data/uploads-archive/20260920_140908.png"]


def test_lists_several_folders_without_bleeding(vault):
    _folder(vault, "data/uploads-archive", ["20260920_140908.png"])
    _folder(vault, "data/bot_chats", ["2026-07-23.101356.jsonl", "2026-07-24.101356.jsonl"])
    _configure([{"path": "data/uploads-archive"}, {"path": "data/bot_chats"}])

    listings = terrain._coil_listings()

    assert [c["prefix"] for c in listings] == ["data/uploads-archive/", "data/bot_chats/"]
    assert len(listings[0]["paths"]) == 1
    assert len(listings[1]["paths"]) == 2
    # Repo-relative, matching the shape of `repos[].files[].path` — the client
    # matches the two against each other.
    assert all(p.startswith("data/bot_chats/") for p in listings[1]["paths"])


def test_is_not_capped_the_way_files_are(vault):
    """The whole point. The payload's own file list would keep none of these."""
    _folder(vault, "data/uploads-archive",
            [f"202603{i % 28 + 1:02d}_12{i % 60:02d}00_{i}.png" for i in range(400)])

    assert len(terrain._coil_listings()[0]["paths"]) == 400


def test_carries_the_time_source_and_windows_through(vault):
    _folder(vault, "tulku/people", ["abboody.md"])
    _configure([{"path": "tulku/people", "time": "git", "windows": [92, None]}])

    listing = terrain._coil_listings()[0]

    assert listing["time"] == "git"
    assert listing["windows"] == [92, None]


def test_an_unknown_time_source_falls_back_to_stamp(vault):
    """A typo in a data file should cost a sensible default, not the map."""
    _folder(vault, "data/bot_chats", ["2026-07-23.101356.jsonl"])
    _configure([{"path": "data/bot_chats", "time": "vibes"}])

    assert terrain._coil_listings()[0]["time"] == "stamp"


def test_ignore_globs_keep_sidecars_off_the_coil(vault):
    """write_log's SQLite sidecars are not entries — they'd each draw a dot."""
    _folder(vault, "data/write_log",
            ["2026-08-21.db", "2026-08-21.db-shm", "2026-08-21.db-wal"])
    _configure([{"path": "data/write_log", "ignore": ["*.db-shm", "*.db-wal"]}])

    assert terrain._coil_listings()[0]["paths"] == ["data/write_log/2026-08-21.db"]


def test_refuses_a_path_that_escapes_the_repo(vault, tmp_path):
    """The one failure here that would be worse than silent. `relative_to` is
    what enforces it — an escaping path matches no repo root and falls off the
    end rather than being listed."""
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_bytes(b"x")
    _configure([{"path": "../outside"}])

    assert terrain._coil_listings() == []


def test_skips_a_folder_that_is_not_there(vault):
    _folder(vault, "data/bot_chats", ["2026-07-23.101356.jsonl"])
    _configure([{"path": "data/gone"}, {"path": "data/bot_chats"}])

    assert [c["prefix"] for c in terrain._coil_listings()] == ["data/bot_chats/"]


def test_skips_a_malformed_entry(vault):
    _folder(vault, "data/bot_chats", ["2026-07-23.101356.jsonl"])
    _configure(["not-a-dict", {}, {"path": "data/bot_chats"}])

    assert [c["prefix"] for c in terrain._coil_listings()] == ["data/bot_chats/"]


def test_follows_the_archive_when_the_install_moves_it(vault, monkeypatch):
    """EXOCORTEX_UPLOAD_ARCHIVE_DIR can put the default folder anywhere in the
    vault; the prefix has to follow it, because the client is told rather than
    assuming."""
    _folder(vault, "elsewhere/shots", ["20260920_140908.png"])
    monkeypatch.setattr(store, "UPLOAD_ARCHIVE_DIR", vault / "elsewhere" / "shots")

    listing = terrain._coil_listings()[0]

    assert listing["prefix"] == "elsewhere/shots/"
    assert listing["paths"] == ["elsewhere/shots/20260920_140908.png"]


def test_ignores_subfolders(vault):
    folder = _folder(vault, "data/uploads-archive", ["20260920_140908.png"])
    _folder(folder, "old", ["20260101_000000.png"])

    assert terrain._coil_listings()[0]["paths"] == [
        "data/uploads-archive/20260920_140908.png"
    ]


def test_keeps_the_newest_at_the_ceiling(vault, monkeypatch):
    """Past the ceiling it's the OLDEST that get dropped — a coil is read from
    its newest dot outward, so that's the end that can be spared."""
    monkeypatch.setattr(terrain, "_COIL_LIST_MAX", 3)
    _folder(vault, "data/uploads-archive",
            [f"2026032{day}_120000.png" for day in (1, 2, 3, 4, 5)])

    assert terrain._coil_listings()[0]["paths"] == [
        "data/uploads-archive/20260325_120000.png",
        "data/uploads-archive/20260324_120000.png",
        "data/uploads-archive/20260323_120000.png",
    ]


# --- a git coil's times ride along the listing --------------------------------
#
# Same reason the listing itself exists, one level deeper: `repos[].files` is
# cut to the hottest N, and a coil folder loses that cut badly — measured on
# the real vault, 7 of tulku/people's 75 survive it. A git coil reading its
# times out of the payload could date only those 7 and would strand the other
# 68 undated on its outer tip. So the server works the times out and sends
# them uncapped, aligned with `paths`.

def test_a_git_coil_carries_a_time_for_every_path(vault, monkeypatch):
    _folder(vault, "tulku/people", ["abboody.md", "adam.md", "aetheris.md"])
    monkeypatch.setattr(terrain.codestore, "folder_edit_times",
                        lambda repo, prefix, **kw: {
                            "tulku/people/abboody.md": 1780000000,
                            "tulku/people/adam.md": 1781000000,
                            "tulku/people/aetheris.md": 1782000000,
                        })
    _configure([{"path": "tulku/people", "time": "git"}])

    listing = terrain._coil_listings()[0]

    # Aligned with paths, one for one — the client zips the two.
    assert len(listing["times"]) == len(listing["paths"])
    assert dict(zip(listing["paths"], listing["times"]))[
        "tulku/people/adam.md"] == 1781000000


def test_a_path_the_history_cannot_date_is_sent_as_null(vault, monkeypatch):
    """An untracked file has no history to read. It goes down as null rather
    than being dropped, so the two arrays stay aligned."""
    _folder(vault, "tulku/people", ["abboody.md", "brand-new.md"])
    monkeypatch.setattr(terrain.codestore, "folder_edit_times",
                        lambda repo, prefix, **kw: {"tulku/people/abboody.md": 1780000000})
    _configure([{"path": "tulku/people", "time": "git"}])

    listing = terrain._coil_listings()[0]

    assert len(listing["times"]) == len(listing["paths"]) == 2
    assert dict(zip(listing["paths"], listing["times"])) == {
        "tulku/people/abboody.md": 1780000000,
        "tulku/people/brand-new.md": None,
    }


def test_a_stamp_coil_is_sent_no_times_at_all(vault, monkeypatch):
    """Its moment is read out of the filename by one parser on the client. A
    time from the server would be a second clock, free to disagree."""
    _folder(vault, "data/uploads-archive", ["20260920_140908.png"])
    called = []
    monkeypatch.setattr(terrain.codestore, "folder_edit_times",
                        lambda repo, prefix, **kw: called.append(prefix) or {})
    _configure([{"path": "data/uploads-archive", "time": "stamp"}])

    listing = terrain._coil_listings()[0]

    assert "times" not in listing
    assert called == []


def test_an_ignored_file_is_left_out_of_the_times_too(vault, monkeypatch):
    """The two arrays are built from the same list after the ignores run, so a
    sidecar can't shift every time by one."""
    _folder(vault, "tulku/people", ["abboody.md", "notes.json"])
    monkeypatch.setattr(terrain.codestore, "folder_edit_times",
                        lambda repo, prefix, **kw: {
                            "tulku/people/abboody.md": 1780000000,
                            "tulku/people/notes.json": 1799999999,
                        })
    _configure([{"path": "tulku/people", "time": "git", "ignore": ["*.json"]}])

    listing = terrain._coil_listings()[0]

    assert listing["paths"] == ["tulku/people/abboody.md"]
    assert listing["times"] == [1780000000]


# --- setting a coil's steps from the map (POST .../coils/windows) -------------

@pytest.fixture
def client(vault):
    from flask import Flask
    app = Flask(__name__)
    terrain.register(app)
    return app.test_client()


def _post_windows(client, windows, prefix="tulku/people/", repo="vault"):
    return client.post("/api/observatory/terrain/coils/windows",
                       json={"repo": repo, "prefix": prefix, "windows": windows})


def test_setting_steps_round_trips_to_the_listing(vault, client):
    _folder(vault, "tulku/people", ["abboody.md"])
    _configure([{"path": "tulku/people", "time": "git"}])

    assert _post_windows(client, [14, 31, None]).status_code == 200

    assert terrain._coil_listings()[0]["windows"] == [14, 31, None]


def test_setting_steps_leaves_every_other_coil_and_note_alone(vault, client):
    _folder(vault, "tulku/people", ["abboody.md"])
    _folder(vault, "data/bot_chats", ["2026-07-23.101356.jsonl"])
    store.write("terrain_coils", {
        "_what": "her note",
        "coils": [{"path": "data/bot_chats", "windows": [7, None], "ignore": ["*.x"]},
                  {"path": "tulku/people/", "time": "git"}],
    })

    _post_windows(client, [92, None])

    saved = store.read("terrain_coils", {})
    assert saved["_what"] == "her note"
    assert saved["coils"][0] == {"path": "data/bot_chats", "windows": [7, None], "ignore": ["*.x"]}
    assert saved["coils"][1] == {"path": "tulku/people/", "time": "git", "windows": [92, None]}


@pytest.mark.parametrize("windows", [
    [],                     # nothing to open to
    [31, None, 92],         # "everything" in the middle
    [92, 31],               # out of order
    [31, 31],               # a repeat
    [0],                    # no days at all
    [True, 31],             # a bool is not a number of days
    [31.5],                 # nor is a fraction
    list(range(1, 10)),     # more steps than a card can hold
])
def test_refuses_a_step_list_the_map_cannot_walk(vault, client, windows):
    _folder(vault, "tulku/people", ["abboody.md"])
    _configure([{"path": "tulku/people", "windows": [31, None]}])

    assert _post_windows(client, windows).status_code == 400
    assert store.read("terrain_coils", {})["coils"][0]["windows"] == [31, None]


def test_refuses_a_coil_that_is_not_configured(vault, client):
    _folder(vault, "tulku/people", ["abboody.md"])
    _configure([{"path": "tulku/people"}])

    assert _post_windows(client, [31], prefix="data/nowhere/").status_code == 404


def test_first_save_with_no_config_writes_the_default_coil_out(vault, client):
    """With no file, the uploads archive is the one coil; saving its steps has
    to create the file without losing that coil."""
    _folder(vault, "data/uploads-archive", ["20260920_140908.png"])

    assert _post_windows(client, [7, 31], prefix="data/uploads-archive/").status_code == 200

    listing = terrain._coil_listings()[0]
    assert listing["prefix"] == "data/uploads-archive/"
    assert listing["windows"] == [7, 31]


def test_a_malformed_step_list_in_the_file_falls_back_to_the_defaults(vault):
    _folder(vault, "tulku/people", ["abboody.md"])
    _configure([{"path": "tulku/people", "windows": [92, 31]}])

    assert terrain._coil_listings()[0]["windows"] == [31, 92, 183, None]
