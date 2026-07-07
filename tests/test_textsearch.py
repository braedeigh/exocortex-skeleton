"""Behavioral tests for the pure search core (textsearch.py).

Pure module, no fixtures needed beyond plain data — no store, no data_dir.
"""
import math

import textsearch as ts


# --- parse_query ---------------------------------------------------------------

def test_parse_plain_terms_lowercased():
    assert ts.parse_query("Sleep Melatonin") == {
        "phrases": [], "terms": ["sleep", "melatonin"], "excluded": [],
    }


def test_parse_quoted_phrase():
    parsed = ts.parse_query('"circadian rhythm" light')
    assert parsed["phrases"] == ["circadian rhythm"]
    assert parsed["terms"] == ["light"]
    assert parsed["excluded"] == []


def test_parse_negation():
    parsed = ts.parse_query("sleep -caffeine")
    assert parsed["terms"] == ["sleep"]
    assert parsed["excluded"] == ["caffeine"]


def test_parse_mixed_phrase_term_negation():
    parsed = ts.parse_query('"blue light" melatonin -screens')
    assert parsed["phrases"] == ["blue light"]
    assert parsed["terms"] == ["melatonin"]
    assert parsed["excluded"] == ["screens"]


def test_parse_empty_and_malformed_never_error():
    assert ts.parse_query("") == {"phrases": [], "terms": [], "excluded": []}
    assert ts.parse_query("   ") == {"phrases": [], "terms": [], "excluded": []}
    assert ts.parse_query(None) == {"phrases": [], "terms": [], "excluded": []}
    assert ts.parse_query(123) == {"phrases": [], "terms": [], "excluded": []}
    # unterminated quote — still no crash, no bogus phrase
    parsed = ts.parse_query('"unterminated melatonin')
    assert parsed["phrases"] == []
    assert "melatonin" in parsed["terms"]


def test_parse_lone_dash_ignored():
    parsed = ts.parse_query("sleep - well")
    assert parsed["terms"] == ["sleep", "well"]
    assert parsed["excluded"] == []


# --- keyword_search --------------------------------------------------------------

DOCS = [
    {"id": "a", "title": "Melatonin timing", "text": "Melatonin helps with sleep onset."},
    {"id": "b", "title": "", "text": "Caffeine blocks adenosine and can disrupt sleep."},
    {"id": "c", "title": "", "text": "Sleep sleep sleep — a doc that repeats the word sleep a lot."},
    {"id": "d", "title": "", "text": "Nothing relevant here about diet."},
]


def test_keyword_search_matches_word_boundary_term():
    hits = ts.keyword_search("sleep", DOCS)
    ids = {h["id"] for h in hits}
    assert ids == {"a", "b", "c"}
    assert "d" not in ids


def test_keyword_search_excludes_docs_with_excluded_term():
    hits = ts.keyword_search("sleep -caffeine", DOCS)
    ids = {h["id"] for h in hits}
    assert "b" not in ids
    assert ids == {"a", "c"}


def test_keyword_search_phrase_requires_full_substring():
    docs = [
        {"id": "x", "title": "", "text": "circadian rhythm disruption"},
        {"id": "y", "title": "", "text": "circadian misalignment, no rhythm mentioned"},
    ]
    hits = ts.keyword_search('"circadian rhythm"', docs)
    assert [h["id"] for h in hits] == ["x"]


def test_keyword_search_empty_parse_returns_no_hits():
    assert ts.keyword_search("", DOCS) == []
    assert ts.keyword_search("   ", DOCS) == []


def test_keyword_search_scores_frequency_and_title_double_then_id_tiebreak():
    # "sleep" appears 3x in c's body (score higher than a's single occurrence),
    # and title matches score double — a's title mention should outrank a
    # same-frequency body-only doc.
    hits = ts.keyword_search("sleep", DOCS)
    by_id = {h["id"]: h["score"] for h in hits}
    assert by_id["c"] > by_id["a"] > 0
    assert by_id["a"] > by_id["b"]  # "b" only 1 body hit, no title hit
    scores = [h["score"] for h in hits]
    assert scores == sorted(scores, reverse=True)


def test_keyword_search_tie_break_by_id_ascending():
    docs = [
        {"id": "z", "title": "", "text": "widget"},
        {"id": "a", "title": "", "text": "widget"},
    ]
    hits = ts.keyword_search("widget", docs)
    assert [h["id"] for h in hits] == ["a", "z"]


