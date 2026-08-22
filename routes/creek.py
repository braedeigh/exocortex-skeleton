"""The Creek — a data-flow map of the app: which files touch which store
collections, and how much traffic each collection actually carries.

GET /api/creek?days=<n, default 14> returns one JSON document with two views
of the same ground, stitched together:

  - a STATIC view: every `store.read(...)`/`store.write(...)`/`store.mutate(...)`
    call found by scanning the python sources (server.py, routes/**/*.py,
    tools/**/*.py, scripts/*.py) — which file, which line, which collection,
    verbatim source line;
  - a TELEMETRY view: store.py's own op counters (folded into the
    `feature_usage` collection roughly once a minute — see store.py's
    "Per-collection op counters" section) summed over the trailing `days`
    calendar days, per (caller, collection).

Both views are joined into one `collections` list, but neither view is
allowed to hide the other: a collection the static scanner found but that
saw zero real traffic in the window still appears (reads/writes 0, no
callers), and a collection telemetry saw traffic for but the scanner found
no literal call for (dynamic collection name, or code outside the scanned
tree) still appears too. Same rule for `unresolved`: a first argument to
store.read/write/mutate that isn't a string literal or a resolvable same-file
UPPERCASE constant is recorded there rather than guessed at.

Everything here is read-only — this module never calls store.write/mutate.

The analyzer half (scan_source, _discover_source_files, analyze_repo, ...)
is plain functions with no Flask dependency, so it's unit-testable directly
against inline source strings.

Built from this technical brief: expose GET /api/creek?days=<n> serving
{generated, days, collections, files, unresolved}; statically scan the repo
for store.read/write/mutate(<literal-or-resolvable-constant>) call sites,
normalizing collection names the way store.py's _key() does (strip a
trailing .json so "todos" and "todos.json" merge); mark each collection's
backing sql/json via store.SQL_COLLECTIONS; join in feature_usage's
per-caller/per-collection read/write telemetry for the trailing N days;
union both sides rather than hiding either; never guess at a dynamic first
argument — record it in `unresolved` instead.
"""
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import jsonify, request

import store
from store import SQL_COLLECTIONS

# --- where the analyzer looks -------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
_EXCLUDED_DIR_PARTS = {"tests", "venv", "__pycache__"}

# Matches the opening of a store data-access call; the first argument itself
# is walked out char-by-char below (see _extract_first_arg) rather than
# regexed, because it needs to survive nested parens/commas inside a literal
# string and still find the true end of the arg.
_CALL_OPEN_RE = re.compile(r"\bstore\.(read|write|mutate)\(")

# Module-level (unindented) UPPERCASE = "literal" assignments, e.g.
# `PENDING_FILE = "pending_changes"`. Used to resolve a bare constant name
# passed as the first arg of a store call, same-file only — cross-module
# constants are deliberately left unresolved rather than guessed at.
_CONST_DEF_RE = re.compile(
    r"(?m)^([A-Z_][A-Z0-9_]*)\s*=\s*([\"'])((?:\\.|(?!\2).)*)\2"
)

_BARE_CONST_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

# This codebase's own bilingual convention (see CLAUDE.md's "Plain-language
# layer") means comments and docstrings routinely TALK ABOUT store calls in
# plain English — this very file's first draft had a comment mentioning
# "store.read(" that the call regex below promptly mistook for a real call
# site, then ran off to the end of the file hunting for a closing paren that
# was never coming (comment prose has no reason to balance quotes/parens the
# way real code does). _mask_noncode blanks out '#' comments and triple-
# quoted strings (same shape, spaces for non-newline chars) before hunting
# for calls, while leaving ordinary single/double-quoted string literals —
# where a real call's collection-name argument actually lives — untouched.
def _mask_noncode(text):
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith('"""', i) or text.startswith("'''", i):
            quote = text[i:i + 3]
            out.append("   ")
            i += 3
            while i < n and not text.startswith(quote, i):
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            if i < n:
                out.append("   ")
                i += 3
            continue
        if c in "\"'":
            quote = c
            out.append(c)
            i += 1
            while i < n and text[i] != quote:
                if text[i] == "\\" and i + 1 < n:
                    out.append(text[i]); out.append(text[i + 1])
                    i += 2
                    continue
                out.append("\n" if text[i] == "\n" else text[i])
                i += 1
            if i < n:
                out.append(text[i])
                i += 1
            continue
        if c == "#":
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def normalize_collection(name):
    """Mirror store.py's _key(): the collection name minus a trailing
    ".json" — this is what makes "todos" and "todos.json" the same node."""
    return name[:-5] if name.endswith(".json") else name


def _read_module_constants(text):
    """name -> string value, for every unindented `NAME = "..."` assignment
    in this one file. First assignment wins if a name is set more than once
    (matches how a module-level constant is normally read at import time)."""
    consts = {}
    for m in _CONST_DEF_RE.finditer(text):
        name = m.group(1)
        if name not in consts:
            consts[name] = m.group(3)
    return consts


