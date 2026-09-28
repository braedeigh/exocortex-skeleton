"""commons.db — the rows parsed out of the commons' public files, ready to query.

**What this is.** The commons (commons.py) keeps public data files exactly as
published: USDA's Pesticide Data Program zips, EPA's benchmark table. This
module keeps the rows read OUT of those files in one SQLite file beside them,
`<commons>/commons.db`, so the app can ask "every potato sample from 2023,
organic only" without unzipping 130 MB each time. It is derived: delete it and
the loaders in `reference_loaders.py` rebuild it from the files, which is why
the commons repo never commits it and why it isn't in exo.db (the owner's own
record, backed up every day).

What it holds:
  pdp_samples      one row per USDA sample — which food, when, where, and the
                   claim on its label (PO = organic, NC = no claim, …)
  pdp_results      one row per pesticide tested on a sample; a NULL
                   concentration is a non-detect
  pdp_pesticides   PDP's pesticide codes and names, per year
  pdp_tolerances   EPA's legal tolerance for each pesticide × commodity pair,
                   as PDP printed it that year
  pdp_commodities  PDP's commodity codes and names, per year
  epa_benchmarks   EPA's Human Health Benchmarks for Pesticides table, one row
                   per pesticide (the chronic safe daily dose lives here)
  iris_rfd         EPA IRIS's table of oral reference doses, one row per
                   chemical — the second place a chronic dose is read from,
                   for pesticides the benchmark table leaves out

Touches: `commons.py` (where the folder is), `reference_loaders.py` (fills it),
`exposure.py` (reads it), `tests/test_commonsdb.py`. Design: docs/exposure.md.

Prompt that produced this file: "raw data must be combable: store every sample
row … the page filters and combines years and organic vs conventional, and
always shows the sample count" — with the files themselves kept in the commons.
"""
from contextlib import contextmanager
from pathlib import Path
import sqlite3

import commons

DB_NAME = "commons.db"
_SCHEMA_VERSION = 2

# The schema, all CREATE ... IF NOT EXISTS, so opening an older file adds
# whatever is missing. Column names follow PDP's own data dictionary
# (lowercased), so a row here can be checked against the file by eye.
_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS pdp_samples ("
    "  year INTEGER NOT NULL,"
    "  sample_pk INTEGER NOT NULL,"
    "  state TEXT, month TEXT, day TEXT, site TEXT,"
    "  commod TEXT NOT NULL,"
    "  source_id TEXT, variety TEXT, origin TEXT, country TEXT, disttype TEXT,"
    "  commtype TEXT,"
    "  claim TEXT,"
    "  quantity INTEGER, growst TEXT, packst TEXT, distst TEXT,"
    "  PRIMARY KEY (year, sample_pk)"
    ")",
    "CREATE INDEX IF NOT EXISTS pdp_samples_by_commod ON pdp_samples (commod, year, claim)",
    "CREATE TABLE IF NOT EXISTS pdp_results ("
    "  year INTEGER NOT NULL,"
    "  sample_pk INTEGER NOT NULL,"
    "  commod TEXT NOT NULL, commtype TEXT, lab TEXT,"
    "  pestcode TEXT NOT NULL,"
    "  testclass TEXT,"
    # As printed (NULL = not detected) in `conunit`, and the same in ppb.
    "  concen REAL, lod REAL, conunit TEXT,"
    "  concen_ppb REAL, lod_ppb REAL,"
    "  confmethod TEXT, confmethod2 TEXT, annotate TEXT, quantitate TEXT,"
    "  mean TEXT, extract TEXT, determin TEXT"
    ")",
    "CREATE INDEX IF NOT EXISTS pdp_results_by_sample ON pdp_results (year, sample_pk)",
    "CREATE INDEX IF NOT EXISTS pdp_results_by_pest ON pdp_results (commod, year, pestcode)",
    "CREATE TABLE IF NOT EXISTS pdp_pesticides ("
    "  year INTEGER NOT NULL, pestcode TEXT NOT NULL, name TEXT NOT NULL, testclass TEXT,"
    "  PRIMARY KEY (year, pestcode)"
    ")",
    "CREATE TABLE IF NOT EXISTS pdp_tolerances ("
    "  year INTEGER NOT NULL, pestcode TEXT NOT NULL, commod TEXT NOT NULL,"
    # A number, or NT (no tolerance), EX (exempt), SU (surface use).
    "  epatol TEXT, tolunit TEXT, note TEXT, comment TEXT,"
    "  PRIMARY KEY (year, pestcode, commod)"
    ")",
    "CREATE TABLE IF NOT EXISTS pdp_commodities ("
    "  year INTEGER NOT NULL, commod TEXT NOT NULL, name TEXT NOT NULL, samples INTEGER,"
    "  PRIMARY KEY (year, commod)"
    ")",
    "CREATE TABLE IF NOT EXISTS epa_benchmarks ("
    "  name TEXT PRIMARY KEY COLLATE NOCASE,"
    "  cas TEXT,"
    # mg/kg/day. The chronic one is a cRfD or, where FQPA applies, a cPAD.
    "  acute_dose REAL, chronic_dose REAL,"
    "  cancer_slope REAL,"
    "  memo_url TEXT,"
    # Each cell exactly as the page printed it, as JSON, for checking by eye.
    "  as_printed TEXT NOT NULL DEFAULT '{}',"
    "  file_sha256 TEXT NOT NULL"
    ")",
    "CREATE TABLE IF NOT EXISTS iris_rfd ("
    "  name TEXT PRIMARY KEY COLLATE NOCASE,"
    # The short name IRIS prints in brackets after the long one ("DDT"), if any.
    "  short_name TEXT COLLATE NOCASE,"
    "  cas TEXT,"
    # mg/kg/day, IRIS's chronic oral reference dose.
    "  rfd REAL NOT NULL,"
    "  critical_effect TEXT, confidence TEXT,"
    "  landing_url TEXT,"
    "  as_printed TEXT NOT NULL DEFAULT '{}',"
    "  file_sha256 TEXT NOT NULL"
    ")",
)


def db_path(root=None):
    """Where commons.db is: in the commons folder, beside the files."""
    return Path(root or commons.commons_dir()) / DB_NAME


def connect(root=None):
    """Open commons.db with the schema in place (created on first use)."""
    path = db_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    # Build the schema only when the stamp says it's older than this code.
    if conn.execute("PRAGMA user_version").fetchone()[0] < _SCHEMA_VERSION:
        for statement in _SCHEMA:
            conn.execute(statement)
        conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
        conn.commit()
    return conn


@contextmanager
def session(root=None):
    """A connection that commits on success, rolls back on error, always closes."""
    conn = connect(root)
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def sample_count(conn, year, commod):
    """How many samples of one commodity one year are loaded — 0 if none."""
    return conn.execute("SELECT COUNT(*) FROM pdp_samples WHERE year = ? AND commod = ?",
                        (year, commod)).fetchone()[0]
