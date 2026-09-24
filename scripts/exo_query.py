#!/usr/bin/env python3
"""The research agents' window onto the owner's tables — read-only, from the shell.

This is how a research agent (runner, deep, filer, worker — or any Claude turn
working in this checkout) looks at what is in exo.db: which tables exist, what
each one holds, and what a SELECT over them returns. It is a command line
rather than a route because the agents live in shell turns. Every query goes
through sqlquery.run_query — the same guarded door the browser's SQL console
uses — so an agent cannot write, cannot run two statements at once, cannot pin
the machine with a runaway join, and cannot read a table that
config.SQL_AGENT_DENY_TABLES fences off (blank today: the owner chose to let
agents read everything).

Three commands:

    EXOCORTEX_DATA_DIR=/path/to/data python3 exo_query.py schema
        One line per table — `name  kind  holds` — from table_notes.json at
        the repo root (kind is mirror / record / store / mixed; see the
        `_about` entry in that file). A table the database has but the notes
        don't yet is listed as `name  (no note yet)`.

    EXOCORTEX_DATA_DIR=/path/to/data python3 exo_query.py schema <table>
        That table's holds, source and time_column, then one line per column
        — `name  holds  [values: …]` — where the values part appears only for
        a column that holds a fixed set of categories.

    EXOCORTEX_DATA_DIR=/path/to/data python3 exo_query.py query "<sql>" [--limit N] [--json]
        Run one SELECT (or WITH, or EXPLAIN). Output is TSV by default: a
        header row, then one row per line, tab-separated. A tab, newline,
        carriage return or backslash inside a cell is escaped (\\t \\n \\r \\\\)
        so every row stays one line. A trailing `# N rows` — or
        `# N rows (truncated)` when the cap cut the result — goes to stderr,
        so it never lands in the data. --json prints run_query's dict instead,
        query plan included.

Why TSV is the default: an agent reads this output as tokens, and TSV costs
far fewer of them than JSON — no quotes, no braces, no key repeated on every
row. Reach for --json when exact types matter: in TSV a NULL and an empty
string both print as an empty cell, and a BLOB prints as hex.

Exit code 1 with the reason on stderr on any refusal or error; 0 otherwise.

Can also be imported and driven directly: main(["query", "SELECT 1"]).

Touches: sqlquery.py (the door), config.py (the deny-list), table_notes.json
(the plain-English notes the schema command prints).

Prompt that produced this file: "The agents' door: a CLI in the style of
scripts/research_ctl.py with `schema`, `schema <table>`, and
`query \"<sql>\" [--limit N] [--json]`. TSV by default because it costs fewer
tokens than JSON; passes config.SQL_AGENT_DENY_TABLES; exit code 1 with the
message on stderr."
"""
import argparse
import json
import os
import sys

# Make the skeleton root importable regardless of where the script is invoked from.
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import config  # noqa: E402
import sqlquery  # noqa: E402

NOTES_PATH = os.path.join(SKELETON, "table_notes.json")


def load_notes():
    """The hand-written table notes, {table: {holds, source, kind, time_column,
    columns}}, with the file's own `_about` entry dropped. A missing or broken
    file comes back as {} — `schema` then still lists what the database has,
    just with every table marked as having no note, which is honest."""
    try:
        with open(NOTES_PATH) as handle:
            notes = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(notes, dict):
        return {}
    return {name: note for name, note in notes.items()
            if name != "_about" and isinstance(note, dict)}


def database_tables():
    """Every user table in exo.db, alphabetically, each with its columns in
    declared order — or None when there is no database file to open."""
    if not sqlquery.db_path().exists():
        return None
    conn = sqlquery.read_only_connection()
    try:
        names = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
            " AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        # Table names come from sqlite_master, not from the caller, so quoting
        # them into PRAGMA is safe — and needed, for a table named `order`.
        return {name: [column[1] for column in conn.execute(f'PRAGMA table_info("{name}")')]
                for name in names}
    finally:
        conn.close()


