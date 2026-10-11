#!/usr/bin/env python3
"""triage.py — decides which dev notes the night crew is ALLOWED to attempt.

Plain English: overnight agents fix small bugs from the dev notes while the
owner sleeps. This file is the gate in front of them. It never decides whether
a note is a *good idea* — it only checks verifiable facts about the note's
text and flags, and rejects anything it can't vouch for.

THE LAW (Terra, 2026-08-01): a filter is not a judge. Saying "this sentence
contains the word maybe" is a fact this file can check. Saying "this looks
like an easy fix" is a claim about code that isn't in front of it — that would
be faking a certainty it doesn't have, so it is never made here. Every
rejection below points at a literal substring or a missing flag, and every
rejection carries the reason so the UI can show her why.

Two locks, and neither one is an agent's opinion:
  1. She taps ✓ on the note   → an `approved` judgment on the note (devnote_judgments.py).
  2. These rules reject it anyway if the text disqualifies it.

Lock 2 exists because lock 1 happens at 11 PM when she's tired. A design that
needs her to be careful is brittle; she should be allowed to tap wrong.

Touches: scripts/nightcrew_preview.py (runs this over the real dev_notes.json
with lock 1 forced open), scripts/nightcrew_run.py (the consumer that matters),
routes/nightcrew.py (serves the result), tests/test_nightcrew_triage.py.

Prompt that produced this: "automate the easy tasks ... simple bugs that I put
in my dev notes ... these fixes run at night" — with the triage fork cut to
hand-pick + regex filter rather than an agent classifying the notes.
"""
import os
import re
import sys

# The judgment record lives at the repo root beside store.py. This module is
# imported both as `tools.nightcrew.triage` (by the routes) and directly by the
# cron script, so the root has to be on the path either way.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import devnote_judgments  # noqa: E402

# --- the disqualifying vocabulary -------------------------------------------
# Each entry is a literal shape found in the real dev notes that marks work the
# crew cannot finish unattended. Grouped by WHY, because the reason is shown to
# her in the UI and a bare "rejected" would be useless.

# Underspecified: the note is thinking out loud, not describing a fix. The word
# is the tell — a note that says "maybe" hasn't decided what it wants yet, and
# an agent handed an undecided note invents the decision.
HEDGE_WORDS = (
    "maybe",
    "figure out",
    "unclear",
    "not sure",
    "some kind of",
    "some sort of",
    "i wonder",
    "rethink",
    "unsure",
    "idk",
    # Her idiom for "not decided yet", added when the crew started nominating
    # notes itself: with no owner tap in front of these, the words that mark a
    # note as a conversation ("go plan mode and talk about this", "get rid of
    # it somehow") have to be caught here or an agent turn gets spent
    # discovering it.
    "somehow",
    "plan mode",
    "discuss",
    "talk about",
)

# Device-bound: only reproducible on hardware the crew can't reach. Playwright
# drives a desktop browser, so a fix aimed at the iOS keyboard or the installed
# PWA gets verified against something that isn't where the bug lives — the
# worst outcome available, because it comes back green and wrong.
DEVICE_WORDS = (
    "pwa",
    "ios",
    "iphone",
    "apple",
    "swift",
    "native app",
    "on my phone",
    "keyboard",
    "geogat",
    "push notification",
)

# Structural: changes the data model or spans subsystems. These are the notes
# that look small and aren't — a schema move at 3 AM against the live vault is
# the thing this whole design exists to prevent.
STRUCTURAL_WORDS = (
    "dependent on",
    "contingent upon",
    "depends on",
    "nesting",
    "nested",
    "sub-item",
    "sub item",
    "migrat",
    "schema",
    "backend",
    "database",
    "cron",
    "sudo",
)

# Already handled: she annotates notes in place when she fixes them. A note
# carrying its own fix-marker is a candidate for retirement, not for work.
DONE_MARKERS = (
    "[fix",
    "done]",
    "i think i fixed",
    "already fixed",
    "[symptom defs done",
)

# Additive: asks for something that does not exist yet. The distinction that
# actually separates the crew's diet from the rest isn't tone, it's shape —
# a fixable note is IMPERATIVE ON AN EXISTING ELEMENT ("move the entry form to
# the top", "re-add the edit button"), while a feature is ADDITIVE ON A NOUN
# ("a way to track X", "a mood tracker"). Both can be short and confidently
# worded, which is why the hedge list alone let features through on the first
# real run (54% of notes passed; eyeballing said most of those were features).
FEATURE_WORDS = (
    "consider",
    "a way to",
    "ability to",
    "a setting for",
    "a list of",
    "priority list",
    "tracker",
    "scanner",
    "estimated",
    "predict",
    "learn how",
    "look into",
    "see if there",
    "research",
    "integrat",
)

