"""The journal card pool as real rows — the fourth typed entity in exo.db.

**What this is.** The journal lives as one markdown file per utterance in the
vault (`CONTENT_DIR/_system/data/cards/*.md` — see tools/stream/stream.py,
which owns that pool). Those files are the single source of truth and nothing
here ever writes to them. This module walks the pool into two tables —
`cards` and `card_tags` (schema in sqlstore.py, v6 rung) — so the journal
becomes queryable in the SQL console: cards by day, by tag, by speaker, by
what-replies-to-what. Same contract as codestore.py: git stays truth for
commits, the files stay truth for cards, the tables are a one-way mirror.

**The mirror is also the alarm.** The pool's standing promise is that a turn
can be late but never lost — and on 2026-08-02 a card silently vanished,
which nothing detected. So this mirror keeps a row for every card it has
EVER seen, and on each sync checks presence three ways:

  - file exists            -> row alive, `last_seen` bumped
  - file gone, id found in the pool's deletion cast
    (`_system/data/deleted_cards.jsonl`, written by stream.py's delete verb)
                           -> `deleted_at` set from the cast; a cut the owner
                              asked for, nothing wrong
  - file gone, NO cast     -> `missing_since` set. That is silent loss, the
                              exact failure the pool promises can't happen.
                              The row stays forever so it can't be un-noticed,
                              and sync() returns the ids so callers can shout.

Cast entries also get rows of their own (body preserved), so deleted cards
remain queryable and a rebuild doesn't forget legitimate deletions.

  - `sync()`    — upsert the whole pool + run the presence check. The pool is
                  ~1k tiny files; a full walk is well under a second, so no
                  incremental variant is needed (sync_sessions' reasoning).
  - `rebuild()` — wipe both tables and sync fresh. Schema-repair button only:
                  it forgets `missing_since` incidents (they exist nowhere
                  but these rows), which sync() never does.

Touches: `sqlstore.py` (owns the schema + connection), `store.py`
(CONTENT_DIR is where the vault is), `routes/sqlab.py` (rebuild button),
`scripts/update_cards.py` (hourly cron wrapper, the thing that shouts).

Prompt that produced this file: "I want to turn them [the journal cards] into
SQL as well with tags and date and stuff" + make silent card loss loud.
"""
import json
import re
from datetime import datetime
from pathlib import Path

import sqlstore
import store

# date.HHMM + b/k + optional counter — the only shape stream.py mints.
_CARD_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{4}[bk]\d*$")


def pool_dir() -> Path:
    # Resolved at call time so tests that monkeypatch store.CONTENT_DIR get
    # an isolated pool, same rule as sqlstore._db_path.
    return store.CONTENT_DIR / "_system" / "data" / "cards"


def deleted_log_path() -> Path:
    return store.CONTENT_DIR / "_system" / "data" / "deleted_cards.jsonl"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _parse_list(raw):
    """`[a, b]` -> ['a', 'b']. stream.py writes lists in exactly this shape."""
    inner = raw.strip()[1:-1].strip()
    if not inner:
        return []
    return [p.strip() for p in inner.split(",") if p.strip()]


def _parse_card(path: Path):
    """One pool file -> a flat dict, or None if it isn't a card.

    Deliberately tiny, like entities._parse_frontmatter: the pool's writer is
    stream.py and its output is rigid (scalars, `null`, `[a, b]` lists), so a
    YAML library would be armor against a shape that can't occur. A file
    whose name or frontmatter doesn't match the card shape is skipped, never
    guessed at.
    """
    name = path.stem
    if not _CARD_ID_RE.match(name):
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return None
    meta = {}
    for line in lines[1:end]:
        if ":" not in line:
            continue
        key, _, raw = line.partition(":")
        raw = raw.strip()
        if raw == "null" or raw == "":
            val = None
        elif raw.startswith("["):
            val = _parse_list(raw)
        else:
            val = raw
        meta[key.strip()] = val
    body = "\n".join(lines[end + 1:]).strip("\n")
    return {
        "id": name,
        "day": name.split(".")[0],
        "ts": meta.get("ts"),
        "who": meta.get("who") or "B",
        "kind": meta.get("kind"),
        "reply_to": meta.get("reply_to"),
        "session": meta.get("session"),
        "refs": json.dumps(meta.get("refs") or []),
        "tags": meta.get("tags") or [],
        "body": body,
    }


def _load_casts():
    """The deletion log as {card_id: cast entry}. Missing file = no casts yet
    (the log only exists once something has been deleted)."""
    path = deleted_log_path()
    if not path.exists():
        return {}
    casts = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # a shredded line loses one cast, never the sync
        if entry.get("id"):
            casts[entry["id"]] = entry
    return casts


