"""Behavioral tests for scripts/research_doctor.py — the read-only research
subsystem integrity checker.

Each broken-state test seeds a minimal (otherwise-healthy) data set with one
thing wrong, runs the doctor, and asserts the finding shows up. A separate
fully-healthy seed asserts a clean bill of health. `--fix` is exercised
against a seed carrying all three fixable faults plus one unfixable one
(a dangling reply_to), asserting the safe three are repaired and the fourth
is left alone. Tmux-dependent checks (6's dead-worker half, and 9) use a
fake tmux_fn, same pattern as test_research_dispatcher.py; a raising fake
simulates tmux being entirely unavailable.
"""
import pytest

import store
from conftest import data_dir  # noqa: F401  (imported for fixture visibility)
from scripts import research_doctor as doctor


# --- fakes -------------------------------------------------------------------

class _FakeTmuxResult:
    def __init__(self, returncode, stdout=""):
        self.returncode = returncode
        self.stdout = stdout


def _fake_tmux(live_sessions):
    def _tmux(cmd_str):
        if cmd_str.startswith("list-sessions"):
            if not live_sessions:
                return _FakeTmuxResult(1, "")
            return _FakeTmuxResult(0, "\n".join(live_sessions) + "\n")
        return _FakeTmuxResult(0, "")
    return _tmux


def _absent_tmux(cmd_str):
    raise OSError("tmux: command not found")


def _clock(stamp="2026-07-07 12:00"):
    from datetime import datetime
    dt = datetime.strptime(stamp, "%Y-%m-%d %H:%M")
    return lambda: dt


# --- fixtures ------------------------------------------------------------------

@pytest.fixture
def research_dir(data_dir, monkeypatch):
    """Points both store.RESEARCH_DIR (check 4 / docstore note: resolution)
    and EXOCORTEX_RESEARCH_DIR (research_search._corpus()'s note: docs) at
    the same directory, so check 8's id scheme lines up with check 4's."""
    d = data_dir / "research"
    d.mkdir()
    (d / "note1.md").write_text("# Note One\n\nsome content")
    monkeypatch.setattr(store, "RESEARCH_DIR", d)
    monkeypatch.setenv("EXOCORTEX_RESEARCH_DIR", str(d))
    return d


def _healthy_research():
    return {
        "topics": [{"id": "t1", "name": "Topic One", "status": "active", "created": "2026-07-01 09:00",
                    "fronts": []}],
        "entries": [
            {"id": "q1", "kind": "question", "text": "Why?", "topics": ["t1"], "url": "",
             "verdict": "", "status": "open", "reply_to": None, "created": "2026-07-01 09:00"},
            {"id": "r1", "kind": "note", "text": "Because.", "topics": ["t1"], "url": "",
             "verdict": "", "status": "", "reply_to": "q1", "created": "2026-07-01 09:05",
             "author": "llm", "reviewed": False, "session": "s1"},
            {"id": "c1", "kind": "claim", "text": "X is true", "topics": ["t1"], "url": "",
             "verdict": "real", "status": "", "reply_to": None, "created": "2026-07-01 09:10"},
            {"id": "src1", "kind": "source", "text": "a source", "topics": ["t1"], "url": "http://x",
             "verdict": "verified", "status": "", "reply_to": None, "created": "2026-07-01 09:15",
             "file": "note1.md"},
        ],
        "sessions": [
            {"id": "s1", "entry_ids": ["q1"], "topics": ["t1"], "created": "2026-07-01 09:00",
             "status": "done", "report": "Answered."},
        ],
    }


def _seed_healthy(research_dir):
    store.write("research.json", _healthy_research())
    store.write("research_vectors.json", {"vectors": [
        {"id": "entry:q1", "content": "Why?", "embedding": [0.1]},
        {"id": "note:note1.md", "content": "# Note One\n\nsome content", "embedding": [0.2]},
    ]})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": [
        {"id": "ann-1", "doc": "entry:q1", "content": {}, "needs_review": False,
         "selector": {"exact": "Why", "char_start": 0, "char_end": 3}, "created": "2026-07-01 09:00"},
    ]})


def _write_research(research):
    store.write("research.json", research)


