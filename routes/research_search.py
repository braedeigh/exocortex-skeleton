"""GET /api/research/search — search across research entries + note files.

The owner's own labrador design (FTS + vector as two independent modes, no
fusion, no thresholds), ported. `textsearch.py` is the pure ranking core;
this module is the I/O edge: it assembles the searchable corpus, persists
vectors, and calls out to `embeddings.py`.

Divergence from labrador (documented, not a bug): labrador reconciles stale/
orphan vectors hourly via an Oban cron job; there's no job queue here, so
vector mode reconciles lazily, inline, at search time — acceptable at
personal-corpus scale. The `embed_batch` network call happens OUTSIDE the
`store.mutate` lock (house rule: never hold a file lock across the network);
a doc edited mid-embed just reads as stale again on the next search, since
staleness is `vector.content != doc.text`.

Corpus = two doc families, both normalized to textsearch's Doc shape
(`{"id", "text", "title"}`):
  - entries (research.json): id `entry:<entry id>`, title "" (entries have
    no natural title), blank text skipped.
  - notes (`*.md` in EXOCORTEX_RESEARCH_DIR, non-recursive): id
    `note:<filename>`, title = first `# ` heading line, else the filename.
    An unreadable file is skipped, never a 500.

Hit shape (uniform across modes):
    {"id", "kind": "entry"|"note", "title", "snippet", "score",
     "entry_kind", "topics": [names]}   # entry_kind/topics only on entries
`title` is exactly the Doc title used for ranking (so "" for entries — they
don't have one; the snippet carries the content).
"""
import os
import re
from pathlib import Path

from flask import request, jsonify

import features
import store
import textsearch
import embeddings

DEFAULT_LIMIT = 20
MIN_LIMIT = 1
MAX_LIMIT = 100

_HEADING_RE = re.compile(r"^#\s+(.+)$")


def _clamp_limit(raw):
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(MIN_LIMIT, min(MAX_LIMIT, n))


# --- corpus assembly (module-level so tests can call these directly) --------

def _entries_docs():
    data = store.read("research.json", {"topics": [], "entries": []})
    topic_names = {t.get("id"): t.get("name") for t in data.get("topics", []) if isinstance(t, dict)}
    docs, sidecars = [], {}
    for e in data.get("entries", []):
        if not isinstance(e, dict):
            continue
        text = (e.get("text") or "").strip()
        if not text:
            continue
        doc_id = f"entry:{e.get('id')}"
        docs.append({"id": doc_id, "title": "", "text": e.get("text") or ""})
        tids = e.get("topics") or []
        sidecars[doc_id] = {
            "kind": "entry",
            "entry_kind": e.get("kind"),
            "topics": [topic_names.get(tid, tid) for tid in tids],
        }
    return docs, sidecars


def _research_dir():
    """Resolve EXOCORTEX_RESEARCH_DIR the same way store.py resolves its
    sibling-of-the-data-dir folders (TRIAGE_DIR, PERSON_SKILL_DIR): an env
    override, else a "research" dir next to wherever the data dir currently
    points — read fresh every call, so it follows store.DATA_DIR in tests."""
    override = os.environ.get("EXOCORTEX_RESEARCH_DIR", "").strip()
    if override:
        return Path(override)
    return Path(store.DATA_DIR).parent / "research"


def _note_title(text):
    for line in text.splitlines():
        m = _HEADING_RE.match(line.strip())
        if m:
            return m.group(1).strip()
    return None


def _notes_docs():
    docs, sidecars = [], {}
    directory = _research_dir()
    try:
        if not directory.is_dir():
            return docs, sidecars
        names = sorted(p.name for p in directory.iterdir())
    except OSError:
        return docs, sidecars
    for name in names:
        path = directory / name
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        doc_id = f"note:{name}"
        docs.append({"id": doc_id, "title": _note_title(text) or name, "text": text})
        sidecars[doc_id] = {"kind": "note"}
    return docs, sidecars


