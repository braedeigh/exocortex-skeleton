"""codemap.py — the box-and-arrow maps of a codebase, read from markdown.

Plain English: a MAP is a codebase drawn as boxes with named arrows between
them — the whole project at the top, each box opening into its parts. Every box
is ONE small markdown file a person (or a session) wrote by hand: what the box
is, which box it sits inside, which source files it stands for, and its links
to other boxes, each with a kind ("calls", "writes"…) and a one-line reason.
The Map room on Terrain (routes/terrain_map.py, frontend
features/terrain/TerrainMapView.tsx) draws them; this module only reads,
checks and stamps them. The file format and how to write one: docs/codemap.md.

WHERE MAPS LIVE. Inside the repo they describe, at `docs/map/<name>/*.md` — so a
map is committed beside its code and travels with it. Any repo this system
knows can carry maps: the two the main Terrain map covers (codestore's
default repos) and every build on the Builds list (buildlist.py). A map is
known as `<repo id>/<name>`, e.g. `skeleton/observatory`.

KEEPING IT TRUE. Each box records a FINGERPRINT of its source files, taken
when its words were last written (`stamp`). A box whose files have changed
since — the fingerprint no longer matches — is STALE: its description may no
longer be right. A box naming a source that no longer exists is BROKEN. The
code never rewrites the words itself; a session reads the stale box's files,
rewrites it, and stamps it again (scripts/codemap.py).

The import scan (`import_links`) is a helper for whoever writes the boxes: it
reads the real imports (codegraph.py's resolvers, plus a pnpm workspace's own
package names) and says which box's files import which other box's files, so
a "depends-on" link is found rather than remembered.

Touches: `codegraph.py` (walks a repo, resolves Python and TS imports),
`codestore.py` + `buildlist.py` (which repos exist and where).

Prompt that produced this file: "What would it take to make something like
this?" — a zoomable architecture map where each box is a small markdown file,
with named links (depends on, calls, reads, writes, hosts, implements,
generates, composes).
"""
from datetime import date
from pathlib import Path
import hashlib
import json
import os
import re

import buildlist
import codegraph
import codestore

# The kinds of link a box may draw, in the order the legend shows them.
LINK_KINDS = ("depends-on", "calls", "reads", "writes", "hosts", "implements",
              "generates", "composes")

# What a box may call itself. `project` is the top box, the codebase itself.
BOX_KINDS = ("project", "module", "feature", "data", "script")

# Where a repo keeps its maps, one folder per map.
MAP_DIR = Path("docs") / "map"

# What a box id or map name may look like: words, dots and dashes. Used in URLs
# and as file names, so kept to what is safe in both.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,80}$")

# One link line: `<kind> <box id>: <reason>`.
_LINK_RE = re.compile(r"^([a-z-]+)\s+([a-z0-9][a-z0-9.-]*)\s*:\s*(.+)$")


# --- which maps exist ---------------------------------------------------------

def repos():
    """Every repo that may carry maps, as {id, name, root}: the main map's own
    folders first, then the builds. A repo listed twice keeps its first entry."""
    out, seen = [], set()
    for repo in codestore.default_repos():
        out.append({"id": repo["id"], "name": buildlist.display_name(repo["id"]),
                    "root": Path(repo["root"])})
    for build in buildlist.builds():
        out.append({"id": build["id"], "name": build["name"], "root": Path(build["root"])})
    unique = []
    for repo in out:
        if repo["id"] not in seen:
            seen.add(repo["id"])
            unique.append(repo)
    return unique


def find_maps():
    """Every map on this machine: [{key, repo, slug, dir, root}], in repo order
    then by name. A repo with no `docs/map/` folder simply has none."""
    found = []
    for repo in repos():
        base = repo["root"] / MAP_DIR
        if not base.is_dir():
            continue
        for folder in sorted(base.iterdir()):
            if folder.is_dir() and _ID_RE.match(folder.name) and any(folder.glob("*.md")):
                found.append({"key": f"{repo['id']}/{folder.name}", "repo": repo["id"],
                              "repo_name": repo["name"], "slug": folder.name,
                              "dir": folder, "root": repo["root"]})
    return found


