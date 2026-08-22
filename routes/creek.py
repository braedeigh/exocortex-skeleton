"""The Creek — a data-flow map of the app: which files touch which store
collections, how much traffic each one carries, and (this module's "water"
half) what the data actually IS or WAS.

GET /api/creek?days=<n, default 14> returns one JSON document with two views
of the same ground, stitched together:

  - a STATIC view: every `store.read(...)`/`store.write(...)`/`store.mutate(...)`
    call found by scanning the python sources (server.py, routes/**/*.py,
    tools/**/*.py, scripts/*.py) — which file, which line, which collection,
    verbatim source line;
  - a TELEMETRY view: store.py's own op counters (folded into the
    `feature_usage` collection roughly once a minute — see store.py's
    "Per-collection op counters" section) summed over the trailing `days`
    calendar days, per (caller, collection). Because those counters are
    bucketed by calendar day, this view can also date each collection's most
    recent write to the day (`last_write_day`) across the whole window — the
    only "when" available for anything older than the write journal.

Both views are joined into one `collections` list, but neither view is
allowed to hide the other: a collection the static scanner found but that
saw zero real traffic in the window still appears (reads/writes 0, no
callers), and a collection telemetry saw traffic for but the scanner found
no literal call for (dynamic collection name, or code outside the scanned
tree) still appears too. Same rule for `unresolved`: a first argument to
store.read/write/mutate that isn't a string literal or a resolvable same-file
UPPERCASE constant is recorded there rather than guessed at.

Four "water" endpoints answer WHAT the data is/was, not just that it flows,
for one collection id at a time (ids may contain slashes, e.g.
`bot_chats/index` — routes use `<path:cid>` and every one validates cid
through `_valid_cid` before touching a file):

  - GET /api/creek/collection/<path:cid>/now — current contents via
    `store.read`, pretty-printed and size-capped.
  - GET /api/creek/collection/<path:cid>/history?limit= — git history of the
    collection's JSON mirror `data/<cid>.json`, read from the private vault
    repo at `Path(store.DATA_DIR).parent` (the vault auto-commits hourly, so
    this is real but coarse-grained history) via read-only `git log`.
  - GET /api/creek/collection/<path:cid>/diff/<sha> — one commit's diff for
    that file, via `git show` (falling back to `git diff <sha>^ <sha>` when
    `show` comes back empty — see the note on `_diff_for_sha` about why both
    are tried).
  - GET /api/creek/collection/<path:cid>/writes?limit= — recent write events
    from `writelog.py` (a sibling module instrumenting the store seam),
    imported lazily so this route degrades honestly if that module isn't
    present yet or raises.

All four are read-only, git and writelog access included: nothing in this
module ever calls store.write/mutate, `git` is invoked with read-only
subcommands only, and any git/writelog failure degrades to an honest empty
result rather than a 500 — tests run with no git repo and no writelog module
at all, and that has to stay a 200, not a crash.

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
argument — record it in `unresolved` instead. Then add three more
"water" endpoints (now/history/diff, plus a writes endpoint reading a
parallel-built writelog.py) showing what the data is/was, not just that it
flows: cid may contain slashes (`<path:cid>`), validated against
`^[a-z0-9][a-z0-9_/.-]*$`, no `..`, and the resolved path must stay inside
its base dir; /now returns pretty-printed current contents capped at 100k
chars; /history and /diff shell out read-only to git against the vault repo
at DATA_DIR's parent, degrading to tracked=False / empty diff rather than
500ing when there's no repo; /writes reads writelog.recent()/
capturing_since(), imported lazily so an absent or raising writelog module
degrades to an honest empty result instead of breaking the route.
"""
import json
import re
import subprocess
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
    the trailing `days_n` days into {collection: {reads, writes,
    last_write_day, callers: {caller: {reads, writes}}}}, normalizing
    collection names so a caller that (mis)spells "todos.json" merges with one
    that wrote "todos".

    `last_write_day` is the newest date IN THE WINDOW on which this collection
    was written at all — the counters are bucketed by calendar day, so a day is
    the finest "when" they can honestly give. It exists because the write
    journal (writelog.py, which does carry exact timestamps) only started
    capturing recently and doesn't cover typed stores: over any window longer
    than the journal's own life, it's the only answer to "when was this last
    touched" that isn't a shrug. Stays None for a collection with no writes in
    the window — that's the difference between "quiet" and "we can't say."
    """
    days_data = feature_usage.get("days", {}) if isinstance(feature_usage, dict) else {}
    totals = {}
    # Oldest first (see _window_dates), so a later day simply overwrites the
    # last_write_day of an earlier one and the newest wins without a compare.
    for d in _window_dates(days_n, today):
        day = days_data.get(d)
        if not day:
            continue
        for caller, colls in day.get("store", {}).items():
            for raw_name, counts in colls.items():
                cid = normalize_collection(raw_name)
                bucket = totals.setdefault(
                    cid, {"reads": 0, "writes": 0, "last_write_day": None, "callers": {}}
                )
                r = counts.get("reads", 0) or 0
                w = counts.get("writes", 0) or 0
                bucket["reads"] += r
                bucket["writes"] += w
                if w > 0:
                    bucket["last_write_day"] = d
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

    # Per-collection write freshness from the journal, for Today mode's
    # recency fade. Fail-open ({} / None) when the journal is off or absent —
    # the creek still draws, it just can't fade by freshness.
    try:
        import writelog
        journal_last = writelog.last_writes()
        journal_since = writelog.capturing_since()
    except Exception:
        journal_last, journal_since = {}, None

    # Union, not intersection — a collection either side found still appears,
    # per the module docstring: neither view may hide the other.
    all_ids = sorted(static_collections | set(telemetry.keys()))
    collections_out = []
    for cid in all_ids:
        t = telemetry.get(
            cid, {"reads": 0, "writes": 0, "last_write_day": None, "callers": {}}
        )
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
            # Two different "when"s, deliberately both: `last_write` is exact
            # but only exists for what the journal has seen, `last_write_day`
            # is coarse but reaches back as far as the counters do. The client
            # prefers the exact one and falls back, rather than either being
            # made to stand in for the other.
            "last_write": journal_last.get(cid),
            "last_write_day": t.get("last_write_day"),
            "callers": callers_out,
        })

    return {
        "generated": datetime.now().isoformat(),
        "days": days_n,
        "journal_since": journal_since,
        "collections": collections_out,
        "files": files_out,
        "unresolved": unresolved_out,
    }


# --- water: what the data IS/WAS, per collection --------------------------------

# A collection id: lowercase, starts alnum, then alnum/underscore/slash/dot/
# hyphen — loose enough for ids like "bot_chats/index" but not loose enough
# to open a shell-arg or path-traversal door on its own (that's `_valid_cid`'s
# job, this regex is only the first, cheapest gate).
_CID_RE = re.compile(r"^[a-z0-9][a-z0-9_/.-]*$")
_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
_GIT_TIMEOUT = 10  # seconds; a hung git must never hang the request


def _valid_cid(cid):
    """Gate for every /collection/<cid>/... route below: charset, no literal
    '..' anywhere (belt), and the resolved on-disk JSON path must land inside
    store.DATA_DIR (suspenders — catches an escape the charset/'..' checks
    miss, e.g. a same-charset symlink planted inside DATA_DIR that points
    elsewhere). store.file_path() is the same resolver store.read/write use,
    so "safe according to this check" and "what store would actually touch"
    can't drift apart."""
    if not cid or not _CID_RE.match(cid) or ".." in cid:
        return False
    try:
        base = Path(store.DATA_DIR).resolve()
        target = store.file_path(cid).resolve()
    except (OSError, RuntimeError, ValueError):
        return False
    return target == base or base in target.parents


