"""Put a journal card straight into a test database — through the same table
code the journal engine uses (tools/stream/journaldb.py), so a test that seeds
cards by hand can't drift from the real schema.

Tests that read cards out of exo.db (the boot package, mention context,
person cards) use this instead of writing raw INSERTs against the table.
"""
from tools.stream import stream

journaldb = stream.journaldb


def seed_card(conn, card_id, body, who="B", kind="line", tags=(), deleted_at=None, by="test",
              said_at=None, saved_at=None, reply_to=None, weights=None):
    """One card with the id's own time (`2026-09-18.1746b` -> 17:46), saved at
    that time (so it's past its 24 hours, like any old card), with `tags` as
    labels. `said_at` / `saved_at` override the two clocks; `reply_to` links
    it as an answer to an earlier card; `weights` is {tag: 'about'|'touches'}."""
    said_at = said_at or f"{card_id[:10]} {card_id[11:13]}:{card_id[13:15]}:00"
    journaldb.insert_card(conn, id=card_id, who=who, said_at=said_at, body=body, kind=kind,
                          saved_at=saved_at or said_at, deleted_at=deleted_at,
                          deleted_by="test" if deleted_at else None)
    context = journaldb.LabelContext(None, None)
    for tag in tags:
        journaldb.add_label(conn, card_id, tag, by, context,
                            weight=(weights or {}).get(tag))
    if reply_to:
        journaldb.link(conn, card_id, reply_to, "answers", by=by, linked_at=said_at)


def seed_card_files(conn, folder):
    """Every old-style card file in `folder` (`<id>.md`, frontmatter + body)
    as a row — for test fixtures that are still kept as card files. Parents
    go in before the cards that answer them."""
    from pathlib import Path

    cards = [stream.parse_card_file(path) for path in sorted(Path(folder).glob("*.md"))]
    for card in cards:
        seed_card(conn, card.id, card.body, who=card.who, kind=card.kind, tags=card.tags,
                  said_at=card.ts)
    for card in cards:
        if card.reply_to:
            journaldb.link(conn, card.id, card.reply_to, "answers", by="test", linked_at=card.ts)