# --- 1. reply_to ---------------------------------------------------------------

def test_dangling_reply_to_found(research_dir):
    research = _healthy_research()
    research["entries"][0]["reply_to"] = "does-not-exist"
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("does-not-exist" in f and "q1" in f for f in findings)


def test_reply_to_cycle_found(research_dir):
    research = _healthy_research()
    research["entries"] += [
        {"id": "x1", "kind": "note", "text": "a", "topics": [], "url": "", "verdict": "",
         "status": "", "reply_to": "x2", "created": "2026-07-01 09:00"},
        {"id": "x2", "kind": "note", "text": "b", "topics": [], "url": "", "verdict": "",
         "status": "", "reply_to": "x1", "created": "2026-07-01 09:00"},
    ]
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("cycle" in f for f in findings)


# --- 2. duplicate ids / topic refs ---------------------------------------------

def test_duplicate_entry_id_cannot_reach_the_doctor(research_dir):
    """Entries are rows keyed by id (researchstore.py), so a document with the
    same id twice collapses to one entry on the way in — the doctor's
    duplicate check has nothing left to find, and says so."""
    research = _healthy_research()
    dup = dict(research["entries"][0])
    research["entries"].append(dup)
    _write_research(research)
    assert [e["id"] for e in store.read("research.json")["entries"]].count("q1") == 1
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert not any("duplicate entry id" in f for f in findings)


def test_missing_topic_ref_found(research_dir):
    research = _healthy_research()
    research["entries"][0]["topics"] = ["nope"]
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("topic 'nope'" in f for f in findings)


# --- 3. session/entry links -----------------------------------------------------

def test_session_missing_entry_id_found(research_dir):
    research = _healthy_research()
    research["sessions"][0]["entry_ids"] = ["nope"]
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("s1" in f and "nope" in f for f in findings)


def test_entry_missing_session_found(research_dir):
    research = _healthy_research()
    research["entries"][1]["session"] = "nope"
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("r1" in f and "nope" in f for f in findings)


# --- 4. entry file --------------------------------------------------------------

def test_missing_entry_file_found(research_dir):
    research = _healthy_research()
    research["entries"][3]["file"] = "gone.md"
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("src1" in f and "gone.md" in f for f in findings)


# --- 5. annotations --------------------------------------------------------------

def test_unresolvable_annotation_found(research_dir):
    _write_research(_healthy_research())
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": [
        {"id": "ann-bad", "doc": "entry:no-such-entry", "content": {}, "needs_review": True,
         "selector": {}, "created": "2026-07-01 09:00"},
    ]})
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("ann-bad" in f for f in findings)


# --- 6. worker sessions ----------------------------------------------------------

def test_dead_running_worker_found(research_dir):
    research = _healthy_research()
    research["sessions"].append({
        "id": "s2", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 09:00",
        "status": "running", "report": "", "worker": True,
    })
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("s2" in f and "not live" in f for f in findings)


def test_running_worker_with_live_tmux_not_found(research_dir):
    research = _healthy_research()
    research["sessions"].append({
        "id": "s2", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 09:00",
        "status": "running", "report": "", "worker": True,
    })
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux(["rw-s2"]))
    assert not any("s2" in f and "not live" in f for f in findings)


def test_stale_queued_session_found(research_dir):
    research = _healthy_research()
    research["sessions"].append({
        "id": "s3", "entry_ids": ["q1"], "topics": [], "created": "2026-07-05 09:00",
        "status": "queued", "report": "", "worker": True,
    })
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]), clock=_clock("2026-07-07 12:00"))
    assert any("s3" in f and ">24h" in f for f in findings)


def test_fresh_queued_session_not_found(research_dir):
    research = _healthy_research()
    research["sessions"].append({
        "id": "s3", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 11:00",
        "status": "queued", "report": "", "worker": True,
    })
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]), clock=_clock("2026-07-07 12:00"))
    assert not any("s3" in f for f in findings)


# --- 7. reviewed / verdict / status legality -------------------------------------

def test_reviewed_on_non_llm_entry_found(research_dir):
    research = _healthy_research()
    research["entries"][0]["reviewed"] = True  # q1 has no author == not llm
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("q1" in f and "reviewed" in f for f in findings)


