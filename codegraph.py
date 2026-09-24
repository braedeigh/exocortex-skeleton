"""codegraph.py — the shape of the codebase: every code file, and every
dependency between them.

Plain English: `codestore.py` knows the codebase's HISTORY (who changed what,
when). `runtime_sensor.py` knows what RAN. Neither one knows how the pieces are
wired to each other — that a click in `ObservatoryPage.tsx` reaches `api.ts`,
that `routes/observatory.py` leans on `store.py`, that `scripts/turn_host.py`
imports the turn loop rather than owning a second copy of it. This module reads
the source itself and writes that wiring down as rows, so the question "what
touches what" can be asked of the database instead of by grepping.

TWO LANGUAGES, TWO RESOLVERS, ONE TABLE. Python goes through `ast` — a real
parse, so an import is found or it isn't, and there is no guessing. TypeScript
and JavaScript go through a scanner over the import/export syntax, because
there is no TS parser here; that half is honest about being a scanner and its
limits are listed at `_ts_imports`. Both resolve a module specifier to a REAL
FILE ON DISK, and an edge is only drawn when the destination exists — an
unresolvable relative import is a parse error worth seeing, not a silent gap.

WHAT AN EDGE MEANS, exactly, because this is the part that is easy to
overclaim: an edge of kind `import` says **A imports from B**, plus which names it
pulled across; an edge of kind `http` says a frontend file names an `/api`
path that a route module registers (apiseam.py). It does NOT say A called B at runtime, and it cannot — a file that
imports a helper it never invokes gets an edge here just the same. The
observed, actually-executed half of the picture is `runtime_sensor.py`'s job;
this is the map of what CAN flow, which is what makes it complete. The two are
meant to be read together, and they are deliberately kept in different stores
so neither can be mistaken for the other.

EVERY FILE GETS A ROW, including one that fails to parse (with the reason in
`parse_error`) and one that nothing imports and that imports nothing. That is
the whole point of the `code_files` table existing beside `code_edges`: "every
piece of code in the app" has to mean every piece, or the answer to "what is
unreachable" is a lie by omission.

EXTERNAL EDGES ARE KEPT. `import flask`, `import { useState } from 'react'` —
these land with `dst_repo = ''`. A file's dependence on the outside world is
the same kind of fact as its dependence on a sibling, and a caller that wants
only internal flow filters one column.

Touches: `sqlstore.py` (owns the v16 schema rung and the connection factory),
`codestore.py` (the sibling history tables — `default_repos()` is shared, so
both stores agree on which repos exist and where), `routes/terrain.py` (serves
the graph), `runtime_sensor.py` (the observed overlay).

Prompt that produced this file: "I want this structure for EVERY piece of code
in the app. I want to be able to see every single flow that touches one
another."
"""
import ast
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import apiseam
import codestore
import sqlstore

# What counts as code. The value is the `lang` column, which also picks the
# resolver. CSS is in here because a `.module.css` is imported BY name from a
# component and is a real edge in the dependency graph — it draws no edges of
# its own, but it is a destination, and leaving it out would put a hole in
# every component's outgoing set.
LANGS = {
    ".py": "python",
    ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js",
    ".css": "css",
}

# Directories never walked. Same spirit as terrain's denylist, but this one is
# about what IS the codebase rather than what is worth drawing: build output
# and vendored dependencies are not this app's code, and `frontend/dist`
# specifically would otherwise double every module as a bundled copy.
SKIP_DIRS = {
    ".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build",
    ".pytest_cache", ".mypy_cache", "coverage", ".ruff_cache",
}

# Order matters: a bare './x' is tried as each of these in turn, which is
# module resolution's usual "file first, then the directory's index".
_TS_SUFFIXES = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css",
                "/index.ts", "/index.tsx", "/index.js")


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- walking -----------------------------------------------------------------

def walk_repo(root):
    """Every code file under `root`, as repo-relative posix paths.

    Symlinks are NOT followed. This install symlinks docs in from the vault
    (CLAUDE.local.md and friends), and following them would file the vault's
    content under the skeleton's repo id and double-count anything reachable
    both ways."""
    root = Path(root)
    out = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            ext = os.path.splitext(name)[1]
            if ext not in LANGS:
                continue
            full = Path(dirpath) / name
            if full.is_symlink():
                continue
            out.append((str(full.relative_to(root)).replace(os.sep, "/"), LANGS[ext]))
    return out