def test_keyword_search_truncates_to_limit():
    docs = [{"id": str(i), "title": "", "text": "widget"} for i in range(10)]
    hits = ts.keyword_search("widget", docs, limit=3)
    assert len(hits) == 3


# --- make_snippet ----------------------------------------------------------------

def test_make_snippet_windows_around_hit():
    text = "x" * 100 + "NEEDLE" + "y" * 100
    snippet = ts.make_snippet(text, "NEEDLE", radius=10)
    assert "NEEDLE" in snippet
    assert snippet.startswith("…")
    assert snippet.endswith("…")
    assert len(snippet) < len(text)


def test_make_snippet_no_cut_ellipsis_when_hit_near_edges():
    text = "NEEDLE and a bit more text after it but not too much"
    snippet = ts.make_snippet(text, "NEEDLE", radius=60)
    assert not snippet.startswith("…")  # hit was at position 0, nothing cut before it


def test_make_snippet_needle_not_found_returns_head():
    text = "a" * 500
    snippet = ts.make_snippet(text, "zzz not present", radius=60)
    assert snippet == text[:120]


def test_make_snippet_case_insensitive():
    text = "The MELATONIN response kicks in at dusk."
    snippet = ts.make_snippet(text, "melatonin", radius=5)
    assert "MELATONIN" in snippet


# --- cosine ----------------------------------------------------------------------

def test_cosine_identical_vectors_is_one():
    assert math.isclose(ts.cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]), 1.0)


def test_cosine_orthogonal_vectors_is_zero():
    assert math.isclose(ts.cosine([1.0, 0.0], [0.0, 1.0]), 0.0, abs_tol=1e-9)


def test_cosine_zero_vector_is_zero_not_error():
    assert ts.cosine([0.0, 0.0], [1.0, 2.0]) == 0.0
    assert ts.cosine([], [1.0]) == 0.0
    assert ts.cosine([1.0], []) == 0.0


# --- vector_topk -------------------------------------------------------------------

def test_vector_topk_orders_by_similarity_desc():
    vectors = [
        {"id": "far", "embedding": [0.0, 1.0]},
        {"id": "near", "embedding": [1.0, 0.0]},
        {"id": "exact", "embedding": [2.0, 0.0]},
    ]
    ranked = ts.vector_topk([1.0, 0.0], vectors)
    assert [r["id"] for r in ranked] == ["exact", "near", "far"]
    assert ranked[0]["score"] > ranked[-1]["score"]


def test_vector_topk_tie_break_by_id_and_truncates():
    vectors = [
        {"id": "b", "embedding": [1.0, 0.0]},
        {"id": "a", "embedding": [1.0, 0.0]},
        {"id": "c", "embedding": [1.0, 0.0]},
    ]
    ranked = ts.vector_topk([1.0, 0.0], vectors, limit=2)
    assert [r["id"] for r in ranked] == ["a", "b"]


# --- stale_ids / orphan_ids --------------------------------------------------------

def test_stale_ids_missing_vector():
    docs = [{"id": "a", "text": "hello", "title": ""}]
    assert ts.stale_ids(docs, []) == ["a"]


def test_stale_ids_changed_content():
    docs = [{"id": "a", "text": "hello world", "title": ""}]
    vectors = [{"id": "a", "content": "hello", "embedding": [1.0]}]
    assert ts.stale_ids(docs, vectors) == ["a"]


def test_stale_ids_skips_blank_doc():
    docs = [{"id": "a", "text": "   ", "title": ""}]
    assert ts.stale_ids(docs, []) == []


def test_stale_ids_up_to_date_is_not_stale():
    docs = [{"id": "a", "text": "hello", "title": ""}]
    vectors = [{"id": "a", "content": "hello", "embedding": [1.0]}]
    assert ts.stale_ids(docs, vectors) == []


def test_orphan_ids_vector_with_no_doc():
    docs = [{"id": "a", "text": "hello", "title": ""}]
    vectors = [{"id": "a", "content": "hello", "embedding": [1.0]},
               {"id": "gone", "content": "x", "embedding": [1.0]}]
    assert ts.orphan_ids(docs, vectors) == ["gone"]


def test_orphan_ids_vector_for_now_blank_doc():
    docs = [{"id": "a", "text": "", "title": ""}]
    vectors = [{"id": "a", "content": "hello", "embedding": [1.0]}]
    assert ts.orphan_ids(docs, vectors) == ["a"]