def _upsert(conn, card, now):
    conn.execute(
        "INSERT INTO cards (id, day, ts, who, kind, reply_to, session, refs,"
        " body, first_seen, last_seen, deleted_at, missing_since)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)"
        " ON CONFLICT(id) DO UPDATE SET"
        # Content can change (the edit verb, tag sweeps) — mirror it all.
        "  day=excluded.day, ts=excluded.ts, who=excluded.who,"
        "  kind=excluded.kind, reply_to=excluded.reply_to,"
        "  session=excluded.session, refs=excluded.refs, body=excluded.body,"
        "  last_seen=excluded.last_seen,"
        # A file that's back on disk is alive, whatever we thought before.
        "  deleted_at=NULL, missing_since=NULL",
        (card["id"], card["day"], card["ts"], card["who"], card["kind"],
         card["reply_to"], card["session"], card["refs"], card["body"],
         now, now),
    )
    conn.execute("DELETE FROM card_tags WHERE card_id = ?", (card["id"],))
    conn.executemany(
        "INSERT OR IGNORE INTO card_tags (card_id, tag) VALUES (?, ?)",
        [(card["id"], t) for t in card["tags"]],
    )


def sync():
    """Walk the pool into the tables and run the presence check.

    Returns {"cards", "new", "deleted", "missing"} — `missing` is the list of
    ids that vanished with no cast. An empty list is the healthy answer;
    anything else is an integrity incident the caller should make loud.
    """
    conn = sqlstore.open_db()
    now = _now()
    try:
        sqlstore.begin_immediate(conn)
        known = {r[0] for r in conn.execute("SELECT id FROM cards")}
        seen = set()
        for path in sorted(pool_dir().glob("*.md")):
            card = _parse_card(path)
            if card is None:
                continue
            seen.add(card["id"])
            _upsert(conn, card, now)

        casts = _load_casts()
        # Cast entries become rows too (body preserved from the cast), so a
        # deleted card is still queryable and survives rebuild(). INSERT OR
        # IGNORE: if the row already exists the branch below explains it.
        for cid, entry in casts.items():
            if cid in seen or not _CARD_ID_RE.match(cid):
                continue
            conn.execute(
                "INSERT OR IGNORE INTO cards (id, day, ts, who, kind, reply_to,"
                " session, refs, body, first_seen, last_seen, deleted_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cid, cid.split(".")[0], entry.get("ts"),
                 entry.get("who") or "B", entry.get("kind"),
                 entry.get("reply_to"), entry.get("session"),
                 json.dumps(entry.get("refs") or []), entry.get("body") or "",
                 now, now, entry.get("deleted_at") or now),
            )

        # The presence check: every row that WAS alive but has no file now is
        # either explained by a cast or an incident.
        unexplained = []
        deleted = 0
        gone = [r[0] for r in conn.execute(
            "SELECT id FROM cards WHERE deleted_at IS NULL"
            " AND missing_since IS NULL"
        ) if r[0] not in seen]
        for cid in gone:
            if cid in casts:
                conn.execute(
                    "UPDATE cards SET deleted_at = ? WHERE id = ?",
                    (casts[cid].get("deleted_at") or now, cid),
                )
                deleted += 1
            else:
                conn.execute(
                    "UPDATE cards SET missing_since = ? WHERE id = ?",
                    (now, cid),
                )
                unexplained.append(cid)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return {
        "cards": len(seen),
        "new": len(seen - known),
        "deleted": deleted,
        "missing": sorted(unexplained),
    }


def sync_one(cid: str):
    """Refresh a single card's row right now — the instant echo under the
    hourly sync. The card routes call this after every mutation so a tag,
    edit, add, or delete is queryable the moment it lands instead of at :12.
    Constant-time: parses one file, never walks the pool.

    A file that's gone is only marked deleted here when the deletion cast
    explains it (which it always does for a route delete — the cast is
    written before the unlink). Flagging UNexplained absences stays the
    hourly sync's job; it has the full-pool view this doesn't."""
    if not _CARD_ID_RE.match(cid):
        return
    conn = sqlstore.open_db()
    now = _now()
    try:
        sqlstore.begin_immediate(conn)
        path = pool_dir() / f"{cid}.md"
        card = _parse_card(path) if path.exists() else None
        if card is not None:
            _upsert(conn, card, now)
        else:
            entry = _load_casts().get(cid)
            if entry is not None:
                conn.execute(
                    "UPDATE cards SET deleted_at = ? WHERE id = ?"
                    " AND deleted_at IS NULL",
                    (entry.get("deleted_at") or now, cid),
                )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def rebuild():
    """Wipe and re-derive. Self-repair only — sync() is the daily driver.
    Forgets missing_since incidents (they live nowhere but these rows);
    deleted cards survive because the cast log is re-read."""
    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        conn.execute("DELETE FROM card_tags")
        conn.execute("DELETE FROM cards")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return sync()


def integrity():
    """The standing question — 'is anything missing?' — as one cheap read.
    Returns rows currently marked missing_since, oldest first."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT id, missing_since FROM cards"
            " WHERE missing_since IS NOT NULL ORDER BY missing_since"
        ).fetchall()
    finally:
        conn.close()
    return [{"id": r[0], "missing_since": r[1]} for r in rows]