# --- python ------------------------------------------------------------------

def _py_module_candidates(module, level, src_path):
    """Every repo-relative path a Python import could be naming.

    `level` is the dots on a relative import (`from . import x` is level 1).
    Returns paths in preference order; the caller keeps the first that exists.
    Both `a/b.py` and `a/b/__init__.py` are offered for the same dotted name
    because either can be what `a.b` means."""
    if level:
        base = Path(src_path).parent
        for _ in range(level - 1):
            base = base.parent
        prefix = [p for p in str(base).split("/") if p and p != "."]
    else:
        prefix = []
    parts = prefix + (module.split(".") if module else [])
    if not parts:
        return []
    stem = "/".join(parts)
    return [f"{stem}.py", f"{stem}/__init__.py"]


def _py_symbol_uses(tree, bindings):
    """Which attributes of each imported MODULE the file actually reaches for.

    `import store` gives an edge, but on its own it says only "this file knows
    store exists". Collecting every `store.<attr>` in the tree turns that into
    "it uses read, mutate and DATA_DIR", which is the difference between an
    edge you can see and an edge you can read. Only plain `name.attr` is
    counted — chained or computed access is left alone rather than guessed
    at."""
    uses = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            target = bindings.get(node.value.id)
            if target:
                uses.setdefault(target, set()).add(node.attr)
    return uses


def python_edges(source, src_path):
    """(edges, error). Each edge is (module_or_None, dotted_name, level, symbols).

    Resolution to a file happens in the caller, which is the only thing that
    knows what else exists in the repo."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as e:
        return [], f"{type(e).__name__}: {e}"

    raw = []          # (module, level, symbols, binding_name, speculative)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                # `import a.b.c` binds `a`; `import a.b as x` binds `x`. The
                # binding is what _py_symbol_uses looks for in the tree.
                bind = alias.asname or alias.name.split(".")[0]
                raw.append((alias.name, 0, set(), bind, False))
        elif isinstance(node, ast.ImportFrom):
            names = {a.name for a in node.names if a.name != "*"}
            raw.append((node.module or "", node.level, names, None, False))
            # `from routes import todos` is BOTH: a name pulled out of the
            # package, and — far more often in this codebase — the module
            # `routes/todos.py` itself. Each name is tried as a submodule and
            # kept when it resolves to a real file, which is what makes
            # `from routes import kitchen, habits, todos` draw one edge per
            # route module instead of one edge to the package.
            #
            # SPECULATIVE, and the flag is load-bearing: `from routes.tags
            # import _SLUG_RE` also comes through here as `routes.tags._SLUG_RE`,
            # which is a CLASS, not a module, and resolves to no file. Left
            # unflagged it fell through to the external-package fallback and
            # invented an edge to a package called `routes` — a wrong row, not
            # a missing one. A guess that doesn't land is dropped silently;
            # only a real `import x` may name a package.
            for alias in node.names:
                if alias.name == "*":
                    continue
                sub = f"{node.module}.{alias.name}" if node.module else alias.name
                raw.append((sub, node.level, set(), alias.asname or alias.name, True))

    bindings = {b: (m, lvl) for m, lvl, _, b, _ in raw if b}
    uses = _py_symbol_uses(tree, bindings)
    out = []
    for module, level, symbols, bind, speculative in raw:
        extra = uses.get((module, level), set()) if bind else set()
        out.append((module, level, symbols | extra, speculative))
    return out, None


# --- typescript / javascript --------------------------------------------------
# One scanner, four syntaxes. Comments are stripped first — a block comment
# showing an example import is the common false positive, and a line comment is
# stripped only when `//` STARTS the line, because stripping it anywhere would
# eat the `//` in every URL in the file.

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT = re.compile(r"^[ \t]*//.*$", re.M)
# `import ... from 'x'` and `export ... from 'x'`. The clause is [^'"]*? so it
# spans the newlines of a multi-line `{ a,\n b }` without ever crossing into
# the quotes that end it.
_FROM = re.compile(
    r"""(?:^|[\n;])[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?([^'"]*?)[ \t\n]*from[ \t\n]*['"]([^'"]+)['"]""",
    re.S)
# `import 'x'` — side-effect only, which is how a component pulls in its CSS.
_BARE = re.compile(r"""(?:^|[\n;])[ \t]*import[ \t]+['"]([^'"]+)['"]""")
# `await import('x')` — the lazy-route split points.
_DYNAMIC = re.compile(r"""\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)""")

_NAMED = re.compile(r"\{([^}]*)\}", re.S)


def _clause_symbols(clause):
    """The names an import clause pulls across. `{ a, b as c }` gives a and b —
    the LOCAL alias is dropped on purpose: an edge should be labelled with what
    the destination calls the thing, not with what this file renamed it to."""
    names = set()
    for group in _NAMED.findall(clause):
        for piece in group.split(","):
            piece = piece.strip()
            if not piece:
                continue
            names.add(piece.split(" as ")[0].strip().removeprefix("type ").strip())
    # `import X from 'p'` / `import * as X from 'p'` — the default or namespace
    # binding, which names no symbol of the destination's surface.
    outside = _NAMED.sub("", clause)
    if outside.strip().rstrip(","):
        names.add("default")
    return {n for n in names if n}


def _ts_imports(source):
    """(specifier, symbols) for every import in a TS/JS file.

    Known limits, since this is a scanner and not a parser: an import written
    inside a template literal or a string would be picked up, and an import
    spliced across a comment boundary would not. Both are theoretical in this
    codebase and neither can produce a WRONG edge to a real file — the worst
    case is an edge to a path that doesn't resolve, which is dropped."""
    src = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", source))
    found = []
    for clause, spec in _FROM.findall(src):
        found.append((spec, _clause_symbols(clause)))
    for spec in _BARE.findall(src):
        found.append((spec, set()))
    for spec in _DYNAMIC.findall(src):
        found.append((spec, {"default"}))
    return found


def _ts_resolve(spec, src_path, exists):
    """A specifier to a repo-relative path, or None if it isn't ours.

    Only relative specifiers can be internal — this frontend uses no path
    aliases (checked in tsconfig.json), so anything bare is a package."""
    if not spec.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(src_path), spec))
    if base.startswith(".."):
        return None            # climbed out of the repo
    for suffix in _TS_SUFFIXES:
        cand = f"{base}{suffix}"
        if cand in exists:
            return cand
    return None