def test_illegal_verdict_found(research_dir):
    research = _healthy_research()
    research["entries"][2]["verdict"] = "bogus"  # c1 is a claim
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("c1" in f and "verdict" in f for f in findings)


def test_illegal_status_found(research_dir):
    research = _healthy_research()
    research["entries"][1]["status"] = "open"  # r1 is a note, not a question
    _write_research(research)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("r1" in f and "status" in f for f in findings)


# --- 8. vector orphans -----------------------------------------------------------

def test_orphan_vector_found(research_dir):
    _write_research(_healthy_research())
    store.write("research_vectors.json", {"vectors": [
        {"id": "entry:no-such-entry", "content": "x", "embedding": [0.1]},
    ]})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": []})
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("entry:no-such-entry" in f for f in findings)


# --- 9. stale sessions.json tab names ---------------------------------------------

def test_stale_tab_name_found(research_dir):
    _write_research(_healthy_research())
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", ["chat", "rw-dead"])
    store.write("annotations.json", {"annotations": []})
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert any("rw-dead" in f for f in findings)


def test_live_tab_name_not_found(research_dir):
    _write_research(_healthy_research())
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", ["chat", "rw-alive"])
    store.write("annotations.json", {"annotations": []})
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux(["rw-alive"]))
    assert not any("rw-alive" in f for f in findings)


# --- tmux absent degrades gracefully ----------------------------------------------

def test_tmux_absent_skips_dependent_checks_with_a_note(research_dir):
    research = _healthy_research()
    research["sessions"].append({
        "id": "s2", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 09:00",
        "status": "running", "report": "", "worker": True,
    })
    _write_research(research)
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", ["rw-dead"])
    store.write("annotations.json", {"annotations": []})

    findings, notes, _fixes = doctor.run(tmux_fn=_absent_tmux)

    assert not any("not live" in f for f in findings)
    assert not any("rw-dead" in f for f in findings)
    assert any("tmux" in n.lower() for n in notes)


# --- healthy seed ------------------------------------------------------------------

def test_healthy_seed_reports_nothing(research_dir):
    _seed_healthy(research_dir)
    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert findings == []


def test_main_exits_zero_when_healthy(research_dir, monkeypatch, capsys):
    import sys
    _seed_healthy(research_dir)
    monkeypatch.setattr(doctor.shared, "tmux", _fake_tmux([]))
    monkeypatch.setattr(sys, "argv", ["research_doctor.py"])
    with pytest.raises(SystemExit) as exc:
        doctor.main()
    assert exc.value.code == 0
    assert "healthy" in capsys.readouterr().out


def test_main_exits_one_with_findings(research_dir, monkeypatch, capsys):
    import sys
    research = _healthy_research()
    research["entries"][0]["reply_to"] = "nope"
    _write_research(research)
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": []})
    monkeypatch.setattr(doctor.shared, "tmux", _fake_tmux([]))
    monkeypatch.setattr(sys, "argv", ["research_doctor.py"])
    with pytest.raises(SystemExit) as exc:
        doctor.main()
    assert exc.value.code == 1
    assert "nope" in capsys.readouterr().out


# --- --fix: repairs exactly the safe three, leaves the rest alone ------------------

def test_fix_repairs_safe_three_and_leaves_dangling_reply_to(research_dir):
    research = _healthy_research()
    research["entries"][0]["reply_to"] = "does-not-exist"  # unfixable, report-only forever
    research["sessions"].append({
        "id": "s2", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 09:00",
        "status": "running", "report": "", "worker": True,
    })
    _write_research(research)
    store.write("research_vectors.json", {"vectors": [
        {"id": "entry:q1", "content": "Why?", "embedding": [0.1]},
        {"id": "note:note1.md", "content": "# Note One\n\nsome content", "embedding": [0.2]},
        {"id": "entry:orphan", "content": "x", "embedding": [0.3]},
    ]})
    store.write("sessions.json", ["chat", "rw-dead", "rw-s2"])
    store.write("annotations.json", {"annotations": []})

    findings, _notes, fixes = doctor.run(fix=True, tmux_fn=_fake_tmux([]))

    # Fixable faults are gone.
    sessions = store.read("research.json")["sessions"]
    s2 = next(s for s in sessions if s["id"] == "s2")
    assert s2["status"] == "queued"
    assert s2["attempts"] == 1

    vector_ids = {v["id"] for v in store.read("research_vectors.json")["vectors"]}
    assert vector_ids == {"entry:q1", "note:note1.md"}

    # Both rw- names were absent from the live set, so both are dropped;
    # "chat" (not an rw- name) survives untouched.
    assert store.read("sessions.json") == ["chat"]

    # Unfixable finding survives.
    assert any("does-not-exist" in f for f in findings)
    assert len(fixes) == 3

    # Entries, topics, and annotations were never touched.
    research_after = store.read("research.json")
    assert research_after["entries"] == research["entries"]
    assert research_after["topics"] == research["topics"]


