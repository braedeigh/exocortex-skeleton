//! The approval queue + decision log — `data/fronts.json`, `data/pending_changes.json`
//! (locked exactly like `store.mutate` in Flask), and `data/decisions.jsonl`.

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::Path;

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::util::{atomic_write, now_minute_str, today};

#[derive(Serialize, Deserialize, Default)]
pub struct Pending {
    pub pending: Vec<PendingChange>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PendingChange {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub payload: serde_json::Value,
    pub created: String,
}

#[derive(Deserialize)]
struct Front {
    id: String,
}

#[derive(Deserialize)]
struct FrontsFile {
    fronts: Vec<Front>,
}

pub fn load_fronts(data_dir: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let path = data_dir.join("fronts.json");
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("can't read {}: {}", path.display(), e))?;
    let f: FrontsFile = serde_json::from_str(&text)
        .map_err(|e| format!("{} isn't valid fronts.json: {}", path.display(), e))?;
    Ok(f.fronts.into_iter().map(|f| f.id).collect())
}

pub fn load_pending(data_dir: &Path) -> Result<Pending, Box<dyn Error>> {
    let path = data_dir.join("pending_changes.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Pending::default()),
        Err(e) => Err(e.into()),
    }
}

/// Append one entry to `pending_changes.json` while holding an exclusive
/// flock on the sibling `.lock` file — the SAME lock `store.mutate` takes in
/// Flask, so Rust and Python can never interleave a read-modify-write.
pub fn append_pending_locked(data_dir: &Path, entry: PendingChange) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join("pending_changes.json");
    let lock_path = data_dir.join("pending_changes.json.lock");
    let lock_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)?;
    lock_file.lock_exclusive()?;

    let mut pending = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Pending>(&s)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Pending::default(),
        Err(e) => return Err(e.into()),
    };
    pending.pending.push(entry);
    let json = serde_json::to_string_pretty(&pending)?;
    atomic_write(&path, &json)?;

    // Explicit unlock (also happens on drop, but be tidy about it).
    fs2::FileExt::unlock(&lock_file)?;
    Ok(())
}

#[derive(Deserialize)]
struct DecisionLine {
    ts: String,
    action: String,
    kind: String,
    proposed: serde_json::Value,
}

/// Every deny for `kind`/`slug` (proposed.slug == slug), most recent first.
pub fn recent_denials(
    data_dir: &Path,
    kind: &str,
    slug: &str,
) -> Result<Vec<chrono::NaiveDateTime>, Box<dyn Error>> {
    let path = data_dir.join("decisions.jsonl");
    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let d: DecisionLine = match serde_json::from_str(line) {
            Ok(d) => d,
            Err(_) => continue, // a malformed line shouldn't crash check-slug
        };
        if d.action != "deny" || d.kind != kind {
            continue;
        }
        let proposed_slug = d.proposed.get("slug").and_then(|v| v.as_str());
        if proposed_slug != Some(slug) {
            continue;
        }
        if let Ok(ts) = chrono::NaiveDateTime::parse_from_str(&d.ts, "%Y-%m-%d %H:%M:%S") {
            out.push(ts);
        }
    }
    out.sort();
    out.reverse();
    Ok(out)
}

/// `exists | pending | denied:<date> | free`, precedence exists > pending >
/// denied > free. A denial counts only within the last 30 days.
pub fn check_slug(
    content_dir: &Path,
    data_dir: &Path,
    slug: &str,
) -> Result<String, Box<dyn Error>> {
    let thread_path = crate::util::thread_path(&crate::util::threads_dir(content_dir), slug);
    if thread_path.exists() {
        return Ok("exists".to_string());
    }

    let pending = load_pending(data_dir)?;
    let is_pending = pending.pending.iter().any(|p| {
        p.kind == "thread_open" && p.payload.get("slug").and_then(|v| v.as_str()) == Some(slug)
    });
    if is_pending {
        return Ok("pending".to_string());
    }

    let denials = recent_denials(data_dir, "thread_open", slug)?;
    let cutoff = today() - chrono::Duration::days(30);
    if let Some(most_recent) = denials.first() {
        if most_recent.date() >= cutoff {
            return Ok(format!("denied:{}", most_recent.date().format("%Y-%m-%d")));
        }
    }

    Ok("free".to_string())
}

/// Append one `{id, kind, summary, payload, created}` proposal.
pub fn propose(
    data_dir: &Path,
    kind: &str,
    summary: String,
    payload: serde_json::Value,
) -> Result<String, Box<dyn Error>> {
    let id = crate::util::new_id();
    let entry = PendingChange {
        id: id.clone(),
        kind: kind.to_string(),
        summary,
        payload,
        created: now_minute_str(),
    };
    append_pending_locked(data_dir, entry)?;
    Ok(id)
}

/// Append one line to `decisions.jsonl` — not part of the CLI surface today
/// (Flask owns approve/deny), kept here for test fixtures / future use.
#[allow(dead_code)]
pub fn append_decision(data_dir: &Path, line: &str) -> Result<(), Box<dyn Error>> {
    let path = data_dir.join("decisions.jsonl");
    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{}", line)?;
    Ok(())
}
