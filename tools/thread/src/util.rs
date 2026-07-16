//! Small shared helpers: dirs, dates, atomic writes, ids — the boring plumbing
//! every command needs, lifted straight from the people/add-todo pattern.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;

/// Resolve the content vault dir: `--content-dir` flag, else `$EXOCORTEX_CONTENT_DIR`.
/// Never invented — refuse loudly if neither is given.
pub fn content_dir(flag: &Option<PathBuf>) -> Result<PathBuf, Box<dyn Error>> {
    flag.clone()
        .or_else(|| std::env::var_os("EXOCORTEX_CONTENT_DIR").map(PathBuf::from))
        .ok_or_else(|| "no content dir: pass --content-dir or set EXOCORTEX_CONTENT_DIR".into())
}

/// Resolve the data dir: `--data-dir` flag, else `$EXOCORTEX_DATA_DIR`.
pub fn data_dir(flag: &Option<PathBuf>) -> Result<PathBuf, Box<dyn Error>> {
    flag.clone()
        .or_else(|| std::env::var_os("EXOCORTEX_DATA_DIR").map(PathBuf::from))
        .ok_or_else(|| "no data dir: pass --data-dir or set EXOCORTEX_DATA_DIR".into())
}

pub fn threads_dir(content: &Path) -> PathBuf {
    content.join("Threads")
}

/// `<content_dir>/people/` — the people tool's domain. `thread` never writes
/// here; it only checks a slug's file exists before letting it into a
/// thread's `people:` cast.
pub fn people_dir(content: &Path) -> PathBuf {
    content.join("people")
}

pub fn cards_dir(content: &Path) -> PathBuf {
    content.join("_system/data/cards")
}

pub fn journal_daily_dir(content: &Path) -> PathBuf {
    content.join("Journal/Daily")
}

pub fn changelog_path(content: &Path) -> PathBuf {
    content.join("_system/cricket_changelog.md")
}

/// Every `Threads/*.md` file's slug (filename stem), sorted.
pub fn list_thread_slugs(threads_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(threads_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .collect();
    out.sort();
    out
}

pub fn thread_path(threads_dir: &Path, slug: &str) -> PathBuf {
    threads_dir.join(format!("{}.md", slug))
}

/// Every `people/*.md` file's slug (filename stem), sorted. Same shape as
/// `list_thread_slugs`, just pointed at the people tool's directory.
pub fn list_people_slugs(people_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(people_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .collect();
    out.sort();
    out
}

pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

pub fn today_str() -> String {
    today().format("%Y-%m-%d").to_string()
}

pub fn now_minute_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

pub fn is_real_date(s: &str) -> bool {
    parse_date(s).is_some()
}

pub fn new_id() -> String {
    format!("{:08x}", rand::random::<u32>())
}

/// Atomic write: temp file + rename. A crash mid-write can never corrupt the file.
pub fn atomic_write(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("tmp")
    ));
    fs::write(&tmp, contents.as_bytes())?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn slug_re() -> regex::Regex {
    regex::Regex::new(r"^[a-z0-9-]{1,40}$").unwrap()
}

pub fn valid_slug(s: &str) -> bool {
    slug_re().is_match(s)
}
