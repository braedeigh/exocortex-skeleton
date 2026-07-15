//! Source-token classification and existence checks — byte-for-byte the same
//! three kinds `_classify_source` in routes/threads.py recognizes, plus the
//! filesystem checks that turn "well-formed" into "actually resolvable".

use std::path::Path;

use regex::Regex;

pub fn card_id_re() -> Regex {
    Regex::new(r"^\d{4}-\d{2}-\d{2}\.\w+$").unwrap()
}

pub fn day_re() -> Regex {
    Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap()
}

/// Backtick-wrapped tokens on a line, e.g. "`2026-07-08.1841b`".
pub fn token_re() -> Regex {
    Regex::new(r"`([^`]+)`").unwrap()
}

/// The "→"/"·" source markers (mirrors routes/threads.py's `_ARROW`). Not
/// consumed directly by the line-classifier (which only needs to detect a
/// line-*leading* arrow, not the mid-line "·" separator) — kept for parity
/// with the Python grammar and available to callers that need it.
#[allow(dead_code)]
pub fn arrow_re() -> Regex {
    Regex::new(r"\s*[\x{2192}\x{00b7}]\s*").unwrap()
}

pub fn wikilink_re() -> Regex {
    Regex::new(r"\[\[([^\]]+)\]\]").unwrap()
}

/// Extract every backtick token from a line, in order.
pub fn extract_tokens(line: &str) -> Vec<String> {
    token_re()
        .captures_iter(line)
        .map(|c| c[1].to_string())
        .collect()
}

pub fn extract_wikilinks(text: &str) -> Vec<String> {
    wikilink_re()
        .captures_iter(text)
        .map(|c| c[1].trim().to_lowercase())
        .collect()
}

/// Classify + resolve one source token against the vault on disk.
/// `Ok(())` = resolvable. `Err(msg)` = loud, specific, says what's wrong.
pub fn check_source(token: &str, content_dir: &Path) -> Result<(), String> {
    let tok = token.trim();
    if tok.is_empty() {
        return Err("empty source token".to_string());
    }

    if card_id_re().is_match(tok) {
        let p = content_dir.join("_system/data/cards").join(format!("{}.md", tok));
        if p.exists() {
            return Ok(());
        }
        return Err(format!(
            "card id `{}` not found in the card pool ({})",
            tok,
            p.display()
        ));
    }

    if day_re().is_match(tok) {
        let day_file = crate::util::journal_daily_dir(content_dir).join(format!("{}.md", tok));
        if day_file.exists() {
            return Ok(());
        }
        let cards_dir = content_dir.join("_system/data/cards");
        let prefix = format!("{}.", tok);
        let has_card = std::fs::read_dir(&cards_dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(&prefix));
        if has_card {
            return Ok(());
        }
        return Err(format!(
            "bare day `{}` has no Journal/Daily file and no card in the pool starting `{}`",
            tok, prefix
        ));
    }

    if tok.ends_with(".md") {
        let stripped = tok.strip_prefix("tulku/").unwrap_or(tok);
        if stripped == "THREADS.md" {
            return Err(format!(
                "`{}` — frozen casefile — chase to a primary card id",
                tok
            ));
        }
        let p1 = content_dir.join(stripped);
        if p1.exists() {
            return Ok(());
        }
        if let Some(parent) = content_dir.parent() {
            let p2 = parent.join(stripped);
            if p2.exists() {
                return Ok(());
            }
            return Err(format!(
                "`.md` source `{}` not found at {} or {}",
                tok,
                p1.display(),
                p2.display()
            ));
        }
        return Err(format!("`.md` source `{}` not found at {}", tok, p1.display()));
    }

    Err(format!(
        "unrecognized source token `{}` (not a card id, bare day, or .md path)",
        tok
    ))
}

/// The date a source token contributes for "most recent dated source" purposes
/// (used by `--fix-dormancy`). `None` for sources that don't carry a date
/// (.md paths).
pub fn source_date(token: &str) -> Option<chrono::NaiveDate> {
    let tok = token.trim();
    if card_id_re().is_match(tok) {
        let day = tok.split('.').next().unwrap_or("");
        return crate::util::parse_date(day);
    }
    if day_re().is_match(tok) {
        return crate::util::parse_date(tok);
    }
    None
}
