"""Pure-core tests for textanchor.py — the TextSelector logic.

No fixtures needed: the module does zero I/O, so these run against plain
strings.
"""
import textanchor as ta


# --- make_selector: bounds -----------------------------------------------

def test_make_selector_happy_path():
    text = "the quick brown fox"
    sel = ta.make_selector(text, 4, 9)
    assert sel == {"exact": "quick", "char_start": 4, "char_end": 9}


def test_make_selector_out_of_bounds_end_is_none():
    assert ta.make_selector("short", 0, 100) is None


def test_make_selector_negative_start_is_none():
    assert ta.make_selector("short", -1, 3) is None


def test_make_selector_start_equal_end_is_none():
    assert ta.make_selector("short", 2, 2) is None


def test_make_selector_start_after_end_is_none():
    assert ta.make_selector("short", 4, 2) is None


def test_make_selector_non_int_offsets_is_none():
    assert ta.make_selector("short", "a", "b") is None
    assert ta.make_selector("short", None, None) is None


# --- verify ---------------------------------------------------------------

def test_verify_happy():
    text = "the quick brown fox"
    sel = ta.make_selector(text, 4, 9)
    assert ta.verify(text, sel) is True


def test_verify_miss_when_text_shifted():
    text = "the quick brown fox"
    sel = ta.make_selector(text, 4, 9)
    shifted = "the slow brown fox"
    assert ta.verify(shifted, sel) is False


def test_verify_miss_when_range_now_out_of_bounds():
    sel = {"exact": "quick", "char_start": 4, "char_end": 9}
    assert ta.verify("hi", sel) is False


# --- relocate ---------------------------------------------------------------

def test_relocate_picks_nearest_of_three_occurrences():
    # "fox" appears three times; the selector's original char_start (30) is
    # nearest the middle occurrence, not the first or last.
    text = "fox " + ("x" * 20) + " fox " + ("y" * 5) + "fox"
    first = text.index("fox")
    middle = text.index("fox", first + 1)
    last = text.index("fox", middle + 1)
    sel = {"exact": "fox", "char_start": middle, "char_end": middle + 3}
    # Shift the text so the exact quote no longer sits at char_start=middle
    # (simulate drift) while all three occurrences still exist.
    drifted = "PREFIX " + text
    new_first = drifted.index("fox")
    new_middle = drifted.index("fox", new_first + 1)
    new_last = drifted.index("fox", new_middle + 1)
    relocated = ta.relocate(drifted, sel)
    assert relocated is not None
    # sel.char_start (middle, pre-drift) is nearest new_middle among the three.
    assert relocated["char_start"] == new_middle
    assert relocated not in (
        {"exact": "fox", "char_start": new_first, "char_end": new_first + 3},
        {"exact": "fox", "char_start": new_last, "char_end": new_last + 3},
    )


def test_relocate_after_prefix_insertion_shifts_forward():
    original = "the quick brown fox jumps"
    sel = ta.make_selector(original, 4, 9)  # "quick"
    assert ta.verify(original, sel) is True
    shifted = "NOTE: " + original
    assert ta.verify(shifted, sel) is False
    relocated = ta.relocate(shifted, sel)
    assert relocated is not None
    assert relocated["exact"] == "quick"
    assert shifted[relocated["char_start"]:relocated["char_end"]] == "quick"


def test_relocate_lost_when_quote_deleted():
    original = "the quick brown fox"
    sel = ta.make_selector(original, 4, 9)  # "quick"
    edited = "the slow brown fox"
    assert ta.relocate(edited, sel) is None


# --- resolve ---------------------------------------------------------------

def test_resolve_verified():
    text = "the quick brown fox"
    sel = ta.make_selector(text, 4, 9)
    result = ta.resolve(text, sel)
    assert result == {"state": "verified", "selector": sel}


def test_resolve_relocated():
    original = "the quick brown fox"
    sel = ta.make_selector(original, 4, 9)
    shifted = "NOTE: " + original
    result = ta.resolve(shifted, sel)
    assert result["state"] == "relocated"
    assert result["selector"]["exact"] == "quick"
    assert result["selector"] != sel


def test_resolve_lost_keeps_original_selector():
    original = "the quick brown fox"
    sel = ta.make_selector(original, 4, 9)
    edited = "the slow brown fox"
    result = ta.resolve(edited, sel)
    assert result == {"state": "lost", "selector": sel}


# --- malformed selectors never raise ---------------------------------------

def test_malformed_selectors_dont_raise():
    text = "the quick brown fox"
    malformed = [None, {}, "not a dict", 42, [],
                 {"exact": "quick"},  # missing offsets
                 {"char_start": 4, "char_end": 9},  # missing exact
                 {"exact": "", "char_start": 4, "char_end": 9},  # blank exact
                 {"exact": "quick", "char_start": "4", "char_end": 9},  # str offset
                 {"exact": "quick", "char_start": True, "char_end": 9},  # bool offset
                 ]
    for sel in malformed:
        assert ta.verify(text, sel) is False
        assert ta.relocate(text, sel) is None
        result = ta.resolve(text, sel)
        assert result["state"] == "lost"
        assert result["selector"] is sel
