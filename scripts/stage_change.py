#!/usr/bin/env python3
"""stage_change.py — the narrow door into the pending approval queue.

routes/pending.py's `_commit()` is the ONLY place that actually applies an
approved change (shelling out to the add-todo/thread Rust binaries for
thread_open/thread_link/thread_retire/todo/life_todo/life_remove, or calling
routes/profile.py's `apply_profile_update` for "profile"). Today the only way
to get a change INTO that queue is the add-todo binary's `--stage` flag. This
script is the second door: a small, dependency-light CLI any agent (a Claude
session, an onboarding flow, a future integration) can shell out to in order
to *propose* a change — kind + a JSON payload — without ever writing
pending_changes.json (or any other data file) directly.

Validation happens here, BEFORE staging, so a bad proposal fails loudly with
a precise reason instead of silently queuing something `_commit()` will
choke on later (or a "profile" edit the schema would reject at approve
time). That's the agent-seam doctrine: one wrong shape, one clear rejection,
one retry — not a queued item the user finds broken in the approval modal.

    stage_change.py <kind> '<json-payload>' [--data-dir DIR]

`<kind>` must be one of the kinds routes/pending.py's `_commit()` knows how
to apply (see KNOWN_KINDS below). `<json-payload>` must parse as a JSON
object. For kind "profile" the payload is additionally checked against
schemas/profile.json (schemas.iter_violations) and restricted to the three
known profile keys (owner_name/owner_email/app_name) — routes/pending.py's
"profile" kind hands the payload straight to apply_profile_update with no
validation of its own, so this is the one place that catches a typo'd key or
a malformed email before it ever reaches the queue.

`--data-dir` points store.DATA_DIR at a specific directory (mirrors how
other scripts/ tools are pointed at data — see e.g. scripts/research_ctl.py's
EXOCORTEX_DATA_DIR usage); when omitted, store.DATA_DIR keeps whatever it
resolved to at import time (EXOCORTEX_DATA_DIR env var, or the built-in
data/ default — see store.py).

On success: appends {"id": <uuid4>, "kind": <kind>, "payload": <payload>} to
pending_changes.json via store.mutate (the atomic, lock-serialized write
path) and prints one JSON line to stdout:

    {"staged": true, "id": "...", "kind": "..."}

On failure: prints one JSON line to stderr, `{"error": "..."}`, and exits
nonzero. Nothing is staged.

Can also be imported and called directly:
    from scripts.stage_change import stage_change, KNOWN_KINDS
    entry = stage_change("profile", {"owner_name": "Rowan"})
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path

# Make the skeleton root importable regardless of where the script is
# invoked from (mirrors scripts/research_ctl.py / worker_apply_result.py).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
import schemas  # noqa: E402

# The kinds routes/pending.py's _commit() knows how to apply. Keep this in
# lockstep with that function's elif chain -- staging a kind _commit() can't
# handle would just wait forever in the queue, failing at approve time
# instead of at propose time.
KNOWN_KINDS = frozenset((
    "thread_open",
    "thread_link",
    "thread_retire",
    "todo",
    "life_todo",
    "life_remove",
    "todo_done",
    # Agent doors onto an existing to-do (todo_provenance.py): a short cited
    # note, or a patch of a few scheduling fields. Both land in the queue
    # tagged with the conversation that proposed them, so the sheet pops over
    # THAT Observatory pane rather than center-screen.
    "agent_note",
    "life_patch",
    "profile",
))

PENDING_FILE = "pending_changes"  # -> data/pending_changes.json, same key routes/pending.py uses

# routes/profile.py's apply_profile_update only ever looks at these three
# keys; anything else in a staged "profile" payload would silently do
# nothing at approve time, so it's rejected here instead.
_PROFILE_KEYS = frozenset(("owner_name", "owner_email", "app_name"))


class StageError(ValueError):
    """Raised by stage_change() for any validation failure -- unknown kind,
    non-object payload, or (for "profile") a schema violation / unknown key.
    A plain ValueError subclass so callers can catch either."""


def _validate_profile_payload(payload):
    """For kind "profile": reject keys outside the three known profile
    fields, then run the same schema the write seam (store.write's first
    line) would enforce at approve time -- surfacing violations now, before
    staging, is the whole point of validating here at all."""
    extra = sorted(set(payload) - _PROFILE_KEYS)
    if extra:
        raise StageError(
            "profile payload has unknown key(s): {}; allowed keys: {}".format(
                ", ".join(extra), ", ".join(sorted(_PROFILE_KEYS))
            )
        )
    violations = schemas.iter_violations("profile", payload)
    if violations:
        raise StageError("profile payload failed validation: " + "; ".join(violations))


def stage_change(kind, payload, summary=None, by=None, conv=None):
    """Validate `kind`/`payload` and append an entry to the pending queue.
    Returns the staged entry. Raises StageError (a ValueError) on any
    validation failure -- nothing is written in that case.

    The entry carries the same envelope the Rust stager writes (`summary`,
    `created`) plus two provenance fields: `by` (which agent proposed it) and
    `conv` (the Observatory conversation it came out of -- defaults to
    EXOCORTEX_CONV_ID, which the turn host sets, so a script an agent runs
    from a session is tagged without the agent knowing the id). The
    frontend uses `conv` to pop the approval over that conversation's pane."""
    if kind not in KNOWN_KINDS:
        raise StageError(
            "unknown change kind {!r}; valid kinds: {}".format(
                kind, ", ".join(sorted(KNOWN_KINDS))
            )
        )
    if not isinstance(payload, dict):
        raise StageError("payload must be a JSON object (got {})".format(type(payload).__name__))

    if kind == "profile":
        _validate_profile_payload(payload)
    if kind in ("agent_note", "life_patch"):
        # Fail at propose time, not approve time: the commit handler
        # (routes/pending.py) re-validates, but an agent should hear "no"
        # now, while it can still fix the note.
        import todo_provenance as prov
        try:
            if kind == "agent_note":
                prov.make_agent_note(payload.get("by") or by, payload.get("text"),
                                     payload.get("refs"), payload.get("conv") or conv)
            else:
                prov.clean_patch(payload.get("fields"))
                if payload.get("why"):
                    prov.clean_refs(payload.get("refs"))
        except prov.ProvenanceError as exc:
            raise StageError(str(exc))
        if not payload.get("id"):
            raise StageError("payload needs the target to-do's `id`")

    conv = conv or os.environ.get("EXOCORTEX_CONV_ID") or None
    entry = {"id": str(uuid.uuid4()), "kind": kind, "payload": payload,
             "created": datetime.now().strftime("%Y-%m-%d %H:%M")}
    if summary:
        entry["summary"] = summary
    if by:
        entry["by"] = by
    if conv:
        entry["conv"] = conv
    # A fresh literal each call -- NOT a shared module-level default -- since
    # data.setdefault(...).append() below mutates the list in place; reusing
    # one default object across calls would leak entries between an
    # unrelated data dir's staged item and this one.
    with store.mutate(PENDING_FILE, {"pending": []}) as data:
        data.setdefault("pending", []).append(entry)
    return entry


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="stage_change.py",
        description="Stage a proposed change into the pending approval queue "
                     "(routes/pending.py) without writing data files directly.",
    )
    parser.add_argument("kind", help="one of: " + ", ".join(sorted(KNOWN_KINDS)))
    parser.add_argument("payload", help="the change payload, as a JSON object")
    parser.add_argument(
        "--data-dir", default=None,
        help="override store.DATA_DIR (defaults to $EXOCORTEX_DATA_DIR, see store.py)",
    )
    parser.add_argument("--summary", default=None, help="one line the owner reads in the sheet")
    parser.add_argument("--by", default=None, help="which agent is proposing (e.g. triage)")
    parser.add_argument("--conv", default=None,
                        help="Observatory conversation id (default: $EXOCORTEX_CONV_ID)")
    args = parser.parse_args(argv)

    if args.data_dir:
        store.DATA_DIR = Path(args.data_dir)
        store.DATA_DIR.mkdir(parents=True, exist_ok=True)

    try:
        payload = json.loads(args.payload)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"payload is not valid JSON: {exc}"}), file=sys.stderr)
        return 1

    try:
        entry = stage_change(args.kind, payload, summary=args.summary, by=args.by, conv=args.conv)
    except StageError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps({"staged": True, "id": entry["id"], "kind": entry["kind"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