def test_fix_is_a_noop_write_by_default(research_dir):
    """Without --fix, run() makes zero writes — a dead worker session stays
    exactly as seeded."""
    research = _healthy_research()
    research["sessions"].append({
        "id": "s2", "entry_ids": ["q1"], "topics": [], "created": "2026-07-07 09:00",
        "status": "running", "report": "", "worker": True,
    })
    _write_research(research)
    store.write("research_vectors.json", {"vectors": [{"id": "entry:orphan", "content": "x", "embedding": [0.1]}]})
    store.write("sessions.json", ["rw-dead"])
    store.write("annotations.json", {"annotations": []})

    doctor.run(fix=False, tmux_fn=_fake_tmux([]))

    sessions = store.read("research.json")["sessions"]
    s2 = next(s for s in sessions if s["id"] == "s2")
    assert s2["status"] == "running"
    assert "attempts" not in s2
    assert store.read("research_vectors.json")["vectors"] == [{"id": "entry:orphan", "content": "x", "embedding": [0.1]}]
    assert store.read("sessions.json") == ["rw-dead"]


# --- --devnote: replace-not-append --------------------------------------------------

def test_devnote_posts_summary_when_findings_exist(research_dir):
    research = _healthy_research()
    research["entries"][0]["reply_to"] = "nope"
    _write_research(research)
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": []})

    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    doctor._post_devnote(findings)

    notes = store.read("dev_notes.json")["tabs"]["research"]
    doctor_notes = [n for n in notes if n["text"].startswith("[doctor] ")]
    assert len(doctor_notes) == 1
    assert str(len(findings)) in doctor_notes[0]["text"]


def test_devnote_replaces_not_appends_and_clears_when_healthy(research_dir):
    # Pre-existing unrelated note + a stale doctor note from a previous run.
    store.write("dev_notes.json", {"tabs": {"research": [
        {"id": "keep1", "text": "unrelated note", "created": "2026-07-01 09:00"},
        {"id": "old-doctor", "text": "[doctor] 1 finding(s): something stale", "created": "2026-07-06 09:00"},
    ]}})

    research = _healthy_research()
    research["entries"][0]["reply_to"] = "nope"
    _write_research(research)
    store.write("research_vectors.json", {"vectors": []})
    store.write("sessions.json", [])
    store.write("annotations.json", {"annotations": []})

    findings, _notes, _fixes = doctor.run(tmux_fn=_fake_tmux([]))
    assert findings
    doctor._post_devnote(findings)

    notes = store.read("dev_notes.json")["tabs"]["research"]
    doctor_notes = [n for n in notes if n["text"].startswith("[doctor] ")]
    assert len(doctor_notes) == 1
    assert doctor_notes[0]["id"] != "old-doctor"  # replaced, not edited in place
    assert any(n["id"] == "keep1" for n in notes)  # unrelated note untouched

    # Now heal the data and re-run — the doctor note should disappear.
    _seed_healthy(research_dir)
    findings2, _notes2, _fixes2 = doctor.run(tmux_fn=_fake_tmux([]))
    assert findings2 == []
    doctor._post_devnote(findings2)

    notes_after = store.read("dev_notes.json")["tabs"]["research"]
    assert not any(n["text"].startswith("[doctor] ") for n in notes_after)
    assert any(n["id"] == "keep1" for n in notes_after)