def _corpus():
    entry_docs, entry_side = _entries_docs()
    note_docs, note_side = _notes_docs()
    sidecars = {}
    sidecars.update(entry_side)
    sidecars.update(note_side)
    return entry_docs + note_docs, sidecars


def _hit(doc, sidecars, score, snippet):
    side = sidecars.get(doc["id"], {})
    hit = {
        "id": doc["id"],
        "kind": side.get("kind", "note"),
        "title": doc.get("title", ""),
        "snippet": snippet,
        "score": score,
    }
    if side.get("kind") == "entry":
        hit["entry_kind"] = side.get("entry_kind")
        hit["topics"] = side.get("topics", [])
    return hit


# --- reconciliation (the I/O around textsearch's pure stale/orphan calc) ---

def _reconcile_vectors(docs):
    """Drop orphans, embed everything stale in ONE embed_batch call, replace
    each id's vector exactly once. Returns an error code string on embed
    failure (in which case nothing is written). Staleness is computed from a
    plain read and the embed call runs before the lock is taken; the short
    mutate at the end just applies the results."""
    doc_by_id = {d["id"]: d for d in docs}
    vectors = store.read("research_vectors.json", {"vectors": []}).get("vectors", [])
    stale = [i for i in textsearch.stale_ids(docs, vectors) if i in doc_by_id]
    embedded = {}
    if stale:
        result = embeddings.embed_batch([doc_by_id[i]["text"] for i in stale])
        if not result.get("ok"):
            return result.get("error")
        embedded = dict(zip(stale, result.get("vectors") or []))
    with store.mutate("research_vectors.json", {"vectors": []}) as data:
        vectors = data.setdefault("vectors", [])
        drop = set(textsearch.orphan_ids(docs, vectors)) | set(embedded)
        if drop:
            vectors[:] = [v for v in vectors if v.get("id") not in drop]
        for doc_id, vec in embedded.items():
            vectors.append({"id": doc_id, "content": doc_by_id[doc_id]["text"], "embedding": vec})
    return None


def _vector_hits(q, docs, sidecars, limit):
    """Returns (hits, error). error is a truthy code string on failure."""
    err = _reconcile_vectors(docs)
    if err:
        return None, err
    qres = embeddings.embed(q)
    if not qres.get("ok"):
        return None, qres.get("error")
    vectors = store.read("research_vectors.json", {"vectors": []}).get("vectors", [])
    ranked = textsearch.vector_topk(qres["vector"], vectors, limit=limit)
    doc_by_id = {d["id"]: d for d in docs}
    hits = []
    for r in ranked:
        doc = doc_by_id.get(r["id"])
        if not doc:
            continue
        hits.append(_hit(doc, sidecars, r["score"], textsearch.make_snippet(doc.get("text", ""), "")))
    return hits, None


def register(app):

    @app.route("/api/research/search", methods=["GET"])
    def research_search():
        q = request.args.get("q", "")
        mode = (request.args.get("mode") or "keyword").strip().lower()
        limit = _clamp_limit(request.args.get("limit"))
        docs, sidecars = _corpus()

        if mode == "vector":
            # research_vector_search feature flag (features.py): a gated
            # install answers exactly like an unconfigured one — the frontend
            # already handles this 503 — while keyword mode stays untouched.
            if not features.enabled("research_vector_search"):
                return jsonify({"error": "Vector search unavailable"}), 503
            if not embeddings.configured():
                return jsonify({"error": "Vector search unavailable"}), 503
            hits, err = _vector_hits(q, docs, sidecars, limit)
            if err:
                return jsonify({"error": "Vector search unavailable"}), 503
            return jsonify({"ok": True, "mode": "vector", "hits": hits})

        doc_by_id = {d["id"]: d for d in docs}
        raw = textsearch.keyword_search(q, docs, limit=limit)
        hits = [_hit(doc_by_id[r["id"]], sidecars, r["score"], r["snippet"])
                for r in raw if r["id"] in doc_by_id]
        return jsonify({"ok": True, "mode": "keyword", "hits": hits})
