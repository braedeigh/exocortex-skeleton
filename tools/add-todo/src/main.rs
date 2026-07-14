//! add-todo — the safe, validated write path into Bradie's to-do lists.
//!
//! Two lists, two subcommands:
//!   add-todo build --text "fix × buttons" --theme body     # dev build queue (build_todos.json)
//!   add-todo life  --text "get a haircut" --bucket now --category appearance
//!                                                            # life to-do list (todos.json — the Today tab)
//!
//! Add --stage to either to drop it into the approval queue (pending_changes.json)
//! instead of committing — the dashboard modal then approves or denies it. The
//! model only ever fills these slots; this code does the actual write.

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};

#[derive(Parser)]
#[command(about = "Add a validated to-do to the build queue or your life list")]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Add to the dev BUILD queue (build_todos.json), themed by app tab.
    Build(BuildArgs),
    /// Add to your LIFE to-do list (todos.json) — the visible Today tab.
    Life(LifeArgs),
}

// ── BUILD queue args ─────────────────────────────────────────────────────────
#[derive(Args)]
struct BuildArgs {
    /// The task text
    #[arg(long)]
    text: String,
    /// Which app tab it belongs to
    #[arg(long, value_enum)]
    theme: Theme,
    /// Optional: where it came from
    #[arg(long)]
    source: Option<String>,
    /// Stage for approval instead of committing
    #[arg(long)]
    stage: bool,
    /// Override data dir (defaults to $EXOCORTEX_DATA_DIR)
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

// ── LIFE list args ───────────────────────────────────────────────────────────
#[derive(Args)]
struct LifeArgs {
    /// The task text, e.g. "get a haircut" (required to add; used as a label when removing)
    #[arg(long)]
    text: Option<String>,
    /// Which priority bucket on the ladder
    #[arg(long, value_enum, default_value = "now")]
    bucket: Bucket,
    /// Front tag (life-domain, ids from fronts.json); omit to leave untagged
    #[arg(long, value_enum)]
    category: Option<Category>,
    /// Remove an existing item instead of adding one (needs --id)
    #[arg(long)]
    remove: bool,
    /// The id of the item to remove (with --remove)
    #[arg(long)]
    id: Option<String>,
    /// Stage for approval instead of committing
    #[arg(long)]
    stage: bool,
    /// Override data dir (defaults to $EXOCORTEX_DATA_DIR)
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

// ── Enums = the schema. Invalid values can't be constructed; clap rejects them. ─
#[derive(Clone, ValueEnum)]
#[value(rename_all = "lowercase")]
enum Theme {
    Today, Kitchen, Map, Inventory, Body, Money, Movement, Personality, Global,
}
impl Theme {
    fn as_key(&self) -> &'static str {
        match self {
            Theme::Today => "today", Theme::Kitchen => "kitchen", Theme::Map => "map",
            Theme::Inventory => "inventory", Theme::Body => "body", Theme::Money => "money",
            Theme::Movement => "movement", Theme::Personality => "personality", Theme::Global => "global",
        }
    }
}

#[derive(Clone, ValueEnum)]
#[value(rename_all = "snake_case")] // snake_case so the CLI value == the JSON key (e.g. up_next)
enum Bucket { Now, UpNext, Later, Someday }
impl Bucket {
    fn as_key(&self) -> &'static str {
        match self {
            Bucket::Now => "now", Bucket::UpNext => "up_next",
            Bucket::Later => "later", Bucket::Someday => "someday",
        }
    }
}

// The fronts vocabulary (fronts.json). CLI value == front id, so kebab-case
// (living-space). Stored on the to-do as its `theme` field.
#[derive(Clone, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum Category {
    Health, Appearance, Finances, LivingSpace,
    Job, Hobbies, Learning, Exocortex,
    Practice, Connection, Errands, SelfBecoming,
}
impl Category {
    fn as_key(&self) -> &'static str {
        match self {
            Category::Health => "health", Category::Appearance => "appearance",
            Category::Finances => "finances", Category::LivingSpace => "living-space",
            Category::Job => "job", Category::Hobbies => "hobbies",
            Category::Learning => "learning", Category::Exocortex => "exocortex",
            Category::Practice => "practice", Category::Connection => "connection",
            Category::Errands => "errands", Category::SelfBecoming => "self-becoming",
        }
    }
}

// ── Build-queue JSON: {"tabs": {<theme>: [Entry]}} ───────────────────────────
#[derive(Serialize, Deserialize, Default)]
struct Queue {
    tabs: BTreeMap<String, Vec<Entry>>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    id: String,
    text: String,
    created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

// ── Approval queue (pending_changes.json). Generic kind/summary/payload so the
// same modal gates any change type — today "todo" and "life_todo". ───────────
#[derive(Serialize, Deserialize, Default)]
struct Pending {
    pending: Vec<PendingChange>,
}
#[derive(Serialize, Deserialize)]
struct PendingChange {
    id: String,
    kind: String,
    summary: String,
    payload: serde_json::Value,
    created: String,
}

fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().cmd {
        Command::Build(a) => run_build(a),
        Command::Life(a) => run_life(a),
    }
}

