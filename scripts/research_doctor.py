#!/usr/bin/env python3
"""scripts/research_doctor.py — read-only integrity checker for the research
subsystem (research.json, annotations.json, research_vectors.json,
sessions.json, and the research/*.md corpus on disk).

A "doctor" (the validate/doctor idea a lot of systems borrow from Rails'
`db:schema:dump` cousins and Elixir's `mix ecto.*` checks) is a script that
walks live data end to end and reports where it disagrees with itself —
dangling references, orphaned rows, state that drifted out from under a
crashed process — without touching anything. It exists because the research
subsystem is stitched together from several independently-mutating files
(research.json, annotations.json, research_vectors.json, sessions.json, the
research/ markdown tree, plus tmux as a fifth, external, best-effort source
of truth) and nothing enforces referential integrity across that boundary
the way a real database's foreign keys would. Bugs and half-applied crashes
show up as small, silent inconsistencies — a session stuck "running" behind
a tmux pane that died, a vector for an entry that got deleted — that no
single route notices because no single route reads the whole picture.

Report-only by default: printing what's wrong is always safe, so that's the
default and the thing cron can run unattended every time. Only `--fix`
mutates anything, and even then it repairs only faults with one obvious
correct answer — a dead worker session's next state is exactly what the
dispatcher's own recovery policy says it is, an orphan vector's only
sensible fate is deletion, a stale tmux tab name's only sensible fate is
removal. Anything with editorial judgment involved (a dangling reply_to, a
duplicate id, an illegal verdict) is report-only forever — those need a
human to look at the entry, not a script guessing what she meant.

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/research_doctor.py
    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/research_doctor.py --fix
    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/research_doctor.py --devnote

Exit code is 0 when healthy, 1 when findings remain (after `--fix`, if
given). `--devnote` posts (or clears) one `[doctor] ...` summary note on the
"research" tab of dev_notes.json — meant for a future cron tick, so the
finding surfaces somewhere she'll actually see it without tailing a log.

Tmux access goes through one helper (`_tmux_live_names`, wrapping the
research dispatcher's own `list_live_workers`) so tests can fake it and so
the two tmux-dependent checks degrade gracefully — printed as a note, not a
crash — on a box where tmux isn't installed at all.
"""
import argparse
import os
import sys
from datetime import datetime, timedelta

# Make the skeleton root importable regardless of where the script is invoked
# from (mirrors scripts/worker_apply_result.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
import docstore  # noqa: E402
from routes.research import CLAIM_VERDICTS, SOURCE_VERDICTS, QUESTION_STATUSES  # noqa: E402
from routes.kitchen import shared  # noqa: E402
from routes import research_search  # noqa: E402
from scripts import research_dispatcher as dispatcher  # noqa: E402

QUEUED_STALE_AFTER = timedelta(hours=24)
DEVNOTE_TAB = "research"
DEVNOTE_PREFIX = "[doctor] "


# --- tmux (the one seam; degrades to "unavailable" instead of crashing) -----

def _tmux_live_names(tmux_fn):
    """(live rw- names, available). `dispatcher.list_live_workers` already
    treats "tmux ran but nothing's live" as an empty set with no error; this
    only trips `available = False` when tmux itself couldn't be invoked at
    all (missing binary, no shell, etc — real absence, not just an empty
    server), so tests can simulate "tmux absent" with a raising fake."""
    try:
        return dispatcher.list_live_workers(tmux_fn), True
    except OSError:
        return set(), False


# --- checks (each a pure function: data in, finding strings out) ------------

