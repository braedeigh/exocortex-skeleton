"""The sessions SSE stream's cheap-signature contract (routes/terminal.py).

/api/sessions/stream pushes the session list to the UI over SSE. Its loop wakes
once a second for every connected client, so the way it answers "did anything
change?" IS the cost of the endpoint. It used to answer by building the whole
payload — a full read-and-parse of session_titles.json through the store — and
then throwing it away, which made this one endpoint the largest single consumer
of the data layer in the app: millions of reads a day, most of them while
nobody was looking at the page.

These tests pin the replacement. The load-bearing one is the first: computing
the signature must never touch the store. The rest check it still notices the
three things a client actually renders.
"""
import os

import pytest

import store
from routes import terminal


@pytest.fixture
def stream(data_dir, monkeypatch):
    """Point the signature's two inputs at the throwaway data dir.

    SESSIONS_PATH is resolved at import time from data_helpers.DATA_DIR, so the
    `data_dir` fixture (which moves store.DATA_DIR) doesn't reach it — it has to
    be re-pointed by hand. The worker list shells out to tmux, which has nothing
    to do with what's under test.
    """
    monkeypatch.setattr(terminal, "SESSIONS_PATH", data_dir / "sessions.json")
    monkeypatch.setattr(terminal, "_live_workers", lambda: [])
    return data_dir


def _age(path, seconds=1):
    """Move a file's mtime forward explicitly, rather than racing the clock —
    the contract is "notices a newer file", not "two writes land in different
    microseconds"."""
    st = path.stat()
    os.utime(path, (st.st_atime, st.st_mtime + seconds))


def test_signature_never_reads_the_store(stream, monkeypatch):
    """The whole point of the fix. This runs once a second per client; a store
    read in here is the leak, restored."""
    def explode(*args, **kwargs):
        raise AssertionError(
            "_sessions_signature() read the store — that read, once a second "
            "for every connected client, was the leak")

    monkeypatch.setattr(store, "read", explode)
    terminal._sessions_signature()


def test_signature_is_stable_when_nothing_changes(stream):
    store.write("session_titles", {"chat": "Keeper"})
    assert terminal._sessions_signature() == terminal._sessions_signature()


def test_signature_survives_missing_files(stream):
    """A fresh install has neither file. Absent has to compare equal to absent,
    or an empty machine streams a frame every second forever."""
    assert terminal._sessions_signature() == terminal._sessions_signature()


def test_signature_changes_when_a_title_is_written(stream):
    store.write("session_titles", {"chat": "Keeper"})
    before = terminal._sessions_signature()
    _age(store.file_path("session_titles"))
    assert terminal._sessions_signature() != before


def test_signature_changes_when_the_session_list_is_written(stream):
    terminal.SESSIONS_PATH.write_text('["chat"]')
    before = terminal._sessions_signature()
    _age(terminal.SESSIONS_PATH)
    assert terminal._sessions_signature() != before


def test_signature_changes_when_a_worker_appears(stream, monkeypatch):
    before = terminal._sessions_signature()
    monkeypatch.setattr(terminal, "_live_workers", lambda: ["rw-abc"])
    assert terminal._sessions_signature() != before
