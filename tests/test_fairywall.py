"""The fairy's wall (fairywall.py), tested against the real thing.

What these pin: a command run inside the wall can write in its room and
nowhere else, can read the rest of the disk, cannot read the home folder or
the hidden paths, and can still read the database. Every test runs a real
command through bubblewrap; with no bubblewrap installed they are skipped.
"""
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

import pytest

import fairywall
import store

pytestmark = pytest.mark.skipif(not fairywall.available(), reason="bubblewrap is not installed")


@pytest.fixture
def place(monkeypatch):
    """A small stand-in machine: a vault with a journal file, a data folder
    with a database, a chat log and a secret, a home folder with a key, and
    an empty room. Built under /var/tmp, not pytest's own folder: that one
    is in /tmp, and the wall gives the command an empty /tmp of its own."""
    tmp_path = Path(tempfile.mkdtemp(prefix="fairywall-test-", dir="/var/tmp"))
    vault, data, home, room = (tmp_path / name for name in ("vault", "data", "home", "room"))
    for folder in (vault / "tulku" / ".keeper", vault / ".git", data / "bot_chats",
                   home / ".ssh", room):
        folder.mkdir(parents=True)
    (vault / "tulku" / "journal.md").write_text("a day she wrote down")
    (vault / "tulku" / ".keeper" / "state").write_text("capture state")
    (vault / ".git" / "history").write_text("old chat logs")
    (data / "bot_chats" / "chat.jsonl").write_text("an off-the-record turn")
    (data / "push_vapid.pem").write_text("a private key")
    (home / ".ssh" / "id_ed25519").write_text("an ssh key")
    conn = sqlite3.connect(data / "exo.db")
    conn.execute("CREATE TABLE cards (body TEXT)")
    conn.execute("INSERT INTO cards VALUES ('a card')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(store, "DATA_DIR", data)
    monkeypatch.setattr(store, "CONTENT_DIR", vault / "tulku")
    yield {"vault": vault, "data": data, "home": home, "room": room}
    shutil.rmtree(tmp_path, ignore_errors=True)


def inside(place, script):
    """Run a shell script inside the wall; return (exit code, output)."""
    walled = fairywall.command(["sh", "-c", script], place["room"], home=place["home"])
    done = subprocess.run(walled, capture_output=True, text=True, timeout=30)
    return done.returncode, done.stdout + done.stderr


def test_writes_land_in_the_room_and_nowhere_else(place):
    code, _ = inside(place, "echo mine > note.txt")
    assert code == 0 and (place["room"] / "note.txt").read_text() == "mine\n"
    for target in (place["vault"] / "tulku" / "journal.md", place["vault"] / "new.md",
                   place["data"] / "todos.json"):
        _, output = inside(place, f"echo changed > {target}")
        assert "Read-only file system" in output
    # The home folder inside the wall is an empty stand-in: a write there
    # is allowed and is gone when the command ends.
    inside(place, f"echo changed > {place['home']}/x")
    assert (place["vault"] / "tulku" / "journal.md").read_text() == "a day she wrote down"
    assert not (place["vault"] / "new.md").exists()
    assert not (place["data"] / "todos.json").exists()
    assert not (place["home"] / "x").exists()


def test_the_rest_is_readable(place):
    code, output = inside(place, f"cat {place['vault']}/tulku/journal.md")
    assert code == 0 and "a day she wrote down" in output


def test_home_and_hidden_paths_are_empty(place):
    for secret in (place["home"] / ".ssh" / "id_ed25519",
                   place["data"] / "bot_chats" / "chat.jsonl",
                   place["vault"] / ".git" / "history",
                   place["vault"] / "tulku" / ".keeper" / "state"):
        code, _ = inside(place, f"cat {secret}")
        assert code != 0
    # A hidden file is still listed, and can't be opened.
    code, output = inside(place, f"cat {place['data']}/push_vapid.pem")
    assert code != 0 and "a private key" not in output


def test_the_database_reads_and_refuses_a_write(place):
    reader = ("import sqlite3; c = sqlite3.connect('file:{db}?mode=ro', uri=True); "
              "print(c.execute('select body from cards').fetchone()[0])")
    code, output = inside(place, f"python3 -c \"{reader.format(db=place['data'] / 'exo.db')}\"")
    assert code == 0 and "a card" in output
    writer = ("import sqlite3; c = sqlite3.connect('{db}'); "
              "c.execute('insert into cards values (1)'); c.commit()")
    code, output = inside(place, f"python3 -c \"{writer.format(db=place['data'] / 'exo.db')}\"")
    assert code != 0 and "readonly" in output
    conn = sqlite3.connect(place["data"] / "exo.db")
    assert conn.execute("select count(*) from cards").fetchone()[0] == 1
    conn.close()


def test_the_room_keeps_its_own_conversations(place):
    transcripts = fairywall.transcripts_dir(place["room"].resolve(), place["home"].resolve())
    code, _ = inside(place, f"echo turn > {transcripts}/session.jsonl")
    assert code == 0 and (transcripts / "session.jsonl").read_text() == "turn\n"
