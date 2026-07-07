"""textanchor — pure text-selector core for the generic annotation layer.

Selector shape (the thing an annotation stores to point at a piece of text):

    {"exact": str, "char_start": int, "char_end": int}

0-indexed, half-open (`text[char_start:char_end]`) character range into a
document's flat extracted text. `exact` is the text slice captured at
creation time — kept around so a selector can be re-verified (or relocated)
later if the underlying document text shifts.

Pure, total, zero I/O: no file/network access, no clock, no env reads. A
malformed selector (missing keys, wrong types) never raises — every function
here treats it as data and degrades to a "not found" answer instead.
(Rust translation: a `core` crate with zero deps; `Option`/`Result`, no
`.unwrap()`.)
"""


def make_selector(text, char_start, char_end):
    """Build a selector for `text[char_start:char_end]`, or None if invalid.

    Invalid: out-of-bounds indices, start >= end, or an empty slice.
    """
    try:
        start = int(char_start)
        end = int(char_end)
    except (TypeError, ValueError):
        return None
    if start < 0 or end < 0 or start >= end or end > len(text):
        return None
    exact = text[start:end]
    if not exact:
        return None
    return {"exact": exact, "char_start": start, "char_end": end}


def _fields(sel):
    """Pull (exact, char_start, char_end) out of a selector, or None if the
    shape is malformed (not a dict, missing keys, wrong types, blank exact)."""
    if not isinstance(sel, dict):
        return None
    exact = sel.get("exact")
    start = sel.get("char_start")
    end = sel.get("char_end")
    if not isinstance(exact, str) or not exact:
        return None
    if not isinstance(start, int) or isinstance(start, bool):
        return None
    if not isinstance(end, int) or isinstance(end, bool):
        return None
    return exact, start, end


def verify(text, sel) -> bool:
    """True iff `text[sel.char_start:sel.char_end] == sel.exact`."""
    fields = _fields(sel)
    if fields is None:
        return False
    exact, start, end = fields
    if start < 0 or end > len(text) or start >= end:
        return False
    return text[start:end] == exact


def relocate(text, sel):
    """When `verify` would fail, look for `exact` elsewhere in `text` and
    return a new selector at the occurrence whose char_start is nearest the
    original one (exact ties broken by favoring the earlier occurrence).
    None when `exact` no longer occurs anywhere (the annotation is "lost")."""
    fields = _fields(sel)
    if fields is None:
        return None
    exact, start, _end = fields
    occurrences = []
    idx = text.find(exact)
    while idx != -1:
        occurrences.append(idx)
        idx = text.find(exact, idx + 1)
    if not occurrences:
        return None
    best = min(occurrences, key=lambda o: (abs(o - start), o))
    return {"exact": exact, "char_start": best, "char_end": best + len(exact)}


def resolve(text, sel):
    """Resolve a selector against the current text.

    Returns {"state": "verified"|"relocated"|"lost", "selector": sel'} where
    sel' is the original selector when verified or lost, and the relocated
    selector when relocated. Never raises, even on a malformed `sel`."""
    if verify(text, sel):
        return {"state": "verified", "selector": sel}
    relocated = relocate(text, sel)
    if relocated is not None:
        return {"state": "relocated", "selector": relocated}
    return {"state": "lost", "selector": sel}