def _extract_first_arg(text, start):
    """Walk the characters right after `store.verb(` and return the source
    text of the first argument (up to the first top-level comma or the call's
    closing paren), tracking quotes and nested brackets so a comma or paren
    *inside* a string or a nested call doesn't end the argument early."""
    i, n = start, len(text)
    depth = 0
    quote = None
    buf = []
    while i < n:
        c = text[i]
        if quote:
            buf.append(c)
            if c == "\\" and i + 1 < n:
                buf.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            buf.append(c)
            i += 1
            continue
        if c in "([{":
            depth += 1
            buf.append(c)
            i += 1
            continue
        if c in ")]}":
            if c == ")" and depth == 0:
                break
            depth -= 1
            buf.append(c)
            i += 1
            continue
        if c == "," and depth == 0:
            break
        buf.append(c)
        i += 1
    return "".join(buf).strip()


def _classify_arg(arg_text, constants):
    """Sort a call's first-argument text into one of:
      ("literal", <collection name>)   — a plain string literal
      ("const", <collection name>)     — an UPPERCASE name resolved same-file
      ("unresolved", <expr text>)      — anything else (dynamic, cross-module)
    """
    s = arg_text.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return "literal", s[1:-1]
    if _BARE_CONST_RE.match(s):
        if s in constants:
            return "const", constants[s]
        return "unresolved", s
    return "unresolved", s or "<empty>"


def scan_source(text, relpath):
    """Pure analyzer: given one file's source text and its repo-relative
    path, return (calls, unresolved) — calls is the list of resolved
    store.read/write/mutate(<collection>) sites in this file; unresolved is
    the list of sites whose first argument couldn't be pinned to a name.

    Call/constant detection runs against a comment/docstring-masked copy
    (see _mask_noncode) so prose mentions of store.mutate(...) don't get
    mistaken for real call sites; line numbers and the reported snippet
    still come from the real, unmasked text."""
    masked = _mask_noncode(text)
    constants = _read_module_constants(masked)
    lines = text.splitlines()
    calls, unresolved = [], []
    for m in _CALL_OPEN_RE.finditer(masked):
        verb = m.group(1)
        arg_text = _extract_first_arg(masked, m.end())
        line = masked.count("\n", 0, m.start()) + 1
        snippet = lines[line - 1].strip() if 0 <= line - 1 < len(lines) else ""
        kind, value = _classify_arg(arg_text, constants)
        if kind == "unresolved":
            unresolved.append({"path": relpath, "line": line, "expr": value})
        else:
            calls.append({
                "line": line,
                "verb": verb,
                "collection": normalize_collection(value),
                "snippet": snippet,
            })
    return calls, unresolved


def _area_for(relpath):
    if relpath == "server.py":
        return "server"
    top = relpath.split("/", 1)[0]
    return top if top in ("routes", "scripts", "tools") else "other"


def _discover_source_files(repo_root):
    """server.py, routes/**/*.py, tools/**/*.py, scripts/*.py — skipping
    tests/, venv/, __pycache__, and anything hidden."""
    repo_root = Path(repo_root)
    found = []
    server_py = repo_root / "server.py"
    if server_py.is_file():
        found.append(server_py)
    for sub, pattern in (("routes", "**/*.py"), ("tools", "**/*.py"), ("scripts", "*.py")):
        base = repo_root / sub
        if base.is_dir():
            found.extend(base.glob(pattern))
    out = []
    for p in found:
        parts = p.relative_to(repo_root).parts
        if any(part.startswith(".") for part in parts):
            continue
        if any(part in _EXCLUDED_DIR_PARTS for part in parts):
            continue
        out.append(p)
    return out


def _analyze_files(repo_root, file_paths):
    """Scan every given file and fold the results into the (files, unresolved,
    static_collections) shape the route needs — files sorted by path, each
    entry holding only files that actually had a call in them (a file with
    no store traffic isn't part of the map)."""
    repo_root = Path(repo_root)
    files_out = []
    unresolved_out = []
    static_collections = set()
    for p in file_paths:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        relpath = p.relative_to(repo_root).as_posix()
        calls, unresolved = scan_source(text, relpath)
        if calls:
            files_out.append({"path": relpath, "area": _area_for(relpath), "calls": calls})
            static_collections.update(c["collection"] for c in calls)
        unresolved_out.extend(unresolved)
    files_out.sort(key=lambda f: f["path"])
    unresolved_out.sort(key=lambda u: (u["path"], u["line"]))
    return files_out, unresolved_out, static_collections


def analyze_repo(repo_root):
    """Discover + scan in one call — the un-cached entry point (also what
    tests reach for against a scratch tree)."""
    repo_root = Path(repo_root)
    return _analyze_files(repo_root, _discover_source_files(repo_root))


