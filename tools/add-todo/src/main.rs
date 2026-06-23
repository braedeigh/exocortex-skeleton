//! add-todo — the safe write path into the build queue.
//!
//! Usage:
//!   add-todo --text "fix the × buttons" --theme body
//!   add-todo --text "..." --theme kitchen --source journal
//!
//! It appends ONE entry to build_todos.json, in the same shape as your
//! dev_notes.json / idea_notes.json: {"tabs": {<theme>: [{id, text, created, source?}]}}.
//! It never rewrites or deletes anything — append only.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};

// ── Schema layer #1: the theme is an ENUM, not a free string. ───────────────
// An invalid theme can't even be *constructed* — clap rejects it at the door
// with a helpful error listing the valid options. This is the safety layer the
// Python version would enforce at runtime; here the type system does it for free.
#[derive(Clone, Debug, ValueEnum)]
#[value(rename_all = "lowercase")]
enum Theme {
    Today,
    Kitchen,
    Map,
    Inventory,
    Body,
    Money,
    Movement,
    Personality,
    Global,
}

impl Theme {
    /// The string we actually write into JSON (the tab name).
    fn as_key(&self) -> &'static str {
        match self {
            Theme::Today => "today",
            Theme::Kitchen => "kitchen",
            Theme::Map => "map",
            Theme::Inventory => "inventory",
            Theme::Body => "body",
            Theme::Money => "money",
            Theme::Movement => "movement",
            Theme::Personality => "personality",
            Theme::Global => "global",
        }
    }
}

// ── The CLI surface. clap turns these fields into --flags automatically. ─────
#[derive(Parser)]
#[command(about = "Append one validated task to the build queue (build_todos.json)")]
struct Args {
    /// The task text, e.g. "fix the × buttons on the body tab"
    #[arg(long)]
    text: String,

    /// Which tab/area this belongs to
    #[arg(long, value_enum)]
    theme: Theme,

    /// Optional: where it came from (e.g. "journal", "spark")
    #[arg(long)]
    source: Option<String>,

    /// Override the data dir (defaults to $EXOCORTEX_DATA_DIR). Mostly for testing.
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

// ── The JSON shape, as Rust structs. serde maps these <-> the file. ──────────
#[derive(Serialize, Deserialize, Default)]
struct Queue {
    tabs: BTreeMap<String, Vec<Entry>>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    id: String,
    text: String,
    created: String,
    // skip writing "source": null — only include the key when it's actually set,
    // matching how your other entries omit fields they don't have.
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();

    // Reject empty/whitespace text. (Schema layer: no blank tasks.)
    let text = args.text.trim();
    if text.is_empty() {
        return Err("text is empty — refusing to add a blank task".into());
    }

    // Resolve where the file lives: --data-dir, else $EXOCORTEX_DATA_DIR.
    let data_dir = args
        .data_dir
        .or_else(|| std::env::var_os("EXOCORTEX_DATA_DIR").map(PathBuf::from))
        .ok_or("no data dir: pass --data-dir or set EXOCORTEX_DATA_DIR")?;
    let path = data_dir.join("build_todos.json");

    // Read the existing queue, or start a fresh empty one if the file is new.
    // Append-only: we load everything that's there and only ever push onto it.
    let mut queue: Queue = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Queue::default(),
        Err(e) => return Err(e.into()),
    };

    // Build the new entry: random 8-hex id + local timestamp, like your other files.
    let id = format!("{:08x}", rand::random::<u32>());
    let created = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let entry = Entry {
        id: id.clone(),
        text: text.to_string(),
        created,
        source: args.source,
    };

    queue
        .tabs
        .entry(args.theme.as_key().to_string())
        .or_default()
        .push(entry);

    // ── Atomic write: write a temp file, then rename it over the real one. ───
    // rename() is atomic on a single filesystem, so a crash mid-write can never
    // leave a half-written build_todos.json. This is what store.py does in Python.
    let json = serde_json::to_string_pretty(&queue)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())?;
    fs::rename(&tmp, &path)?;

    println!("added [{}] to {}: {}", id, args.theme.as_key(), text);
    Ok(())
}
