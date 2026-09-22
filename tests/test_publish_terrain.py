"""The publisher's own arithmetic (scripts/publish_terrain.py) — what counts
as "the map changed", and remembering it between runs.

The route side is tested in test_terrain_mirror.py; this is the private box's
half: it must not push an identical map just because it was rebuilt, and a
`--once` run from cron must know what the last run sent.
"""
import json

from scripts import publish_terrain


def _map(paths, generated_at):
    return {"generated_at": generated_at,
            "repos": [{"id": "skeleton", "files": [{"path": p} for p in paths]}]}


def _raw(payload):
    return json.dumps(payload).encode()


def test_a_rebuilt_but_unchanged_map_has_the_same_fingerprint():
    """`generated_at` moves on every build — on its own it must not count as
    a change, or an idle box would push all day."""
    first = publish_terrain.map_fingerprint(_raw(_map(["server.py"], "2026-09-21T10:00:00")))
    later = publish_terrain.map_fingerprint(_raw(_map(["server.py"], "2026-09-21T10:05:00")))
    assert first == later


def test_a_touched_file_changes_the_fingerprint():
    before = publish_terrain.map_fingerprint(_raw(_map(["server.py"], "2026-09-21T10:00:00")))
    after = publish_terrain.map_fingerprint(_raw(_map(["server.py", "store.py"], "2026-09-21T10:00:00")))
    assert before != after


def test_junk_fingerprints_as_unknown_so_it_gets_pushed():
    """None never equals a stored fingerprint, so an unparseable body is sent
    and judged at the far end rather than silently skipped here."""
    assert publish_terrain.map_fingerprint(b"not json at all") is None


def test_the_fingerprint_survives_between_runs(data_dir):
    assert publish_terrain.read_last_fingerprint() is None
    publish_terrain.write_last_fingerprint("abc123")
    assert publish_terrain.read_last_fingerprint() == "abc123"