def find_map(key):
    """One map by its `<repo>/<name>` key, or None."""
    return next((found for found in find_maps() if found["key"] == key), None)


# --- reading one box ----------------------------------------------------------

def _parse_front(text):
    """Split a box file into (fields, body). The fields block is a small,
    fixed subset of YAML — `key: value` lines and `- item` lists under a key —
    read by hand so the format needs no parser library and can't grow
    surprises. Returns (None, text) when the file has no fields block."""
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end < 0:
        return None, text
    fields, current = {}, None
    for line in text[3:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if stripped.startswith("- ") and current is not None:
            fields.setdefault(current, []).append(stripped[2:].strip())
            continue
        key, colon, value = line.partition(":")
        if not colon:
            continue
        current = key.strip()
        value = value.strip()
        fields[current] = value if value else []
    body = text[end + 4:].lstrip("\n")
    return fields, body.strip()


def _text(fields, key):
    """A single-valued field as a string ('' when absent or a list)."""
    value = fields.get(key)
    return value.strip() if isinstance(value, str) else ""


def read_box(path):
    """One box file as a dict, with `problems` listing anything malformed in
    it. A malformed box is still returned — a page that drops a box because of
    a typo hides the typo; one that shows the box with a warning gets it fixed."""
    problems = []
    fields, body = _parse_front(path.read_text(encoding="utf-8", errors="replace"))
    if fields is None:
        fields, problems = {}, ["no --- fields block at the top"]
    box_id = _text(fields, "id") or path.stem
    if not _ID_RE.match(box_id):
        problems.append(f"id '{box_id}' isn't lowercase words, dots and dashes")
    kind = _text(fields, "kind") or "module"
    if kind not in BOX_KINDS:
        problems.append(f"kind '{kind}' isn't one of {', '.join(BOX_KINDS)}")
    links = []
    for raw in fields.get("links") or []:
        match = _LINK_RE.match(raw) if isinstance(raw, str) else None
        if not match or match.group(1) not in LINK_KINDS:
            problems.append(f"link not understood: {raw}")
            continue
        links.append({"kind": match.group(1), "to": match.group(2),
                      "reason": match.group(3).strip()})
    sources = [s for s in (fields.get("sources") or []) if isinstance(s, str)]
    return {"id": box_id, "file": path.name, "name": _text(fields, "name") or box_id,
            "kind": kind, "parent": _text(fields, "parent") or None,
            "order": _int(_text(fields, "order")),
            "sources": sources, "links": links, "description": body,
            "written": _text(fields, "written") or None,
            "fingerprint": _text(fields, "fingerprint") or None,
            "problems": problems}


def _int(raw):
    try:
        return int(raw)
    except ValueError:
        return None


# --- source files and fingerprints --------------------------------------------

def _source_files(root, source):
    """The files one `sources` entry stands for, repo-relative: the file
    itself, or every file under a folder (skipping build output and vendored
    code, the same folders codegraph never walks). None when it doesn't exist."""
    target = (root / source).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None                  # a source may not reach outside its repo
    if target.is_file():
        return [source.rstrip("/")]
    if not target.is_dir():
        return None
    out = []
    for dirpath, dirnames, filenames in os.walk(target):
        dirnames[:] = sorted(d for d in dirnames if d not in codegraph.SKIP_DIRS)
        for name in sorted(filenames):
            out.append(str((Path(dirpath) / name).relative_to(root.resolve())))
    return out


def fingerprint(root, sources):
    """A short hash over every file a box stands for — its path and its bytes.
    Any edit, addition, removal or rename among them changes it. None when the
    box names no sources (a grouping box has nothing of its own to go stale)."""
    if not sources:
        return None
    digest = hashlib.sha256()
    for source in sorted(sources):
        for relpath in sorted(_source_files(root, source) or []):
            digest.update(relpath.encode())
            try:
                digest.update(hashlib.sha256((root / relpath).read_bytes()).digest())
            except OSError:
                continue
    return digest.hexdigest()[:12]


# --- reading and checking a whole map -------------------------------------------

def load(found):
    """A map's boxes, checked: every box from its folder, each with its
    sources' existence, whether it is stale or broken, and its problems —
    including links to boxes that don't exist and parents that don't exist.

    Returns {key, repo, name, root, boxes, problems}. `root` is the id of the
    box with no parent; a map with none (or several) says so in `problems`."""
    root_dir = found["root"]
    boxes = [read_box(path) for path in sorted(found["dir"].glob("*.md"))]
    by_id, problems = {}, []
    for box in boxes:
        if box["id"] in by_id:
            problems.append(f"two boxes are called '{box['id']}' ({by_id[box['id']]['file']}, {box['file']})")
            continue
        by_id[box["id"]] = box

    # Check every box against its files and against the rest of the map.
    for box in boxes:
        files_exist = []
        for source in box["sources"]:
            exists = _source_files(root_dir, source) is not None
            files_exist.append({"path": source, "exists": exists})
        box["sources"] = files_exist
        box["broken"] = any(not s["exists"] for s in files_exist)
        current = fingerprint(root_dir, [s["path"] for s in files_exist])
        box["stale"] = current is not None and current != box["fingerprint"]
        if box["parent"] and box["parent"] not in by_id:
            box["problems"].append(f"parent '{box['parent']}' isn't a box in this map")
        for link in box["links"]:
            if link["to"] not in by_id:
                box["problems"].append(f"link to '{link['to']}', which isn't a box in this map")
        box["links"] = [link for link in box["links"] if link["to"] in by_id]

    # A parent chain that loops back on itself would hang every walk up the tree.
    for box in boxes:
        seen, at = set(), box
        while at and at["parent"]:
            if at["id"] in seen:
                box["problems"].append("its parent chain loops back on itself")
                box["parent"] = None
                break
            seen.add(at["id"])
            at = by_id.get(at["parent"])

    tops = [box for box in by_id.values() if not box["parent"]]
    project = [box for box in tops if box["kind"] == "project"]
    root = (project or tops or [None])[0]
    if len(project) != 1:
        problems.append("a map needs exactly one box of kind 'project' with no parent")
    # Any other parentless box hangs under the top box, so nothing is lost.
    for box in tops:
        if root and box is not root:
            box["parent"] = root["id"]
    return {"key": found["key"], "repo": found["repo"], "repo_name": found["repo_name"],
            "name": root["name"] if root else found["slug"],
            "root": root["id"] if root else None,
            "boxes": list(by_id.values()), "problems": problems}


def summary(loaded):
    """The handful of counts a map's switch shows: boxes, stale, broken."""
    boxes = loaded["boxes"]
    return {"key": loaded["key"], "name": loaded["name"], "repo": loaded["repo"],
            "repo_name": loaded["repo_name"], "boxes": len(boxes),
            "stale": sum(1 for box in boxes if box["stale"]),
            "broken": sum(1 for box in boxes if box["broken"]),
            "problems": len(loaded["problems"]) + sum(len(box["problems"]) for box in boxes)}


# --- stamping a box after its words are rewritten ------------------------------

_FINGERPRINT_LINE = re.compile(r"^fingerprint:.*$", re.M)
_WRITTEN_LINE = re.compile(r"^written:.*$", re.M)


def stamp(found, box_ids=None, today=None):
    """Record each box's current fingerprint (and today's date as `written`),
    saying "its words match its files as of now". Only the named boxes, or
    every box when none are named. Returns the ids stamped.

    Run by a session right after it has re-read a box's files and rewritten
    its description — stamping a box whose words weren't checked hides
    exactly the drift this exists to show."""
    today = today or date.today().isoformat()
    stamped = []
    for path in sorted(found["dir"].glob("*.md")):
        box = read_box(path)
        if box_ids and box["id"] not in box_ids:
            continue
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            continue
        current = fingerprint(found["root"], box["sources"]) or ""
        end = text.find("\n---", 3)
        head, rest = text[:end], text[end:]
        for pattern, line in ((_FINGERPRINT_LINE, f"fingerprint: {current}"),
                              (_WRITTEN_LINE, f"written: {today}")):
            head = pattern.sub(line, head, count=1) if pattern.search(head) else f"{head}\n{line}"
        path.write_text(head + rest, encoding="utf-8")
        stamped.append(box["id"])
    return stamped


# --- the import scan: which box's files import which ---------------------------

def _workspace_packages(root):
    """A pnpm/npm workspace's own package names → {folder, exports}, so
    `import … from '@scope/contracts'` can be followed into the package.
    Read from every package.json below the root (outside node_modules)."""
    packages = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in codegraph.SKIP_DIRS]
        if "package.json" in filenames and Path(dirpath) != Path(root):
            try:
                manifest = json.loads((Path(dirpath) / "package.json").read_text())
            except (OSError, ValueError):
                continue
            if isinstance(manifest.get("name"), str):
                packages[manifest["name"]] = {
                    "folder": str(Path(dirpath).relative_to(root)),
                    "exports": manifest.get("exports"), "main": manifest.get("main")}
    return packages