# A note longer than this is a specification, not a bug report. Length is a
# proxy for scope and it is a fact about the text, not a judgment about the
# code — which is why it's allowed to live in this file.
MAX_CHARS = 240

# Below this, the note isn't a description of anything ("Soil", "Save old").
# She writes these as reminders to herself; an agent handed one invents the
# entire task. Held at 15 deliberately: "Add a search for to-dos" is 23 chars
# and is exactly the crew's diet, so the floor has to sit well under it. The
# test suite pins that note, which is how a greedier floor gets caught.
MIN_CHARS = 15

# Enumerated clauses ("(1) ... (2) ...") mark a note carrying several asks in
# one body. The crew does one thing per branch, so a compound note has no
# single answer to "did it work".
_ENUMERATED = re.compile(r"\(\s*[23]\s*\)")


def _found(text, needles):
    """The first needle present in `text`, or None. Callers pass already
    lowercased text; the needles are lowercase by construction."""
    for n in needles:
        if n in text:
            return n
    return None


def check(note):
    """Decide one note. Returns (eligible: bool, reason: str).

    `reason` is written to be shown to her verbatim, so it names the actual
    trigger ("says 'maybe'") rather than a rule id she'd have to look up.
    A note that passes gets reason "" — there is nothing to explain about a
    note the crew is simply allowed to try.
    """
    if not isinstance(note, dict):
        return False, "not a note"

    text = (note.get("text") or "").strip()
    if not text:
        return False, "empty note"

    # Lock 1. Her verdict on the note — `approved` is the green light. Most
    # notes are simply unjudged, which is the normal case, not an error.
    # (Was a `night: true` boolean until 2026-08-11; the judgment record
    # replaced it so a verdict could say more than yes/no — devnote_judgments.py.)
    if not devnote_judgments.is_green_lit(note):
        return False, "not green-lit"

    low = text.lower()

    # Lock 2, in the order she'd want to hear about them: a note that is BOTH
    # already-done and device-bound should report already-done, because that's
    # the one that changes what she does next (retire it).
    hit = _found(low, DONE_MARKERS)
    if hit:
        return False, f"looks already done — carries {hit!r}"

    hit = _found(low, HEDGE_WORDS)
    if hit:
        return False, f"still thinking out loud — says {hit!r}"

    hit = _found(low, DEVICE_WORDS)
    if hit:
        return False, f"device-bound — mentions {hit!r}, the crew can't verify it"

    hit = _found(low, STRUCTURAL_WORDS)
    if hit:
        return False, f"structural — mentions {hit!r}, not a one-branch change"

    hit = _found(low, FEATURE_WORDS)
    if hit:
        return False, f"a feature, not a fix — asks for {hit!r}"

    # A leading caret is how she continues the note above it, so the text in
    # front of us is only half the thought.
    if text.startswith("^"):
        return False, "a continuation of the note above it, not a standalone ask"

    if len(text) > MAX_CHARS:
        return False, f"too long ({len(text)} chars) — reads as a spec, not a bug"

    if len(text) < MIN_CHARS:
        return False, f"too short ({len(text)} chars) — a reminder, not a description"

    if _ENUMERATED.search(text):
        return False, "several asks in one note — split it first"

    return True, ""


def triage(notes_by_tab):
    """Run `check` across the whole `{"tabs": {tab: [note, ...]}}` structure.

    Returns {"eligible": [...], "rejected": [...]}, each entry carrying the
    note's id, tab and text alongside the verdict — the report and the UI both
    read this shape, so the reason travels with the note rather than being
    re-derived downstream.
    """
    eligible, rejected = [], []
    for tab, notes in (notes_by_tab or {}).items():
        for note in notes or []:
            ok, reason = check(note)
            row = {
                "id": (note or {}).get("id"),
                "tab": tab,
                "text": ((note or {}).get("text") or "").strip(),
            }
            if ok:
                eligible.append(row)
            else:
                # "not green-lit" is the resting state of almost every note;
                # carrying ~190 of them into the report would bury the handful
                # she actually flagged and got turned down.
                if reason != "not green-lit":
                    rejected.append({**row, "reason": reason})
    return {"eligible": eligible, "rejected": rejected}