def check_reply_to_graph(research):
    """1. Every non-null reply_to resolves to an existing entry; the
    reply_to graph is acyclic."""
    entries = research.get("entries", [])
    by_id = {e.get("id"): e for e in entries}
    findings = []
    for e in entries:
        rt = e.get("reply_to")
        if rt is not None and rt not in by_id:
            findings.append(f"entry {e.get('id')}: reply_to {rt!r} does not exist")

    reported = set()
    state = {}  # id -> 1 (in progress on the current walk) | 2 (done, acyclic)
    for start in by_id:
        if state.get(start) == 2:
            continue
        path = []
        cur = start
        while cur is not None and cur in by_id and state.get(cur) != 2:
            if state.get(cur) == 1:
                idx = path.index(cur)
                cycle = tuple(sorted(path[idx:]))
                if cycle not in reported:
                    reported.add(cycle)
                    findings.append("reply_to cycle: " + " -> ".join(path[idx:] + [cur]))
                break
            state[cur] = 1
            path.append(cur)
            cur = by_id[cur].get("reply_to")
        for pid in path:
            state[pid] = 2
    return findings


def check_duplicate_ids_and_topic_refs(research):
    """2. Duplicate ids among entries/topics/sessions; every id in an
    entry's `topics` exists in data["topics"]."""
    findings = []
    for kind, items in (
        ("entry", research.get("entries", [])),
        ("topic", research.get("topics", [])),
        ("session", research.get("sessions", [])),
    ):
        seen = set()
        for it in items:
            iid = it.get("id")
            if iid in seen:
                findings.append(f"duplicate {kind} id: {iid!r}")
            seen.add(iid)

    topic_ids = {t.get("id") for t in research.get("topics", [])}
    for e in research.get("entries", []):
        for tid in e.get("topics") or []:
            if tid not in topic_ids:
                findings.append(f"entry {e.get('id')}: topic {tid!r} does not exist")
    return findings


def check_session_entry_links(research):
    """3. Every session's entry_ids all exist; every entry's `session` (if
    set) matches an existing session id."""
    findings = []
    entry_ids = {e.get("id") for e in research.get("entries", [])}
    session_ids = {s.get("id") for s in research.get("sessions", [])}
    for s in research.get("sessions", []):
        for eid in s.get("entry_ids") or []:
            if eid not in entry_ids:
                findings.append(f"session {s.get('id')}: entry_ids references missing entry {eid!r}")
    for e in research.get("entries", []):
        sid = e.get("session")
        if sid is not None and sid not in session_ids:
            findings.append(f"entry {e.get('id')}: session {sid!r} does not exist")
    return findings


def check_entry_files(research):
    """4. Every entry `file` (if set) points at an existing file under
    store.RESEARCH_DIR."""
    findings = []
    root = store.RESEARCH_DIR
    root_resolved = root.resolve() if root.exists() else root
    for e in research.get("entries", []):
        f = e.get("file")
        if not f:
            continue
        try:
            target = (root / f).resolve()
        except (OSError, ValueError):
            findings.append(f"entry {e.get('id')}: file {f!r} is a bad path")
            continue
        if not target.is_relative_to(root_resolved) or not target.is_file():
            findings.append(f"entry {e.get('id')}: file {f!r} not found under {root}")
    return findings


def check_annotations(annotations):
    """5. Every annotation resolves: docstore.resolve(a['doc']) is ok."""
    findings = []
    for a in annotations.get("annotations", []):
        doc = a.get("doc")
        res = docstore.resolve(doc)
        if not res.get("ok"):
            findings.append(f"annotation {a.get('id')}: doc {doc!r} does not resolve ({res.get('error')})")
    return findings


def check_worker_sessions(research, live_names, tmux_available, clock):
    """6. Worker sessions "running" whose tmux isn't live (tmux-dependent —
    skipped when tmux is unavailable); sessions "queued" for more than 24h
    (not tmux-dependent, always runs)."""
    findings = []
    now = clock()
    for s in research.get("sessions", []):
        if tmux_available and s.get("worker") and s.get("status") == "running":
            name = dispatcher.worker_tmux_name(s.get("id"))
            if name not in live_names:
                findings.append(f"session {s.get('id')}: status running but tmux {name!r} is not live")
        if s.get("status") == "queued":
            created = s.get("created")
            try:
                created_dt = datetime.strptime(created, "%Y-%m-%d %H:%M")
            except (TypeError, ValueError):
                findings.append(f"session {s.get('id')}: created stamp {created!r} is unparsable")
                continue
            if now - created_dt > QUEUED_STALE_AFTER:
                findings.append(f"session {s.get('id')}: queued since {created} (>24h)")
    return findings


