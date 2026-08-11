"""The deploy guard's one question: is anyone mid-turn right now?

This gates deploys, so it has two ways to be wrong and they are not
symmetrical. Saying "live" about a corpse wedges every deploy behind a flag
nobody will ever clear — and this index really does carry `running` flags left
over from July. Saying "clear" about a live turn silently destroys someone's
work, which is the failure the guard exists to prevent.

So: the flag alone never counts, and a fresh heartbeat is what makes it real.
"""
from datetime import datetime, timedelta

import store
from scripts import live_turns as lt


def idx(**entries):
    return entries


def fresh(seconds_ago=5):
    return (datetime.now() - timedelta(seconds=seconds_ago)).isoformat()


def test_a_turn_with_a_fresh_heartbeat_is_live():
    got = lt.live_turns(idx(c1={"running": True, "last_at": fresh(5)}))
    assert [t["id"] for t in got] == ["c1"]


def test_a_running_flag_with_a_stale_heartbeat_is_a_corpse():
    """The July flags. A turn re-stamps last_at every 30s while it works, so
    anything past the staleness window was killed without clearing up."""
    old = (datetime.now() - timedelta(days=18)).isoformat()
    assert lt.live_turns(idx(c1={"running": True, "last_at": old})) == []


def test_a_finished_turn_is_not_live():
    assert lt.live_turns(idx(c1={"running": False, "last_at": fresh(1)})) == []


def test_right_at_the_staleness_edge():
    just_inside = lt.live_turns(idx(c1={"running": True,
                                        "last_at": fresh(lt.STALE_SEC - 30)}))
    just_outside = lt.live_turns(idx(c1={"running": True,
                                         "last_at": fresh(lt.STALE_SEC + 30)}))
    assert [t["id"] for t in just_inside] == ["c1"]
    assert just_outside == []


def test_a_running_flag_with_no_heartbeat_does_not_wedge_deploys():
    """Unknowable, so treated as dead. Erring the other way would let one
    malformed entry block every deploy forever, and orphaned flags are by far
    the likelier state of this index."""
    assert lt.live_turns(idx(c1={"running": True})) == []
    assert lt.live_turns(idx(c1={"running": True, "last_at": "not a date"})) == []


def test_junk_entries_are_skipped_not_fatal():
    got = lt.live_turns(idx(c1="not a dict", c2=None,
                            c3={"running": True, "last_at": fresh(2)}))
    assert [t["id"] for t in got] == ["c3"]


def test_a_junk_index_is_not_fatal():
    assert lt.live_turns([]) == []
    assert lt.live_turns("nope") == []


def test_live_turns_come_back_newest_heartbeat_first():
    got = lt.live_turns(idx(old={"running": True, "last_at": fresh(300)},
                            new={"running": True, "last_at": fresh(2)}))
    assert [t["id"] for t in got] == ["new", "old"]


def test_exit_code_is_what_the_deploy_script_reads(data_dir, capsys):
    """Non-zero means work is live. The shell guard is built on this alone."""
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)

    store.write("bot_chats/index", {"c1": {"running": True, "last_at": fresh(3)}})
    assert lt.main([]) == 1
    assert "c1" in capsys.readouterr().out

    store.write("bot_chats/index", {"c1": {"running": False}})
    assert lt.main([]) == 0
    assert "no turns running" in capsys.readouterr().out