def schema_overview_lines(tables, notes, deny_tables):
    """One line per table: `name  kind  holds`, flagged when the deny-list
    would refuse it, so an agent doesn't spend a query finding that out."""
    lines = []
    for name in tables:
        note = notes.get(name)
        if note is None:
            line = f"{name}  (no note yet)"
        else:
            line = f"{name}  {note.get('kind') or '?'}  {note.get('holds') or ''}"
        if name in deny_tables:
            line += "  [off limits to agents]"
        lines.append(line)
    return lines


def schema_table_lines(name, columns, note):
    """A table's card: holds / source / time_column, then `name  holds` per
    column with its fixed values spelled out when the note has them. Columns
    come from the database (the truth about what exists) and descriptions
    from the note, so a column the note hasn't caught up with still appears."""
    lines = [
        name,
        f"holds: {note.get('holds') or '(no note yet)'}",
        f"source: {note.get('source') or '(no note yet)'}",
        f"time_column: {note.get('time_column') or 'none'}",
        "columns:",
    ]
    column_notes = note.get("columns") or {}
    for column in columns:
        column_note = column_notes.get(column) or {}
        line = f"  {column}  {column_note.get('holds') or '(no note yet)'}"
        values = column_note.get("values")
        if isinstance(values, dict) and values:
            spelled = "; ".join(f"{value}={meaning}" for value, meaning in values.items())
            line += f"  [values: {spelled}]"
        lines.append(line)
    return lines


def tsv_cell(value):
    """One cell kept on one line: NULL is empty, a BLOB is hex, everything
    else is its text with backslash, tab, newline and carriage return escaped
    — backslash first, so an escape can never be mistaken for a literal one."""
    if value is None:
        return ""
    text = value.hex() if isinstance(value, bytes) else str(value)
    return (text.replace("\\", "\\\\").replace("\t", "\\t")
                .replace("\n", "\\n").replace("\r", "\\r"))


def fail(code, message):
    """Print a refusal the way every error here is printed, and hand back the
    exit status for it."""
    print(f"error ({code}): {message}", file=sys.stderr)
    return 1


def schema_command(table):
    tables = database_tables()
    if tables is None:
        return fail("no_database", f"No database at {sqlquery.db_path()}.")
    notes = load_notes()
    if table is None:
        for line in schema_overview_lines(tables, notes, config.SQL_AGENT_DENY_TABLES):
            print(line)
        return 0
    if table not in tables:
        return fail("no_such_table", f"No table named '{table}'.")
    for line in schema_table_lines(table, tables[table], notes.get(table) or {}):
        print(line)
    return 0


def query_command(sql, limit, as_json):
    """Run the statement through the shared door and print what came back.
    The plan is only computed for --json, where there is somewhere to put it."""
    result = sqlquery.run_query(
        sql, max_rows=limit, deny_tables=config.SQL_AGENT_DENY_TABLES, explain=as_json,
    )
    if "error" in result:
        return fail(result["error"], result["message"])
    if as_json:
        print(json.dumps(result, default=str))
        return 0
    print("\t".join(result["columns"]))
    for row in result["rows"]:
        print("\t".join(tsv_cell(value) for value in row))
    note = " (truncated)" if result["truncated"] else ""
    print(f"# {result['row_count']} rows{note}", file=sys.stderr)
    return 0


def positive_int(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("--limit must be at least 1")
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="exo_query.py",
        description="Read-only window onto exo.db for research agents.")
    commands = parser.add_subparsers(dest="command", required=True)

    schema = commands.add_parser("schema", help="list the tables, or describe one")
    schema.add_argument("table", nargs="?", help="a table name; omit to list all")

    query = commands.add_parser("query", help="run one read-only statement")
    query.add_argument("sql")
    query.add_argument("--limit", type=positive_int, default=sqlquery.MAX_ROWS,
                       help=f"row cap (default {sqlquery.MAX_ROWS})")
    query.add_argument("--json", dest="as_json", action="store_true",
                       help="print run_query's dict instead of TSV")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "schema":
        return schema_command(args.table)
    return query_command(args.sql, args.limit, args.as_json)


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts — so a query an agent ran shows up as a traced process.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