def check_entry_field_legality(research):
    """7. `reviewed` present only on author=="llm" entries; `verdict` legal
    for the entry's kind; `status` legal for questions (and empty for
    everything else)."""
    findings = []
    for e in research.get("entries", []):
        eid = e.get("id")
        kind = e.get("kind")

        if "reviewed" in e and e.get("author") != "llm":
            findings.append(f"entry {eid}: 'reviewed' present but author is not 'llm'")

        if kind == "claim":
            allowed_verdict = CLAIM_VERDICTS
        elif kind == "source":
            allowed_verdict = SOURCE_VERDICTS
        else:
            allowed_verdict = ("",)
        verdict = e.get("verdict", "") or ""
        if verdict not in allowed_verdict:
            findings.append(f"entry {eid}: verdict {verdict!r} not legal for kind {kind!r}")

        allowed_status = QUESTION_STATUSES if kind == "question" else ("",)
        status = e.get("status", "") or ""
        if status not in allowed_status:
            findings.append(f"entry {eid}: status {status!r} not legal for kind {kind!r}")
    return findings


def check_vector_orphans(vectors, valid_ids):
    """8. research_vectors.json entries whose id doesn't exist in the
    corpus (entry:<id> for non-blank-text entries, note:<filename> for
    top-level research/*.md files — the exact id scheme
    routes/research_search.py's _corpus()/_reconcile_vectors use)."""
    findings = []
    for v in vectors.get("vectors", []):
        vid = v.get("id")
        if vid not in valid_ids:
            findings.append(f"research_vectors.json: vector {vid!r} has no corresponding corpus doc")
    return findings


def check_stale_tab_names(tab_names, live_names, tmux_available):
    """9. Names in sessions.json starting with `rw-` with no live tmux
    session behind them. Tmux-dependent — skipped when tmux is unavailable."""
    findings = []
    if not tmux_available:
        return findings
    for n in tab_names:
        if isinstance(n, str) and n.startswith("rw-") and n not in live_names:
            findings.append(f"sessions.json: tab {n!r} has no live tmux session")
    return findings


# --- orchestration ------------------------------------------------------------

def _valid_corpus_ids():
    docs, _sidecars = research_search._corpus()
    return {d["id"] for d in docs}


def _run_checks(live_names, tmux_available, valid_ids, clock):
    research = store.read("research.json", {"topics": [], "entries": [], "sessions": []})
    annotations = store.read("annotations.json", {"annotations": []})
    vectors = store.read("research_vectors.json", {"vectors": []})
    tab_names = store.read("sessions.json", [])

    findings = []
    findings += check_reply_to_graph(research)
    findings += check_duplicate_ids_and_topic_refs(research)
    findings += check_session_entry_links(research)
    findings += check_entry_files(research)
    findings += check_annotations(annotations)
    findings += check_entry_field_legality(research)
    findings += check_worker_sessions(research, live_names, tmux_available, clock)
    findings += check_stale_tab_names(tab_names, live_names, tmux_available)
    findings += check_vector_orphans(vectors, valid_ids)
    return findings