# --- building ----------------------------------------------------------------

def build(repos=None):
    """Parse every repo and return (files, edges) without touching the database.

    Separated from the write so it can be tested — and read — on its own."""
    repos = [(r["id"], r["root"]) for r in (repos or codestore.default_repos())]
    files, edges = [], []
    # Every code file in every repo, up front: resolution is a membership test
    # against this, and a Python import can legitimately land in the sibling
    # repo (the vault's scripts import the skeleton's store).
    index = {}
    for repo_id, root in repos:
        index[repo_id] = {path: lang for path, lang in walk_repo(root)}

    for repo_id, root in repos:
        here = index[repo_id]
        for path, lang in here.items():
            full = Path(root) / path
            try:
                source = full.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                files.append((repo_id, path, lang, 0, f"unreadable: {e}"))
                continue
            lines = source.count("\n") + 1
            seen = {}          # (dst_repo, dst) -> symbols, so one edge per pair

            if lang == "python":
                found, error = python_edges(source, path)
                if error:
                    files.append((repo_id, path, lang, lines, error))
                    continue
                for module, level, symbols, speculative in found:
                    hit = None
                    for cand in _py_module_candidates(module, level, path):
                        # Own repo first, then the sibling — a relative import
                        # can only mean the former, and an absolute one almost
                        # always does.
                        for other in (repo_id, *(r for r, _ in repos if r != repo_id)):
                            if cand in index[other]:
                                hit = (other, cand)
                                break
                        if hit:
                            break
                    if hit is None:
                        if speculative or level or not module:
                            continue    # a guess that didn't land, or a dead relative import
                        hit = ("", module.split(".")[0])   # a package
                    seen.setdefault(hit, set()).update(symbols)

            elif lang in ("ts", "tsx", "js", "jsx"):
                for spec, symbols in _ts_imports(source):
                    target = _ts_resolve(spec, path, here)
                    hit = (repo_id, target) if target else \
                        ("", spec if not spec.startswith(".") else None)
                    if hit[1] is None:
                        continue        # a relative import that resolves to nothing
                    seen.setdefault(hit, set()).update(symbols)
            # css draws no edges of its own — it is only ever a destination.

            files.append((repo_id, path, lang, lines, None))
            for (dst_repo, dst), symbols in seen.items():
                if dst_repo == repo_id and dst == path:
                    continue            # a file importing itself is not a flow
                edges.append((repo_id, path, dst_repo, dst, "import",
                              json.dumps(sorted(symbols))))

    # Cross the one gap the import graph cannot: a React file doesn't import
    # `routes/todos.py`, it names the string `/api/todos` and a request
    # carries it over. apiseam.py reads those calls and matches each to the
    # module whose decorator registers it, so a walk can start at a .tsx and
    # come out at a table. Same claim as an import edge — a thing that CAN
    # flow, read out of the source — which is why it lives in the same table
    # under its own `kind`.
    for repo_id, root in repos:
        edges.extend(apiseam.seam_edges(repo_id, root, index[repo_id]))
    return files, edges


