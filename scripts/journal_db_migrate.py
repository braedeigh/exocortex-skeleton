#!/usr/bin/env python3
"""Move the journal's card files into exo.db, then prove every card arrived.

**What this does, in plain English.** Until 2026-11 each journal card was a
markdown file in the vault (`tulku/_system/data/cards/<id>.md`). Now the
database is the truth (`docs/journal-database.md`). This script is the
one-time move:

  1. Opens exo.db, which climbs the migration ladder — rung 61 builds the new
     journal tables and renames the old hourly mirror out of the way.
  2. Loads every card file as a row: same id, time, speaker, words, kind,
     session and refs. Each tag becomes a label (`added_by = 'migration'`),
     classified as a person, thread, front, source or topic. A `reply_to`
     becomes an `answers` link.
  3. Loads the old deletion log (`deleted_cards.jsonl`): each card deleted
     back when cards were files becomes a row with `deleted_at` set, its
     words preserved — unless a file with that id exists (the file wins).
  4. Loads the old edit log (`edited_cards.jsonl`) into `card_edits`.
  5. Verifies, card by card: every file has a row whose id, speaker, time,
     words, kind, session, refs, tags and reply link match, and whose
     fingerprint matches its words; every deleted card is a hidden row; the
     number of live rows equals the number of files. Any mismatch is printed
     and the script exits 1.

It is insert-only and safe to run again: a card that already has a row is
left alone and only verified. `--verify-only` skips steps 2–4.

Usage:
    scripts/journal_db_migrate.py                # migrate, then verify
    scripts/journal_db_migrate.py --verify-only  # just check

Touches: `cardstore.py` (the file import), `tools/stream/stream.py` (file
parsing, import_card), `tools/stream/journaldb.py` (the tables),
`sqlstore.py` (the ladder).

Prompt: "Verify card-by-card (count, ids, body fingerprints) before
switching anything."
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKELETON = HERE.parent
if str(SKELETON) not in sys.path:
    sys.path.insert(0, str(SKELETON))

import cardstore                      # noqa: E402
import sqlstore                       # noqa: E402
import store                          # noqa: E402
from tools.stream import stream       # noqa: E402

journaldb = stream.journaldb


def _jsonl(path: Path):
    """Every parseable object line of a JSON-lines file; missing file = none."""
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("id"):
            entries.append(entry)
    return entries


def read_pool(pool: Path):
    """Every card file, parsed: ({id: Card}, [problems])."""
    cards, problems = {}, []
    for path in sorted(pool.glob("*.md")):
        try:
            card = stream.parse_card_file(path)
        except (stream.StreamError, OSError, UnicodeDecodeError) as e:
            problems.append(f"UNREADABLE {path.name}: {e}")
            continue
        if card.id != path.stem:
            problems.append(f"MISNAMED {path.name}: its id field says {card.id!r}")
            continue
        cards[card.id] = card
    return cards, problems


def migrate(pool: Path, files: dict):
    """Steps 2-4. Returns a dict of counts."""
    counts = {"cards added": 0, "deleted cards added": 0, "edits added": 0, "refused": 0}
    casts = {}
    for entry in _jsonl(cardstore.deleted_log_path()):
        casts[entry["id"]] = entry  # a card deleted twice: the last cast wins
    conn = sqlstore.open_db()
    try:
        context = cardstore._label_context()
        sqlstore.begin_immediate(conn)
        try:
            loaded = []
            for card in files.values():
                try:
                    if stream.import_card(conn, card, context=context, links=False):
                        counts["cards added"] += 1
                        loaded.append(card)
                except Exception as e:   # one bad card never stops the rest
                    counts["refused"] += 1
                    print(f"REFUSED {card.id}: {e}", file=sys.stderr)
            for cid, entry in casts.items():
                if cid in files:
                    continue
                card = stream.Card(
                    id=cid, who=entry.get("who") or "B", ts=entry.get("ts") or "",
                    reply_to=entry.get("reply_to"), tags=list(entry.get("tags") or []),
                    kind=entry.get("kind") or "line", refs=list(entry.get("refs") or []),
                    session=entry.get("session"), body=(entry.get("body") or "").rstrip("\n"))
                try:
                    if stream.import_card(conn, card, context=context, links=False,
                                          deleted_at=entry.get("deleted_at") or journaldb.now_text(),
                                          deleted_by=entry.get("by") or "unknown"):
                        counts["deleted cards added"] += 1
                        loaded.append(card)
                except Exception as e:
                    counts["refused"] += 1
                    print(f"REFUSED deleted {cid}: {e}", file=sys.stderr)
            for card in loaded:
                stream.import_links(conn, card)
            for entry in _jsonl(stream.edited_log_path()):
                cid = entry["id"]
                if not conn.execute("SELECT 1 FROM cards WHERE id = ?", (cid,)).fetchone():
                    continue
                if conn.execute(
                        "SELECT 1 FROM card_edits WHERE card_id = ? AND edited_at = ? AND after = ?",
                        (cid, entry.get("edited_at"), entry.get("after") or "")).fetchone():
                    continue
                journaldb.record_edit(conn, cid, entry.get("edited_at") or "", entry.get("by") or "unknown",
                                      entry.get("before") or "", entry.get("after") or "")
                counts["edits added"] += 1
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return counts


def verify(files: dict):
    """Step 5. Returns a list of mismatches (empty = every card arrived)."""
    problems = []
    casts = {e["id"]: e for e in _jsonl(cardstore.deleted_log_path())}
    conn = sqlstore.open_db()
    try:
        rows = {r["id"]: r for r in journaldb.fetch_cards(conn, "1 = 1")}
        prints = dict(conn.execute("SELECT id, fingerprint FROM cards"))
    finally:
        conn.close()
    for cid, card in files.items():
        row = rows.get(cid)
        if row is None:
            problems.append(f"MISSING {cid}: the file has no row")
            continue
        if row["deleted_at"]:
            problems.append(f"HIDDEN {cid}: the file is live but the row is deleted")
        expected_body = card.body.rstrip("\n")
        checks = (("who", card.who, row["who"]), ("time", card.ts, row["said_at"]),
                  ("words", expected_body, row["body"]), ("kind", card.kind, row["kind"]),
                  ("session", card.session, row["session"]), ("refs", list(card.refs), row["refs"]),
                  ("tags", sorted(set(card.tags)), sorted(set(row["tags"]))),
                  ("reply_to", card.reply_to if card.reply_to in rows else None, row["reply_to"]))
        for what, want, got in checks:
            if want != got:
                problems.append(f"DIFFERS {cid}: {what} {want!r} != {got!r}")
        if prints.get(cid) != journaldb.fingerprint(card.who, card.ts, expected_body):
            problems.append(f"FINGERPRINT {cid}: the row's fingerprint doesn't match the file's words")
    for cid, entry in casts.items():
        if cid in files:
            continue
        row = rows.get(cid)
        if row is None:
            problems.append(f"MISSING deleted {cid}: the deletion log's card has no row")
        elif not row["deleted_at"]:
            problems.append(f"ALIVE deleted {cid}: the deletion log's card isn't hidden")
        elif row["body"] != (entry.get("body") or "").rstrip("\n"):
            problems.append(f"DIFFERS deleted {cid}: words don't match the deletion log")
    live = {cid for cid, row in rows.items() if not row["deleted_at"]}
    extra = sorted(live - set(files))
    for cid in extra:
        problems.append(f"EXTRA {cid}: a live row with no file")
    return problems, len(live)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--verify-only", action="store_true", help="check, don't load anything")
    parser.add_argument("--pool", default=None, help="the card folder (default: the vault's)")
    args = parser.parse_args()
    pool = Path(args.pool) if args.pool else cardstore.pool_dir()

    files, unreadable = read_pool(pool)
    print(f"journal_db_migrate: {len(files)} card file(s) in {pool}")
    for problem in unreadable:
        print(problem, file=sys.stderr)
    if not args.verify_only:
        counts = migrate(pool, files)
        print("  " + ", ".join(f"{n} {label}" for label, n in counts.items()))
    problems, live = verify(files)
    print(f"  verified: {len(files)} file(s) against {live} live row(s)")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems or unreadable:
        print(f"FAIL — {len(problems) + len(unreadable)} problem(s)")
        return 1
    print("OK — every card file has a matching row")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), like every
    # standalone script here.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
