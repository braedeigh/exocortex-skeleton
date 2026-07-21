"""Pure text + vector search core — no I/O, no env, no clock (→ a zero-dep
`search-core` Rust crate: every function here is data-in/data-out).

The owner's own labrador design (FTS + vector as two separate modes, no fusion,
no thresholds), ported: keyword search is a crude tf/length-normalized rank
(a hand-rolled analog of Postgres `ts_rank` over `websearch_to_tsquery`);
vector search is flat cosine top-k. Reconciliation (which docs need a fresh
embedding, which vectors are orphaned) is also pure — the caller (the route)
does the actual embedding I/O and just feeds the id lists back in.

Shapes (documented once here, not re-derived at call sites):
    Doc    = {"id": str, "text": str, "title": str}       # title may be ""
    Vector = {"id": str, "content": str, "embedding": [float]}
    a Doc's `id` matches the Vector `id` it was embedded from; `content` is
    the exact text that was embedded, so staleness is a plain string compare.

Divergence from labrador (documented, not a bug): labrador reconciles vectors
hourly via an Oban cron job; this port has no job queue, so the route
reconciles lazily at vector-search time instead (fine at personal-corpus
scale — see routes/research_search.py).
"""
import math
import re

_ELLIPSIS = "…"  # single-char ellipsis, cheap to eyeball in tests/logs


# --- query parsing (websearch_to_tsquery-style) ------------------------------

_PHRASE_RE = re.compile(r'"([^"]*)"')


def parse_query(q):
    """`"quoted strings"` -> phrases; `-tok` -> excluded; rest -> lowercase
    terms. Never raises: malformed or empty input (None, non-string, blank,
    an unterminated quote) just yields the all-empty dict — this mirrors
    Postgres's own `websearch_to_tsquery`, which never errors on bad input."""
    if not isinstance(q, str):
        return {"phrases": [], "terms": [], "excluded": []}
    phrases = [p.strip() for p in _PHRASE_RE.findall(q)]
    phrases = [p for p in phrases if p]
    remainder = _PHRASE_RE.sub(" ", q)
    terms, excluded = [], []
    for raw in remainder.split():
        tok = raw.strip('"')
        if not tok or tok == "-":
            continue
        if tok.startswith("-") and len(tok) > 1:
            t = tok[1:].strip('"').lower()
            if t:
                excluded.append(t)
        else:
            terms.append(tok.lower())
    return {"phrases": phrases, "terms": terms, "excluded": excluded}


# --- keyword search ------------------------------------------------------------

def _phrase_hits(haystack, phrase):
    if not phrase:
        return 0
    return haystack.lower().count(phrase.lower())


def _term_hits(haystack, term):
    if not term:
        return 0
    return len(re.findall(r"\b" + re.escape(term) + r"\b", haystack, re.IGNORECASE))


def keyword_search(q, docs, limit=20):
    """Match: every phrase is a case-insensitive substring and every term is a
    case-insensitive whole word (`\\b`-bounded) in `title + " " + text`; any
    excluded term present (same whole-word test) drops the doc entirely.
    Score: occurrence count of every phrase+term, title matches weighted 2x,
    normalized by sqrt(1 + word count of text) — a crude ts_rank analog
    (frequency, length-penalized). Sort score desc, id asc as tie-break.
    An empty parse (no phrases, no terms) is not "match everything" —
    it returns no hits, matching websearch semantics."""
    parsed = parse_query(q)
    phrases, terms, excluded = parsed["phrases"], parsed["terms"], parsed["excluded"]
    if not phrases and not terms:
        return []
    needles = phrases + terms
    hits = []
    for doc in docs:
        title = doc.get("title") or ""
        text = doc.get("text") or ""
        combined = f"{title} {text}"
        if any(_term_hits(combined, ex) > 0 for ex in excluded):
            continue
        if not all(_phrase_hits(combined, p) > 0 for p in phrases):
            continue
        if not all(_term_hits(combined, t) > 0 for t in terms):
            continue
        score = 0.0
        for p in phrases:
            score += _phrase_hits(text, p) + 2 * _phrase_hits(title, p)
        for t in terms:
            score += _term_hits(text, t) + 2 * _term_hits(title, t)
        score /= math.sqrt(1 + len(text.split()))
        needle = next((n for n in needles if n and n.lower() in text.lower()), needles[0])
        hits.append({"id": doc["id"], "score": score, "snippet": make_snippet(text, needle)})
    hits.sort(key=lambda h: (-h["score"], h["id"]))
    return hits[:limit]


def make_snippet(text, needle, radius=60):
    """A window of `radius` chars either side of the first case-insensitive
    hit of `needle`, with an ellipsis where the window cuts off real text.
    No needle, or needle not found -> the first `2*radius` chars, unadorned."""
    text = text or ""
    if not needle:
        return text[: 2 * radius]
    idx = text.lower().find(needle.lower())
    if idx == -1:
        return text[: 2 * radius]
    start = max(0, idx - radius)
    end = min(len(text), idx + len(needle) + radius)
    snippet = text[start:end]
    if start > 0:
        snippet = _ELLIPSIS + snippet
    if end < len(text):
        snippet = snippet + _ELLIPSIS
    return snippet


# --- vector search ------------------------------------------------------------

def cosine(a, b):
    """Cosine similarity; 0.0 if either vector is empty or zero-norm (rather
    than raising a division error — vectors are always well-formed in
    practice, but a defunct/empty embedding should just rank last, not crash)."""
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def vector_topk(qvec, vectors, limit=20):
    """Cosine similarity of `qvec` against every vector, desc, id asc tie-break."""
    scored = [{"id": v.get("id"), "score": cosine(qvec, v.get("embedding") or [])} for v in vectors]
    scored.sort(key=lambda h: (-h["score"], h["id"]))
    return scored[:limit]


# --- reconciliation (pure — the route does the actual embedding I/O) --------

def stale_ids(docs, vectors):
    """Doc ids needing a fresh embedding: non-blank text with no vector yet,
    or whose vector's `content` no longer matches the doc's current text."""
    vec_by_id = {v.get("id"): v for v in vectors}
    stale = []
    for d in docs:
        text = d.get("text") or ""
        if not text.strip():
            continue
        v = vec_by_id.get(d["id"])
        if v is None or v.get("content") != text:
            stale.append(d["id"])
    return stale


def orphan_ids(docs, vectors):
    """Vector ids to drop: no doc has that id any more, or the doc it belongs
    to has since gone blank (a blank doc is functionally deleted from search)."""
    doc_by_id = {d["id"]: d for d in docs}
    orphans = []
    for v in vectors:
        vid = v.get("id")
        doc = doc_by_id.get(vid)
        if doc is None or not (doc.get("text") or "").strip():
            orphans.append(vid)
    return orphans