def _apply_fixes(live_names, tmux_available, valid_ids):
    """The safe subset only — each mutation is small enough to have exactly
    one obvious correct outcome. Never touches entries, topics, annotations,
    or files. Returns one human-readable line per repair actually made."""
    fixes = []

    if tmux_available:
        with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
            recovered = dispatcher.recover_dead_workers(data, live_names)
        if recovered:
            fixes.append(
                f"recovered {len(recovered)} dead worker session(s) via the dispatcher's "
                f"recovery policy: {', '.join(recovered)}"
            )

    with store.mutate("research_vectors.json", {"vectors": []}) as vdata:
        vectors = vdata.setdefault("vectors", [])
        keep = [v for v in vectors if v.get("id") in valid_ids]
        dropped = [v.get("id") for v in vectors if v.get("id") not in valid_ids]
        vectors[:] = keep
    if dropped:
        fixes.append(f"pruned {len(dropped)} orphan vector(s): {', '.join(dropped)}")

    if tmux_available:
        with store.mutate("sessions.json", []) as names:
            keep = [n for n in names if not (isinstance(n, str) and n.startswith("rw-") and n not in live_names)]
            dropped_tabs = [n for n in names if n not in keep]
            names[:] = keep
        if dropped_tabs:
            fixes.append(
                f"dropped {len(dropped_tabs)} stale rw- tab name(s) from sessions.json: "
                f"{', '.join(dropped_tabs)}"
            )

    return fixes


def run(fix=False, tmux_fn=None, clock=None):
    """One doctor pass. Returns (findings, notes, fixes) — `findings` are
    the current state (post-fix, if `fix` was given); `notes` are
    informational (e.g. tmux unavailable); `fixes` are repairs actually
    made."""
    tmux_fn = tmux_fn or shared.tmux
    clock = clock or datetime.now

    live_names, tmux_available = _tmux_live_names(tmux_fn)
    notes = []
    if not tmux_available:
        notes.append("tmux is unavailable — skipping the dead-worker-session and stale-tab-name checks")

    valid_ids = _valid_corpus_ids()

    findings = _run_checks(live_names, tmux_available, valid_ids, clock)

    fixes = []
    if fix:
        fixes = _apply_fixes(live_names, tmux_available, valid_ids)
        # Re-diagnose from the (possibly) mutated data so findings/exit code/
        # devnote reflect what's actually still wrong, not the pre-fix list.
        findings = _run_checks(live_names, tmux_available, valid_ids, clock)

    return findings, notes, fixes


def _post_devnote(findings):
    """Write/replace the doctor's own '[doctor] ...' note on the research
    tab, or remove it entirely when there's nothing to report. Direct store
    write — this is a script, not a route."""
    from routes.devnotes import load_dev_notes, save_dev_notes, _new_note

    d = load_dev_notes()
    tab_notes = d.setdefault("tabs", {}).setdefault(DEVNOTE_TAB, [])
    tab_notes[:] = [n for n in tab_notes if not str(n.get("text", "")).startswith(DEVNOTE_PREFIX)]
    if findings:
        preview = "; ".join(findings[:3])
        text = f"{DEVNOTE_PREFIX}{len(findings)} finding(s): {preview}"
        if len(findings) > 3:
            text += " ..."
        tab_notes.append(_new_note(text))
    save_dev_notes(d)


def main():
    parser = argparse.ArgumentParser(
        description="Read-only integrity checker for the research subsystem "
                     "(research.json, annotations.json, research_vectors.json, "
                     "sessions.json, research/*.md). Exits 0 healthy, 1 findings.",
    )
    parser.add_argument(
        "--fix", action="store_true",
        help="repair the safe subset: dead worker sessions, orphan vectors, "
             "stale rw- tab names. Everything else is report-only.",
    )
    parser.add_argument(
        "--devnote", action="store_true",
        help="post (or clear) a '[doctor] ...' summary note on dev_notes.json's research tab",
    )
    args = parser.parse_args()

    findings, notes, fixes = run(fix=args.fix)

    for note in notes:
        print(f"note: {note}")
    for fix_desc in fixes:
        print(f"fixed: {fix_desc}")
    if findings:
        print(f"{len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
    else:
        print("research subsystem: healthy")

    if args.devnote:
        _post_devnote(findings)

    sys.exit(1 if findings else 0)


if __name__ == "__main__":
    main()
