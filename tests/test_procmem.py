"""procmem.py — per-session memory, read off a FAKE /proc.

The real /proc can't be seeded, so every test here points `procmem.PROC` at a
tmp_path built to look like one. That's the whole seam: a directory of numbered
folders, each with an `environ` blob and a memory file.
"""
import pytest

import procmem


@pytest.fixture(autouse=True)
def clear_cache():
    procmem.reset_cache()
    yield
    procmem.reset_cache()


def _proc(tmp_path, pids):
    """Build a fake /proc. `pids` maps pid -> (conv_id or None, pss_kb, rss_kb).
    A pss_kb of None omits smaps_rollup entirely, so the RSS fallback runs."""
    for pid, (conv, pss, rss) in pids.items():
        d = tmp_path / str(pid)
        d.mkdir()
        env = [b"PATH=/usr/bin", b"HOME=/home/x"]
        if conv:
            env.append(b"EXOCORTEX_CONV_ID=" + conv.encode())
        (d / "environ").write_bytes(b"\0".join(env) + b"\0")
        if pss is not None:
            (d / "smaps_rollup").write_text(f"Rss:  {rss} kB\nPss:  {pss} kB\n")
        (d / "status").write_text(f"Name:\tclaude\nVmRSS:\t{rss} kB\n")
    # A non-numeric entry, because the real /proc is full of them.
    (tmp_path / "meminfo").write_text("MemAvailable: 1 kB\n")
    procmem.PROC = str(tmp_path)
    return tmp_path


def test_it_attributes_memory_to_the_session_that_owns_it(tmp_path, monkeypatch):
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", 1024 * 300, 1024 * 400)})
    assert procmem.scan() == {"conv-a": 300}


def test_a_sessions_tool_subprocesses_count_toward_it(tmp_path, monkeypatch):
    """A turn that shelled out to run tests is still that turn's memory —
    children inherit the tag from their parent."""
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {
        101: ("conv-a", 1024 * 300, 1024 * 400),
        102: ("conv-a", 1024 * 100, 1024 * 150),
    })
    assert procmem.scan() == {"conv-a": 400}


def test_sessions_are_kept_apart(tmp_path, monkeypatch):
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {
        101: ("conv-a", 1024 * 300, 0),
        102: ("conv-b", 1024 * 200, 0),
    })
    assert procmem.scan() == {"conv-a": 300, "conv-b": 200}


def test_untagged_processes_are_ignored(tmp_path, monkeypatch):
    """Her interactive tmux claude sessions carry no conversation id — they
    aren't Observatory cards and must not be attributed to one."""
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {
        101: ("conv-a", 1024 * 300, 0),
        102: (None, 1024 * 900, 0),
    })
    assert procmem.scan() == {"conv-a": 300}


def test_it_prefers_pss_so_the_cards_reconcile_with_the_header(tmp_path, monkeypatch):
    """RSS counts shared pages once per process, so summed cards would exceed
    the box. PSS splits them and the numbers add up."""
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", 1024 * 200, 1024 * 400)})
    assert procmem.scan() == {"conv-a": 200}


def test_it_falls_back_to_rss_when_pss_is_unreadable(tmp_path, monkeypatch):
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", None, 1024 * 350)})
    assert procmem.scan() == {"conv-a": 350}


def test_the_number_is_rounded_so_it_does_not_twitch(tmp_path, monkeypatch):
    """The roster re-polls every few seconds; an exact figure would tick in her
    peripheral vision forever."""
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", 1024 * 287, 0)})
    assert procmem.scan() == {"conv-a": 290}


def test_a_process_that_vanished_mid_read_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", 1024 * 100, 0)})
    (tmp_path / "999").mkdir()  # a pid dir with no readable files
    assert procmem.scan() == {"conv-a": 100}


def test_no_proc_at_all_yields_nothing_rather_than_raising(monkeypatch):
    """Anywhere without /proc, every caller shows nothing — the honest answer
    rather than an invented one."""
    monkeypatch.setattr(procmem, "PROC", "/definitely/not/here")
    assert procmem.scan() == {}
    assert procmem.session_memory() == {}


def test_the_scan_is_cached_between_rapid_polls(tmp_path, monkeypatch):
    monkeypatch.setattr(procmem, "PROC", str(tmp_path))
    _proc(tmp_path, {101: ("conv-a", 1024 * 100, 0)})
    calls = []

    real_scan = procmem.scan
    monkeypatch.setattr(procmem, "scan", lambda: (calls.append(1), real_scan())[1])

    procmem.session_memory(now=1000.0)
    procmem.session_memory(now=1001.0)
    procmem.session_memory(now=1002.0)
    assert len(calls) == 1, "three polls inside the TTL should walk /proc once"

    procmem.session_memory(now=1010.0)
    assert len(calls) == 2, "past the TTL it re-reads"


def test_a_broken_scan_never_takes_down_the_caller(monkeypatch):
    def boom():
        raise OSError("permission denied")

    monkeypatch.setattr(procmem, "scan", boom)
    assert procmem.session_memory() == {}