fn run_build(args: BuildArgs) -> Result<(), Box<dyn Error>> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err("text is empty — refusing to add a blank task".into());
    }
    let data_dir = resolve_data_dir(args.data_dir)?;
    let id = new_id();
    let theme = args.theme.as_key();
    let now = stamp_minute();

    if args.stage {
        let path = data_dir.join("pending_changes.json");
        let mut q: Pending = load_or_default(&path)?;
        q.pending.push(PendingChange {
            id: id.clone(),
            kind: "todo".into(),
            summary: format!("Add to build queue: \"{}\" → {}", text, theme),
            payload: serde_json::json!({ "text": text, "theme": theme, "source": args.source }),
            created: now,
        });
        atomic_write(&path, &q)?;
        println!("staged [{}] for approval: {} → {}", id, text, theme);
    } else {
        let path = data_dir.join("build_todos.json");
        let mut q: Queue = load_or_default(&path)?;
        q.tabs.entry(theme.to_string()).or_default().push(Entry {
            id: id.clone(),
            text: text.into(),
            created: now,
            source: args.source,
        });
        atomic_write(&path, &q)?;
        println!("added [{}] to {}: {}", id, theme, text);
    }
    Ok(())
}

fn run_life(args: LifeArgs) -> Result<(), Box<dyn Error>> {
    let data_dir = resolve_data_dir(args.data_dir)?;

    // ── REMOVE mode: stage or commit a deletion by id. ──────────────────────
    if args.remove {
        let target = args.id.ok_or("removal requires --id")?;
        let label = args
            .text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&target)
            .to_string();

        if args.stage {
            let path = data_dir.join("pending_changes.json");
            let mut q: Pending = load_or_default(&path)?;
            q.pending.push(PendingChange {
                id: new_id(),
                kind: "life_remove".into(),
                summary: format!("Remove from to-do list: \"{}\"", label),
                payload: serde_json::json!({ "id": target, "text": label }),
                created: stamp_minute(),
            });
            atomic_write(&path, &q)?;
            println!("staged removal of [{}] for approval", target);
        } else {
            let path = data_dir.join("todos.json");
            let mut root: serde_json::Value = match fs::read_to_string(&path) {
                Ok(s) => serde_json::from_str(&s)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
                Err(e) => return Err(e.into()),
            };
            // Drop the item from whichever bucket holds it, leaving everything else intact.
            let mut removed = 0usize;
            if let Some(obj) = root.as_object_mut() {
                for (_bucket, val) in obj.iter_mut() {
                    if let Some(items) = val.get_mut("items").and_then(|v| v.as_array_mut()) {
                        let before = items.len();
                        items.retain(|it| it.get("id").and_then(|v| v.as_str()) != Some(target.as_str()));
                        removed += before - items.len();
                    }
                }
            }
            atomic_write(&path, &root)?;
            println!("removed {} item(s) with id {}", removed, target);
        }
        return Ok(());
    }

    // ── ADD mode (default). ─────────────────────────────────────────────────
    let text = args.text.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return Err("text is empty — refusing to add a blank task".into());
    }
    let id = new_id();
    let bucket = args.bucket.as_key();
    let category = args.category.as_ref().map(|c| c.as_key());

    if args.stage {
        let path = data_dir.join("pending_changes.json");
        let mut q: Pending = load_or_default(&path)?;
        q.pending.push(PendingChange {
            id: id.clone(),
            kind: "life_todo".into(),
            summary: format!("Add to to-do list: \"{}\" → {}", text, bucket),
            payload: serde_json::json!({ "text": text, "bucket": bucket, "category": category }),
            created: stamp_minute(),
        });
        atomic_write(&path, &q)?;
        println!("staged [{}] for approval: {} → to-do/{}", id, text, bucket);
    } else {
        // todos.json is owned by the Python todos route and has a richer schema, so
        // read it as a free-form Value and only push our entry — every other bucket,
        // field, and ordering it maintains is preserved untouched.
        let path = data_dir.join("todos.json");
        let mut root: serde_json::Value = match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(e) => return Err(e.into()),
        };
        let mut entry = serde_json::json!({
            "id": id,
            "text": text,
            "done": false,
            "created": stamp_day(),     // life todos use a date-only stamp, like the others
        });
        if let Some(front) = category {
            entry["theme"] = serde_json::json!(front); // absent = untagged, like the app
        }
        let obj = root.as_object_mut().ok_or("todos.json is not a JSON object")?;
        let bucket_val = obj
            .entry(bucket.to_string())
            .or_insert_with(|| serde_json::json!({ "items": [] }));
        match bucket_val.get_mut("items").and_then(|v| v.as_array_mut()) {
            Some(arr) => arr.push(entry),
            None => {
                bucket_val
                    .as_object_mut()
                    .ok_or("todos bucket is not an object")?
                    .insert("items".into(), serde_json::json!([entry]));
            }
        }
        atomic_write(&path, &root)?;
        println!("added [{}] to to-do/{}: {}", id, bucket, text);
    }
    Ok(())
}

// ── Small shared helpers ─────────────────────────────────────────────────────
fn new_id() -> String {
    format!("{:08x}", rand::random::<u32>())
}
fn stamp_minute() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}
fn stamp_day() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn resolve_data_dir(opt: Option<PathBuf>) -> Result<PathBuf, Box<dyn Error>> {
    opt.or_else(|| std::env::var_os("EXOCORTEX_DATA_DIR").map(PathBuf::from))
        .ok_or_else(|| "no data dir: pass --data-dir or set EXOCORTEX_DATA_DIR".into())
}

/// Read a JSON file into `T`, or `T::default()` if it doesn't exist yet. Append-only.
fn load_or_default<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, Box<dyn Error>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

/// Atomic write: temp file + rename. A crash mid-write can never corrupt the file.
fn atomic_write<T: Serialize>(path: &Path, value: &T) -> Result<(), Box<dyn Error>> {
    let json = serde_json::to_string_pretty(value)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())?;
    fs::rename(&tmp, path)?;
    Ok(())
}
