//! The journal's cards, read out of exo.db — this tool's only window onto them.
//!
//! **What this does, in plain English.** Since 2026-11-16 a journal card is a
//! row in exo.db (`cards`), and which threads/people it belongs to are rows in
//! `card_labels` + `labels` (see the skeleton's `docs/journal-database.md`).
//! This tool used to read the card FILES; it now asks the database three
//! things: does this card exist, does this day have any card, and which cards
//! wear a thread's label. Read-only — the connection is opened so SQLite
//! itself refuses writes. Only live rows count: a deleted card (`deleted_at`
//! set) or a label taken off (`removed_at` set) is treated as absent.
//!
//! The database is `<data-dir>/exo.db`, recorded once by `use_data_dir` when
//! a command resolves its folders (main.rs `dirs`). A missing or unreadable
//! database reads as "no such card", so a check fails loudly rather than
//! passing on nothing.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Record where exo.db is: `<data_dir>/exo.db`. The first call wins.
pub fn use_data_dir(data_dir: &Path) {
    let _ = DB_PATH.set(data_dir.join("exo.db"));
}

/// Where exo.db is, for error messages.
pub fn db_path() -> PathBuf {
    DB_PATH.get().cloned().unwrap_or_else(|| PathBuf::from("<data-dir>/exo.db"))
}

/// A read-only connection, or None when there's no database to read.
fn open() -> Option<Connection> {
    let path = DB_PATH.get()?;
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)
        .ok()
}

/// True when a live card with this id exists.
pub fn card_exists(card_id: &str) -> bool {
    let Some(conn) = open() else { return false };
    conn.query_row(
        "SELECT 1 FROM cards WHERE id = ?1 AND deleted_at IS NULL",
        [card_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// True when the journal day `day` (YYYY-MM-DD) holds at least one live card.
pub fn day_has_card(day: &str) -> bool {
    let Some(conn) = open() else { return false };
    conn.query_row(
        "SELECT 1 FROM cards WHERE day = ?1 AND deleted_at IS NULL LIMIT 1",
        [day],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Every live card wearing the label `slug`, as (id, body), by id.
pub fn cards_labelled(slug: &str) -> Vec<(String, String)> {
    let Some(conn) = open() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare(
        "SELECT c.id, c.body FROM cards c
           JOIN card_labels cl ON cl.card_id = c.id AND cl.removed_at IS NULL
           JOIN labels l ON l.id = cl.label_id
          WHERE l.slug = ?1 AND c.deleted_at IS NULL
          ORDER BY c.id",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([slug], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
    match rows {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}