def _run_git(args, cwd):
    """Run a read-only git subcommand with a hard timeout; (True, stdout) on
    a clean exit, (False, "") for anything else — no git binary, cwd isn't a
    repo, a bad ref, a timeout. Callers turn that into an honest "not
    tracked" / empty response rather than a 500: the vault repo doesn't
    exist at all in the test sandbox, and that has to stay a 200."""
    try:
        result = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True,
            text=True, timeout=_GIT_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    if result.returncode != 0:
        return False, ""
    return True, result.stdout[:5_000_000]  # defensive cap before parsing


# Record/field separators for the git-log format string below: 0x1e (RS) opens
# each commit so a message body containing a stray blank line can't be mistaken
# for the boundary between commits, 0x09 (tab) splits sha/date/subject.
_LOG_FORMAT = "%x1e%H%x09%aI%x09%s"


def _parse_history_out(out):
    """Turn `git log --numstat --format=<_LOG_FORMAT>` output for ONE
    followed file into the commit list the /history contract wants. Each
    block (split on the 0x1e record separator) is a commit's header line
    (sha, ISO author date, subject) optionally followed by its numstat line
    for this file — "optionally" because a merge or an empty commit can carry
    no numstat line at all, and a binary file's numstat columns are literally
    "-" rather than a number, which is where added/removed go through as
    null instead of an int."""
    commits = []
    for block in out.split("\x1e"):
        block = block.strip("\n")
        if not block:
            continue
        lines = block.split("\n")
        header = lines[0].split("\t", 2)
        if len(header) < 3:
            continue
        sha, ts, subject = header
        added = removed = None
        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue
            cols = line.split("\t")
            if len(cols) >= 3:
                a, r, _path = cols[0], cols[1], cols[2]
                added = None if a == "-" else int(a)
                removed = None if r == "-" else int(r)
            break  # only one file is ever being followed
        commits.append({"sha": sha, "ts": ts, "subject": subject,
                         "added": added, "removed": removed})
    return commits


def _history_for_file(vault_root, file_rel, limit):
    """Commit list for `file_rel` (repo-relative), oldest info never
    guessed: None means git itself failed (no repo, no git, timeout) — the
    route turns that into tracked=False same as an empty-but-successful log,
    since either way there's nothing honest to show."""
    ok, out = _run_git(
        ["log", "--follow", "--numstat", f"--format={_LOG_FORMAT}",
         f"-n{limit}", "--", file_rel],
        vault_root,
    )
    if not ok:
        return None
    return _parse_history_out(out)