def rebuild(repos=None):
    """Wipe and re-derive both tables. There is no incremental variant on
    purpose: the whole parse is ~1000 files and runs in about a second, and an
    incremental edge index would have to invalidate every file that imports a
    changed one, which is the same walk with a bug in it."""
    files, edges = build(repos)
    stamp = _now_iso()
    out_degree, in_degree = {}, {}
    for repo, src, dst_repo, dst, _kind, _symbols in edges:
        out_degree[(repo, src)] = out_degree.get((repo, src), 0) + 1
        if dst_repo:
            in_degree[(dst_repo, dst)] = in_degree.get((dst_repo, dst), 0) + 1

    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("DELETE FROM code_edges")
        conn.execute("DELETE FROM code_files")
        conn.executemany(
            "INSERT INTO code_files (repo, path, lang, lines, out_degree,"
            " in_degree, parsed_at, parse_error) VALUES (?,?,?,?,?,?,?,?)",
            [(repo, path, lang, lines,
              out_degree.get((repo, path), 0), in_degree.get((repo, path), 0),
              stamp, error)
             for repo, path, lang, lines, error in files])
        conn.executemany(
            "INSERT OR REPLACE INTO code_edges (repo, src, dst_repo, dst, kind,"
            " symbols) VALUES (?,?,?,?,?,?)", edges)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {"files": len(files), "edges": len(edges),
            "errors": sum(1 for f in files if f[4]), "parsed_at": stamp}


# --- reading -----------------------------------------------------------------

def graph(internal_only=True):
    """The whole graph, as it stands. `internal_only` drops the external
    package edges, which are most of the edge count and none of the app's own
    flow."""
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    try:
        files = [dict(r) for r in conn.execute(
            "SELECT repo, path, lang, lines, out_degree, in_degree, parse_error"
            " FROM code_files ORDER BY repo, path")]
        sql = ("SELECT repo, src, dst_repo, dst, kind, symbols FROM code_edges"
               "%s ORDER BY repo, src, dst")
        rows = conn.execute(sql % (" WHERE dst_repo != ''" if internal_only else ""))
        edges = [{"repo": r["repo"], "src": r["src"], "dst_repo": r["dst_repo"],
                  "dst": r["dst"], "kind": r["kind"],
                  "symbols": json.loads(r["symbols"] or "[]")} for r in rows]
    finally:
        conn.close()
    return {"files": files, "edges": edges}


def neighbors(repo, path):
    """One file's immediate flow, both directions — what it reaches for, and
    what reaches for it. The query behind "show me everything that touches
    this file"."""
    conn = sqlstore.open_db()
    conn.row_factory = sqlite3.Row
    try:
        out = [dict(r) for r in conn.execute(
            "SELECT dst_repo, dst, kind, symbols FROM code_edges"
            " WHERE repo = ? AND src = ? ORDER BY dst_repo, dst", (repo, path))]
        inc = [dict(r) for r in conn.execute(
            "SELECT repo, src, kind, symbols FROM code_edges"
            " WHERE dst_repo = ? AND dst = ? ORDER BY repo, src", (repo, path))]
    finally:
        conn.close()
    for row in (*out, *inc):
        row["symbols"] = json.loads(row.get("symbols") or "[]")
    return {"imports": out, "imported_by": inc}
