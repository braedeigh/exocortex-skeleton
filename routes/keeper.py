"""Keeper tab — browse and edit the keeper's memory files.

The keeper (tulku) records everything it remembers about the owner as markdown in
the content vault (EXOCORTEX_CONTENT_DIR = .../tulku): about.md, WORRIES.md,
THREADS.md, people/, Patterns/, context/, the diary, daily journal, protocols.
This surfaces that whole tree read/write so the owner can see how memory gets recorded
and fix kinks in place.

Hard-scoped: only *.md files inside CONTENT_DIR are reachable, no traversal out,
no other extensions. The before_request gate keeps the routes auth-only (they're
not in PUBLIC_PATHS), so this never leaks private memory to the public view.
"""
from flask import request, jsonify

import store

# Top-level folders to hide from the tree: old/retired system files read only on
# demand, never part of the living memory she'd want to browse.
EXCLUDE_DIRS = {"archive"}


def _vault():
    # Resolve fresh each call so tests/env overrides of CONTENT_DIR are honored.
    return store.CONTENT_DIR.resolve()


def _resolve(rel):
    """Resolve a vault-relative path to a real .md file inside the vault, or None
    if it escapes the vault or isn't markdown. Traversal-proof."""
    if not rel:
        return None
    base = _vault()
    try:
        full = (base / rel).resolve()
    except (ValueError, OSError):
        return None
    if not full.is_relative_to(base):
        return None
    if full.suffix != ".md":
        return None
    return full


def build_tree():
    """Every browsable .md file in the vault, as flat records the client groups.
    group = top-level folder name, or 'Core' for files sitting at the vault root."""
    base = _vault()
    if not base.exists():
        return []
    files = []
    for p in sorted(base.rglob("*.md")):
        rel = p.relative_to(base)
        parts = rel.parts
        if parts[0] in EXCLUDE_DIRS:
            continue
        group = parts[0] if len(parts) > 1 else "Core"
        try:
            mtime = int(p.stat().st_mtime)
        except OSError:
            mtime = 0
        files.append({
            "path": rel.as_posix(),
            "name": p.stem,
            "group": group,
            "mtime": mtime,
        })
    return files


def register(app):
    @app.route("/api/keeper/tree")
    def keeper_tree():
        return jsonify({"files": build_tree()})

    @app.route("/api/keeper/file")
    def keeper_file_get():
        full = _resolve(request.args.get("path", ""))
        if full is None:
            return jsonify({"error": "invalid path"}), 400
        if not full.exists():
            return jsonify({"error": "not found"}), 404
        return jsonify({
            "path": full.relative_to(_vault()).as_posix(),
            "content": full.read_text(),
        })

    @app.route("/api/keeper/file", methods=["POST"])
    def keeper_file_save():
        data = request.json or {}
        full = _resolve(data.get("path", ""))
        if full is None:
            return jsonify({"error": "invalid path"}), 400
        # Only edit files that already exist — this tab fixes memory, it doesn't
        # invent new keeper files (those are the keeper's job, in session).
        if not full.exists():
            return jsonify({"error": "not found"}), 404
        full.write_text(data.get("content", ""))
        return jsonify({"ok": True})

    @app.route("/api/keeper/file", methods=["DELETE"])
    def keeper_file_delete():
        full = _resolve(request.args.get("path", ""))
        if full is None:
            return jsonify({"error": "invalid path"}), 400
        if not full.exists():
            return jsonify({"error": "not found"}), 404
        rel = full.relative_to(_vault())
        # Hand the content + group back so the client can offer Undo and bump the
        # user into the deleted file's folder. (Everything's also under hourly git
        # backup, so a delete is never truly unrecoverable.)
        content = full.read_text()
        group = rel.parts[0] if len(rel.parts) > 1 else "Core"
        full.unlink()
        return jsonify({"ok": True, "path": rel.as_posix(), "group": group, "content": content})

    @app.route("/api/keeper/file/restore", methods=["POST"])
    def keeper_file_restore():
        # Undo of a delete: recreate the file. This is the one create path this tab
        # allows — and only right after a delete, from content the server just gave out.
        data = request.json or {}
        full = _resolve(data.get("path", ""))
        if full is None:
            return jsonify({"error": "invalid path"}), 400
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(data.get("content", ""))
        return jsonify({"ok": True, "path": full.relative_to(_vault()).as_posix()})