def _package_file(package, subpath, root):
    """The file a workspace import lands on: the package.json `exports` entry
    for that subpath ("." for the bare name), else `main`, else the usual
    `src/index.ts` — so the import is owned by the box that owns that file,
    not by whichever box happens to own the package folder."""
    exports = package["exports"]
    key = "." + subpath if subpath else "."
    target = None
    if isinstance(exports, str) and not subpath:
        target = exports
    elif isinstance(exports, dict):
        entry = exports.get(key)
        if isinstance(entry, dict):          # conditional exports: {import, types, default}
            entry = entry.get("import") or entry.get("default") or entry.get("types")
        target = entry if isinstance(entry, str) else None
    if target is None and not subpath and isinstance(package["main"], str):
        target = package["main"]
    folder = package["folder"]
    if target:
        return os.path.normpath(os.path.join(folder, target))
    for guess in ("src/index.ts", "src/index.tsx", "index.ts", "index.js"):
        candidate = os.path.join(folder, subpath.lstrip("/"), guess) if subpath else os.path.join(folder, guess)
        if (Path(root) / candidate).is_file():
            return os.path.normpath(candidate)
    return os.path.normpath(os.path.join(folder, subpath.lstrip("/")))


def _owner(path, claims):
    """The box that owns a file: the one whose source is the longest match
    (a file named outright beats the folder it sits in)."""
    best, best_len = None, -1
    for source, box_id in claims:
        clean = source.rstrip("/")
        if (path == clean or path.startswith(clean + "/")) and len(clean) > best_len:
            best, best_len = box_id, len(clean)
    return best


def import_links(loaded, root):
    """Every box-to-box import found in the code: [(from box, to box, count)],
    most imports first. Only boxes with sources take part; an import whose
    either end is in no box is left out.

    What an import says is only "this can reach that" (see codegraph.py) —
    a helper for writing links, never a link itself."""
    claims = [(source["path"], box["id"]) for box in loaded["boxes"] for source in box["sources"]]
    packages = _workspace_packages(root)
    _files, edges = codegraph.build(repos=[{"id": loaded["repo"], "root": root}])
    counts = {}
    for _repo, src, dst_repo, dst, _kind, _symbols in edges:
        if not dst_repo:
            # A bare specifier may still be one of the workspace's own packages,
            # with or without a subpath (`@scope/db/testing`).
            package = next((name for name in packages if dst == name or dst.startswith(name + "/")), None)
            if package is None:
                continue
            dst = _package_file(packages[package], dst[len(package):], root)
        frm, to = _owner(src, claims), _owner(dst, claims)
        if frm and to and frm != to:
            counts[(frm, to)] = counts.get((frm, to), 0) + 1
    return sorted(((frm, to, n) for (frm, to), n in counts.items()), key=lambda row: -row[2])