def _diff_for_sha(vault_root, file_rel, sha):
    """`git show <sha> -- file` is the natural read, but it comes back empty
    for a commit where --follow (used by /history, above) tracked this file
    under an OLDER name — `show` takes the path literally, so a commit that
    only touched the file's old name shows nothing for the new one. `git diff
    <sha>^ <sha> -- file` has the same literal-path limitation, so it doesn't
    universally fix this either; it's tried as a second honest attempt, not a
    guaranteed cure. Whichever produces real output wins; if neither does,
    the diff is legitimately empty for this sha/path pair and that's what's
    returned — not an error."""
    ok, out = _run_git(["show", sha, "--", file_rel], vault_root)
    if ok and out.strip():
        return out
    ok2, out2 = _run_git(["diff", f"{sha}^", sha, "--", file_rel], vault_root)
    if ok2 and out2.strip():
        return out2
    return out if ok else out2 if ok2 else ""


_HISTORY_NOTE = (
    "history is batched by an hourly auto-commit, so several writes can "
    "collapse into one diff and the committer is the cron, not the writer"
)
_WRITES_NOTE = (
    "captures writes through the store seam only — typed stores (cards, "
    "habits, expenses...) are not instrumented"
)

# store.read(name, None) does NOT round-trip a missing collection as None —
# store._read/sqlstore.get both special-case a None default into {} ("return
# {} if default is None else default"), so a literal `store.read(cid, None)`
# can never come back None and "exists" could never go False. A private
# sentinel default sidesteps that substitution (it's not None, so store hands
# it straight back untouched) while keeping the same read path. Flagged here
# because the brief asked for `store.read(cid, None)` specifically — this is
# a deliberate, minimal deviation from that literal call, not an oversight.
_ABSENT = object()


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

    @app.route("/api/creek/collection/<path:cid>/now")
    def creek_collection_now(cid):
        if not _valid_cid(cid):
            return jsonify({"error": "invalid collection id"}), 400
        backing = "sql" if normalize_collection(cid) in SQL_COLLECTIONS else "json"
        value = store.read(cid, _ABSENT)
        if value is _ABSENT:
            return jsonify({
                "id": cid, "backing": backing, "exists": False,
                "bytes": 0, "truncated": False, "pretty": None,
            })
        raw = json.dumps(value, indent=2, ensure_ascii=False)
        return jsonify({
            "id": cid,
            "backing": backing,
            "exists": True,
            "bytes": len(raw.encode("utf-8")),
            "truncated": len(raw) > 100_000,
            "pretty": raw[:100_000],
        })

    @app.route("/api/creek/collection/<path:cid>/history")
    def creek_collection_history(cid):
        if not _valid_cid(cid):
            return jsonify({"error": "invalid collection id"}), 400
        try:
            limit = int(request.args.get("limit", "30"))
        except (TypeError, ValueError):
            limit = 30
        limit = max(1, min(limit, 200))
        file_rel = f"data/{normalize_collection(cid)}.json"
        vault_root = Path(store.DATA_DIR).parent
        commits = _history_for_file(vault_root, file_rel, limit)
        return jsonify({
            "id": cid,
            "file": file_rel,
            "tracked": bool(commits),
            "note": _HISTORY_NOTE,
            "commits": commits or [],
        })

    @app.route("/api/creek/collection/<path:cid>/diff/<sha>")
    def creek_collection_diff(cid, sha):
        if not _valid_cid(cid):
            return jsonify({"error": "invalid collection id"}), 400
        if not _SHA_RE.match(sha):
            return jsonify({"error": "invalid sha"}), 400
        file_rel = f"data/{normalize_collection(cid)}.json"
        vault_root = Path(store.DATA_DIR).parent
        diff_text = _diff_for_sha(vault_root, file_rel, sha)
        return jsonify({
            "id": cid,
            "sha": sha,
            "diff": diff_text[:200_000],
            "truncated": len(diff_text) > 200_000,
        })

    @app.route("/api/creek/collection/<path:cid>/writes")
    def creek_collection_writes(cid):
        if not _valid_cid(cid):
            return jsonify({"error": "invalid collection id"}), 400
        try:
            limit = int(request.args.get("limit", "50"))
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(limit, 500))
        # Lazy, defensive import: writelog.py is being built in parallel with
        # this route, so "not there yet" has to behave exactly like "there,
        # but broken" — an honest empty result, never a 500 either way.
        try:
            import writelog
            events = writelog.recent(collection=normalize_collection(cid), limit=limit)
            capturing_since = writelog.capturing_since()
        except Exception:
            return jsonify({
                "id": cid, "capturing_since": None, "events": [],
                "note": "write journal not capturing",
            })
        return jsonify({
            "id": cid,
            "capturing_since": capturing_since,
            "events": events,
            "note": _WRITES_NOTE,
        })