# Module-level cache: a fresh scan is cheap (~50 files) but there's no reason
# to redo it on every poll of a page that's likely refreshing every few
# seconds, so the last result is kept keyed on a signature of (path, mtime)
# for every discovered file — touch any scanned file and the next request
# rescans; otherwise it's a dict lookup. Correctness over cleverness: no
# background thread, no TTL, just "does the file list still look the same".
_scan_cache = {"key": None, "result": None}


def _cached_analyze(repo_root):
    repo_root = Path(repo_root)
    file_paths = _discover_source_files(repo_root)
    try:
        key = tuple(sorted((str(p), p.stat().st_mtime_ns) for p in file_paths))
    except OSError:
        key = None  # a file vanished mid-stat (rare) — skip the cache this once
    if key is not None and key == _scan_cache["key"]:
        return _scan_cache["result"]
    result = _analyze_files(repo_root, file_paths)
    if key is not None:
        _scan_cache["key"] = key
        _scan_cache["result"] = result
    return result


# --- telemetry join ------------------------------------------------------------

def _window_dates(days_n, today=None):
    """The `days_n` calendar dates ending today (inclusive), oldest first —
    same window shape as routes/usage.py's usage_export."""
    today = today or date.today()
    start = today - timedelta(days=days_n - 1)
    return [(start + timedelta(days=i)).isoformat() for i in range(days_n)]


def aggregate_telemetry(feature_usage, days_n, today=None):
    """Sum feature_usage's days[<date>]["store"][<caller>][<collection>] over
    the trailing `days_n` days into {collection: {reads, writes, callers:
    {caller: {reads, writes}}}}, normalizing collection names so a caller
    that (mis)spells "todos.json" merges with one that wrote "todos"."""
    days_data = feature_usage.get("days", {}) if isinstance(feature_usage, dict) else {}
    totals = {}
    for d in _window_dates(days_n, today):
        day = days_data.get(d)
        if not day:
            continue
        for caller, colls in day.get("store", {}).items():
            for raw_name, counts in colls.items():
                cid = normalize_collection(raw_name)
                bucket = totals.setdefault(cid, {"reads": 0, "writes": 0, "callers": {}})
                r = counts.get("reads", 0) or 0
                w = counts.get("writes", 0) or 0
                bucket["reads"] += r
                bucket["writes"] += w
                cb = bucket["callers"].setdefault(caller, {"reads": 0, "writes": 0})
                cb["reads"] += r
                cb["writes"] += w
    return totals


def _caller_file(repo_root, caller):
    """A caller's source file if it's one of our own scripts/<name>.py (e.g.
    `usage_rollup` -> scripts/usage_rollup.py); None for anything else
    (gunicorn, adhoc, a Rust binary's EXOCORTEX_PROC name, ...) — never
    guessed, only reported when the file is actually there."""
    candidate = Path(repo_root) / "scripts" / f"{caller}.py"
    return f"scripts/{caller}.py" if candidate.is_file() else None


def build_creek(repo_root, days_n):
    """Assemble the whole /api/creek response body. Pulled out of the route
    handler so tests (and any future caller) can build the document without
    going through Flask."""
    repo_root = Path(repo_root)
    files_out, unresolved_out, static_collections = _cached_analyze(repo_root)
    feature_usage = store.read("feature_usage", {"days": {}})
    telemetry = aggregate_telemetry(feature_usage, days_n)

    # Union, not intersection — a collection either side found still appears,
    # per the module docstring: neither view may hide the other.
    all_ids = sorted(static_collections | set(telemetry.keys()))
    collections_out = []
    for cid in all_ids:
        t = telemetry.get(cid, {"reads": 0, "writes": 0, "callers": {}})
        callers_out = [
            {"name": caller, "reads": c["reads"], "writes": c["writes"],
             "file": _caller_file(repo_root, caller)}
            for caller, c in sorted(t["callers"].items())
        ]
        collections_out.append({
            "id": cid,
            "backing": "sql" if cid in SQL_COLLECTIONS else "json",
            "reads": t["reads"],
            "writes": t["writes"],
            "callers": callers_out,
        })

    return {
        "generated": datetime.now().isoformat(),
        "days": days_n,
        "collections": collections_out,
        "files": files_out,
        "unresolved": unresolved_out,
    }


def register(app):

    @app.route("/api/creek")
    def creek_map():
        raw_days = request.args.get("days", "14")
        try:
            days_n = int(raw_days)
        except (TypeError, ValueError):
            return jsonify({"error": '"days" must be a positive integer'}), 400
        if days_n < 1:
            return jsonify({"error": '"days" must be a positive integer'}), 400
        return jsonify(build_creek(REPO_ROOT, days_n))
