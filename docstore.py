"""docstore — resolve namespaced doc ids to annotatable text.

The seam that makes the annotation layer generic: annotations attach to a
doc id, and this module is the only place that knows what a doc id means.

    entry:<entry-id>    extracted text of a research source entry, stored as
                        a plain file under DATA_DIR/doc_texts/ (written by
                        the fetch-text route; survives in the vault's git)
    note:<filename>     a markdown file in store.RESEARCH_DIR (read-only)

Future namespaces slot in as one more branch in resolve() — e.g.
`journal:<path>` for Cricket sessions annotating the journals.

Shapes (Rust-friendly: errors as values, no exceptions escape):
    resolve(doc_id) -> {"ok": True, "text": str, "title": str}
                     | {"ok": False, "error": "unknown_namespace"
                                            | "not_found" | "bad_path"}
"""
import re
from pathlib import Path

import store


def _texts_dir():
    return Path(store.DATA_DIR) / "doc_texts"


def _entry_path(entry_id):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(entry_id))
    return _texts_dir() / f"entry-{safe}.txt"


def save_entry_text(entry_id, text):
    path = _entry_path(entry_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _md_title(text):
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
        if line.strip():
            break
    return ""


def _resolve_note(filename):
    root = store.RESEARCH_DIR.resolve()
    try:
        target = (root / filename).resolve()
    except (OSError, ValueError):
        return {"ok": False, "error": "bad_path"}
    if not target.is_relative_to(root) or target.suffix != ".md":
        return {"ok": False, "error": "bad_path"}
    if not target.is_file():
        return {"ok": False, "error": "not_found"}
    try:
        text = target.read_text()
    except OSError:
        return {"ok": False, "error": "not_found"}
    return {"ok": True, "text": text, "title": _md_title(text) or target.stem}


def resolve(doc_id):
    doc_id = str(doc_id or "")
    if doc_id.startswith("entry:"):
        path = _entry_path(doc_id[len("entry:"):])
        if not path.is_file():
            return {"ok": False, "error": "not_found"}
        try:
            return {"ok": True, "text": path.read_text(), "title": ""}
        except OSError:
            return {"ok": False, "error": "not_found"}
    if doc_id.startswith("note:"):
        return _resolve_note(doc_id[len("note:"):])
    return {"ok": False, "error": "unknown_namespace"}


def has_text(doc_id):
    return resolve(doc_id).get("ok", False)
