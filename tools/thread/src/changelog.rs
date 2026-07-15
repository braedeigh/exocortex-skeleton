//! Every WRITE lands here — the same grouped-by-day changelog mechanism as
//! the people tool (`log_change` near line 488 of tools/people/src/main.rs),
//! copied verbatim in spirit: a `## YYYY-MM-DD` day header when the day
//! changes, then `- HH:MM · <verb> · **<slug>** — <detail>`.

use std::error::Error;
use std::fs;
use std::path::Path;

use crate::util::{atomic_write, changelog_path};

pub fn log_change(content_root: &Path, verb: &str, slug: &str, detail: &str) -> Result<(), Box<dyn Error>> {
    let path = changelog_path(content_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let now = chrono::Local::now().format("%H:%M").to_string();

    let mut existing = fs::read_to_string(&path).unwrap_or_else(|_| {
        "# Cricket Changelog\n\nEvery automated write to `tulku/Threads/` (and `tulku/people/`) \
goes through a validated tool, which records it here — newest at the bottom, grouped by day. \
This is your window into what the nightly crickets did to your vault: skim it, trust it, or \
catch a bad write early. Nothing here is authored by hand.\n"
            .to_string()
    });
    if !existing.ends_with('\n') {
        existing.push('\n');
    }

    let day_header = format!("## {}", today);
    if !existing.contains(&day_header) {
        existing.push('\n');
        existing.push_str(&day_header);
        existing.push('\n');
    }
    existing.push_str(&format!("- {} \u{b7} {} \u{b7} **{}** — {}\n", now, verb, slug, detail));

    atomic_write(&path, &existing)?;
    Ok(())
}
