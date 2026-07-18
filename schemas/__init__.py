"""Schema validation at the write seam.

Every write funnels through store.write() / store.mutate() (the seam); this
package is the guard hung there so every writer, present and future, inherits
it. One JSON Schema (draft 2020-12) document per collection, language-neutral
by design: later served verbatim by /api/meta, and the Rust add-todo binary
can validate against the same files via the jsonschema crate.

Schemas are floors, not ceilings: required keys + types are locked, unknown
fields are allowed, legacy variance is tolerated. A collection with no schema
file here is simply not validated (see SQL_COLLECTIONS-style opt-in).

This module must NOT import store (store imports this one at call time inside
write()/mutate() to avoid a cycle) — keep this package a leaf.
"""
import json
import os
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

_SCHEMA_DIR = Path(__file__).parent


class SchemaError(Exception):
    """Raised by validate() when data doesn't match its collection's schema.

    Deliberately NOT a ValueError: routes catch ValueError in request paths
    today, and a schema violation should never risk being silently swallowed
    by an existing `except ValueError` somewhere down the call stack.
    """

    def __init__(self, collection, path, message):
        self.collection = collection
        self.path = path
        self.message = message
        super().__init__(f"{collection}: {path} — {message}")


def _load_validators():
    """Load + check every schemas/*.json at import time (fail fast on a bad
    schema) and compile each into a Validator once — writes happen per UI tap,
    so we don't want to re-parse/re-compile a schema on every call."""
    validators = {}
    for path in sorted(_SCHEMA_DIR.glob("*.json")):
        schema = json.loads(path.read_text())
        Draft202012Validator.check_schema(schema)
        validators[path.stem] = Draft202012Validator(schema)
    return validators


_VALIDATORS = _load_validators()

# Public: which collections have a schema at all (schema-less collections are
# skipped by validate()/iter_violations() and by scripts/validate_data.py).
COLLECTIONS = frozenset(_VALIDATORS)


def validate(name, data):
    """Validate `data` before it's written to collection `name`.

    No-op if there's no schema for `name` (unknown collections pass through
    untouched), or if EXOCORTEX_SCHEMA_OFF=1 — the kill switch, read at CALL
    time (not import time) so monkeypatch in tests and an ops env-flip both
    take effect without a reimport.

    Raises SchemaError for the single best-matched violation, formatted as
    "<collection>: <json path> — <message>" — an agent-readable fix
    instruction (one retry, not five).
    """
    if os.environ.get("EXOCORTEX_SCHEMA_OFF", "") == "1":
        return
    validator = _VALIDATORS.get(name)
    if validator is None:
        return
    errors = list(validator.iter_errors(data))
    if not errors:
        return
    err = best_match(errors)
    raise SchemaError(name, err.json_path, err.message)


def iter_violations(name, data):
    """ALL violations for collection `name` against `data`, as strings.

    Ignores the kill switch (this is for the rollout checker script, which
    must see the real state of the data regardless of EXOCORTEX_SCHEMA_OFF).
    Returns [] for a collection with no schema.
    """
    validator = _VALIDATORS.get(name)
    if validator is None:
        return []
    return [f"{e.json_path} — {e.message}" for e in validator.iter_errors(data)]


def install_error_handler(app):
    """Register a Flask error handler turning SchemaError into a clean 400.

    Call once from server.py's startup wiring, and from any test that builds
    its own minimal Flask app and wants route-level 400s on schema failure.
    """
    from flask import jsonify

    @app.errorhandler(SchemaError)
    def _handle_schema_error(e):
        return jsonify({"error": str(e), "collection": e.collection, "path": e.path}), 400
