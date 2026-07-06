//! people — the safe, validated write path into Bradie's `tulku/people/` files,
//! and the validator that keeps the "markdown is the database" contract honest.
//!
//! The people cricket used to edit `tulku/people/*.md` directly with a text editor.
//! Now it goes through this one narrow door, exactly like add-todo does for the
//! build queue:
//!
//!   people add-ref    --person sally --date 2026-07-04 --note "text at brunch"
//!   people add-alias  --person sally --alias "my landlord"
//!   people new-person --name "Priya" --blurb "new coworker at DSHS" \
//!                     --date 2026-07-04 --note "she introduced herself" --alias coworker
//!   people validate
//!
//! WHY this exists (the architecture review's two soft spots, closed):
//!   1. The people-file format was a *convention* — if a writer produced a slightly
//!      off reference line, routes/entities.py silently dropped it and the data just
//!      vanished. `validate` turns that convention into a *contract*: it reads every
//!      file and reports any line the database would drop, loudly, exit-nonzero.
//!   2. LLM crickets write to the source of truth unattended. Every write through
//!      this door is appended to `_system/cricket_changelog.md`, so you can see
//!      exactly what the crickets did to your vault each night.
//!
//! The model only ever fills the slots (--person, --date, --note); this code does
//! the actual write, in the one canonical shape the parser understands.

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand};
use regex::Regex;

#[derive(Parser)]
#[command(about = "Validated writes + a validator for the tulku/people/ vault")]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check every people/*.md against the format the database parses. Exit 1 on errors.
    Validate(ValidateArgs),
    /// Append a dated `- [[DATE]] (note)` line under a person's `## Referenced In`.
    AddRef(AddRefArgs),
    /// Add a role/nickname to a person's `aliases:` frontmatter list.
    AddAlias(AddAliasArgs),
    /// Create a new `people/<slug>.md` stub with well-formed frontmatter + first ref.
    NewPerson(NewPersonArgs),
}

// ── Shared: where the vault lives ────────────────────────────────────────────
#[derive(Args)]
struct ContentDir {
    /// Override the vault dir (defaults to $EXOCORTEX_CONTENT_DIR, e.g. .../personal/tulku)
    #[arg(long, global = true)]
    content_dir: Option<PathBuf>,
}

#[derive(Args)]
struct ValidateArgs {
    #[command(flatten)]
    content: ContentDir,
    /// Only print files that have problems (skip the clean ones).
    #[arg(long)]
    quiet: bool,
}

#[derive(Args)]
struct AddRefArgs {
    /// Who — a slug, first name, or existing alias ("sally", "my landlord").
    #[arg(long)]
    person: String,
    /// The day, YYYY-MM-DD. Must be a real date.
    #[arg(long)]
    date: String,
    /// Short parenthetical — what happened, in her words where you can.
    #[arg(long, default_value = "")]
    note: String,
    #[command(flatten)]
    content: ContentDir,
}

#[derive(Args)]
struct AddAliasArgs {
    /// Who — a slug, first name, or existing alias.
    #[arg(long)]
    person: String,
    /// The role/nickname she uses in prose ("my landlord", "the recruiter").
    #[arg(long)]
    alias: String,
    #[command(flatten)]
    content: ContentDir,
}

#[derive(Args)]
struct NewPersonArgs {
    /// Their name as it heads the file ("Priya", "David").
    #[arg(long)]
    name: String,
    /// Optional file slug; defaults to the lowercased first name (add e.g. "david-armenian" to disambiguate).
    #[arg(long)]
    slug: Option<String>,
    /// One-line who-they-are, in plain prose.
    #[arg(long)]
    blurb: String,
    /// First reference date, YYYY-MM-DD.
    #[arg(long)]
    date: String,
    /// First reference note — how they came up today.
    #[arg(long, default_value = "")]
    note: String,
    /// Alias to seed (repeatable). Only for a role you expect to recur.
    #[arg(long)]
    alias: Vec<String>,
    #[command(flatten)]
    content: ContentDir,
}

fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().cmd {
        Command::Validate(a) => run_validate(a),
        Command::AddRef(a) => run_add_ref(a),
        Command::AddAlias(a) => run_add_alias(a),
        Command::NewPerson(a) => run_new_person(a),
    }
}

// ── The reference-line grammar. Byte-for-byte with entities.py's _REF_RE, so a
//    line that validates here is exactly a line the database will parse. ───────
fn ref_re() -> Regex {
    Regex::new(r"^-\s*(?:\[\[)?(\d{4}-\d{2}-\d{2})(?:\]\])?\s*(?:\((.*)\))?\s*$").unwrap()
}

// ═══════════════════════════════════════════════════════════════════════════
//  validate — the contract enforcer
// ═══════════════════════════════════════════════════════════════════════════
fn run_validate(args: ValidateArgs) -> Result<(), Box<dyn Error>> {
    let pdir = people_dir(&args.content)?;
    let re = ref_re();

    let mut files = 0usize;
    let mut total_err = 0usize;
    let mut total_warn = 0usize;

    for path in list_people(&pdir)? {
        files += 1;
        let text = fs::read_to_string(&path)?;
        let (errs, warns) = check_file(&text, &re);
        total_err += errs.len();
        total_warn += warns.len();

        if errs.is_empty() && warns.is_empty() {
            if !args.quiet {
                println!("ok    {}", file_label(&path));
            }
            continue;
        }
        println!("{}  {}", if errs.is_empty() { "warn " } else { "ERROR" }, file_label(&path));
        for e in &errs {
            println!("      ✗ {}", e);
        }
        for w in &warns {
            println!("      · {}", w);
        }
    }

    println!(
        "\n{} file(s) checked — {} error(s), {} warning(s)",
        files, total_err, total_warn
    );
    if total_err > 0 {
        // Nonzero exit is the whole point: the cricket runner (and CI) can see drift.
        std::process::exit(1);
    }
    Ok(())
}

/// Parse one file's text the way the database would, collecting everything it
/// would silently drop (errors) and everything that smells like drift (warnings).
fn check_file(text: &str, re: &Regex) -> (Vec<String>, Vec<String>) {
    let mut errs = Vec::new();
    let mut warns = Vec::new();

    // ── Frontmatter ──────────────────────────────────────────────────────────
    let body = if text.starts_with("---") {
        let lines: Vec<&str> = text.lines().collect();
        match lines.iter().skip(1).position(|l| l.trim() == "---") {
            None => {
                errs.push("frontmatter opened with `---` but never closed".into());
                text
            }
            Some(rel_end) => {
                let end = rel_end + 1; // position() was offset by the skip(1)
                for line in &lines[1..end] {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let (key, val) = match line.split_once(':') {
                        Some(kv) => kv,
                        None => {
                            warns.push(format!("frontmatter line has no `key:` — `{}`", line));
                            continue;
                        }
                    };
                    let key = key.trim().to_lowercase();
                    if key != "tags" && key != "aliases" {
                        warns.push(format!("unknown frontmatter key `{}` (only tags/aliases are read)", key));
                        continue;
                    }
                    for item in parse_list(val) {
                        if item != item.to_lowercase() {
                            warns.push(format!("{} entry not lowercase: `{}`", key, item));
                        }
                    }
                }
                // Return the body slice after the closing fence.
                after_frontmatter(text)
            }
        }
    } else {
        text
    };

    // ── Body: heading, section, reference lines ──────────────────────────────
    let mut saw_h1 = false;
    let mut in_refs = false;
    let mut saw_refs_header = false;
    let mut ref_count = 0usize;
    let mut seen_dates: Vec<String> = Vec::new();
    let mut blurb = String::new();
    let mut blurb_done = false;

    for line in body.lines() {
        let s = line.trim();
        if !saw_h1 && s.starts_with("# ") {
            saw_h1 = true;
            continue;
        }
        if s.to_lowercase().starts_with("## referenced in") {
            in_refs = true;
            saw_refs_header = true;
            continue;
        }
        if in_refs {
            if s.is_empty() {
                continue;
            }
            if s.starts_with("- ") || s == "-" {
                match re.captures(s) {
                    Some(c) => {
                        let date = c.get(1).unwrap().as_str().to_string();
                        if !is_real_date(&date) {
                            errs.push(format!("reference has an impossible date: `{}`", s));
                        }
                        if seen_dates.contains(&date) {
                            warns.push(format!("duplicate reference date `{}`", date));
                        }
                        seen_dates.push(date);
                        ref_count += 1;
                    }
                    None => {
                        // THE big one: a bullet the database can't parse = silent data loss.
                        errs.push(format!("unparseable reference line (database would drop it): `{}`", s));
                    }
                }
            }
            // Non-bullet prose inside Referenced In is allowed (sub-notes); ignore.
            continue;
        }
        if s.starts_with("## ") {
            blurb_done = true;
            continue;
        }
        if blurb_done {
            continue;
        }
        if s.is_empty() {
            if !blurb.is_empty() {
                blurb_done = true;
            }
            continue;
        }
        if !blurb.is_empty() {
            blurb.push(' ');
        }
        blurb.push_str(s);
    }

    if !saw_h1 {
        errs.push("no `# Name` heading — parser falls back to the filename".into());
    }
    if !saw_refs_header {
        warns.push("no `## Referenced In` section".into());
    } else if ref_count == 0 {
        warns.push("`## Referenced In` section is empty".into());
    }
    if blurb.trim().is_empty() {
        warns.push("no blurb (first paragraph) — the popover will show nothing".into());
    }

    (errs, warns)
}

// ═══════════════════════════════════════════════════════════════════════════
//  add-ref
// ═══════════════════════════════════════════════════════════════════════════
fn run_add_ref(args: AddRefArgs) -> Result<(), Box<dyn Error>> {
    if !is_real_date(&args.date) {
        return Err(format!("`{}` is not a real YYYY-MM-DD date", args.date).into());
    }
    let pdir = people_dir(&args.content)?;
    let path = resolve_person(&pdir, &args.person)?;
    let re = ref_re();

    let text = fs::read_to_string(&path)?;

    // Idempotent: never add a second line for a date that's already logged.
    for line in text.lines() {
        let s = line.trim();
        if let Some(c) = re.captures(s) {
            if c.get(1).map(|m| m.as_str()) == Some(args.date.as_str()) {
                println!("already present: {} already has {}", file_label(&path), args.date);
                return Ok(());
            }
        }
    }

    let note = args.note.trim();
    let new_line = if note.is_empty() {
        format!("- [[{}]]", args.date)
    } else {
        format!("- [[{}]] ({})", args.date, note)
    };

    let updated = insert_reference(&text, &new_line);
    atomic_write(&path, &updated)?;

    let slug = slug_of(&path);
    log_change(
        &content_root(&args.content)?,
        "ref",
        &slug,
        &format!("[[{}]] {}", args.date, if note.is_empty() { "(no note)" } else { note }),
    )?;
    println!("added ref to {}: {}", file_label(&path), new_line);
    Ok(())
}

/// Splice a reference line into the `## Referenced In` section (creating it if
/// absent), preserving everything else exactly.
fn insert_reference(text: &str, new_line: &str) -> String {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();

    // Find the Referenced-In header.
    let header = lines
        .iter()
        .position(|l| l.trim().to_lowercase().starts_with("## referenced in"));

    match header {
        Some(h) => {
            // End of the section = next `## ` heading, or end of file.
            let mut end = lines.len();
            for (i, l) in lines.iter().enumerate().skip(h + 1) {
                if l.trim().starts_with("## ") {
                    end = i;
                    break;
                }
            }
            // Insert after the last non-blank line within the section (keeps the
            // list tight, tolerates trailing blank lines before the next heading).
            let mut insert_at = h + 1;
            for i in (h + 1)..end {
                if !lines[i].trim().is_empty() {
                    insert_at = i + 1;
                }
            }
            lines.insert(insert_at, new_line.to_string());
        }
        None => {
            // No section yet — add one at the bottom (matches the cricket's old behavior).
            if !lines.is_empty() && !lines.last().unwrap().trim().is_empty() {
                lines.push(String::new());
            }
            lines.push("## Referenced In".to_string());
            lines.push(new_line.to_string());
        }
    }

    let mut out = lines.join("\n");
    out.push('\n'); // files end with a trailing newline
    out
}

// ═══════════════════════════════════════════════════════════════════════════
//  add-alias
// ═══════════════════════════════════════════════════════════════════════════
fn run_add_alias(args: AddAliasArgs) -> Result<(), Box<dyn Error>> {
    let pdir = people_dir(&args.content)?;
    let path = resolve_person(&pdir, &args.person)?;
    let alias = args.alias.trim().to_lowercase();
    if alias.is_empty() {
        return Err("alias is empty — refusing to add a blank alias".into());
    }

    let text = fs::read_to_string(&path)?;
    let (mut tags, mut aliases, body, had_fm) = split_frontmatter(&text);

    if aliases.iter().any(|a| a.to_lowercase() == alias) {
        println!("already present: {} already lists alias `{}`", file_label(&path), alias);
        return Ok(());
    }
    aliases.push(alias.clone());
    // tags is left exactly as-is — aliases are the daily cricket's, tags are the weekly's.
    let _ = &mut tags;

    let updated = format!(
        "---\ntags: {}\naliases: {}\n---\n{}",
        format_list(&tags),
        format_list(&aliases),
        body
    );
    atomic_write(&path, &ensure_trailing_newline(&updated))?;

    let slug = slug_of(&path);
    let action = if had_fm { "alias" } else { "alias+fm" };
    log_change(&content_root(&args.content)?, action, &slug, &format!("+alias `{}`", alias))?;
    println!("added alias to {}: `{}`", file_label(&path), alias);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  new-person
// ═══════════════════════════════════════════════════════════════════════════
fn run_new_person(args: NewPersonArgs) -> Result<(), Box<dyn Error>> {
    if !is_real_date(&args.date) {
        return Err(format!("`{}` is not a real YYYY-MM-DD date", args.date).into());
    }
    let name = args.name.trim();
    if name.is_empty() {
        return Err("name is empty".into());
    }
    let blurb = args.blurb.trim();
    if blurb.is_empty() {
        return Err("blurb is empty — a new person needs a one-line who-they-are".into());
    }
    let pdir = people_dir(&args.content)?;

    let slug = match args.slug {
        Some(s) => s.trim().to_lowercase(),
        None => name.split_whitespace().next().unwrap_or(name).to_lowercase(),
    };
    let path = pdir.join(format!("{}.md", slug));
    if path.exists() {
        return Err(format!("{}.md already exists — use add-ref instead of clobbering it", slug).into());
    }

    let aliases: Vec<String> = args.alias.iter().map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
    let note = args.note.trim();
    let ref_line = if note.is_empty() {
        format!("- [[{}]]", args.date)
    } else {
        format!("- [[{}]] ({})", args.date, note)
    };

    let content = format!(
        "---\ntags: []\naliases: {}\n---\n# {}\n\n{}\n\n## Referenced In\n{}\n",
        format_list(&aliases),
        name,
        blurb,
        ref_line,
    );
    fs::create_dir_all(&pdir)?;
    atomic_write(&path, &content)?;

    log_change(
        &content_root(&args.content)?,
        "new",
        &slug,
        &format!("created — \"{}\"", first_words(blurb, 8)),
    )?;
    println!("created {}", file_label(&path));
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  changelog — every write lands here, newest at the bottom, grouped by day
// ═══════════════════════════════════════════════════════════════════════════
fn log_change(content_root: &Path, action: &str, person: &str, detail: &str) -> Result<(), Box<dyn Error>> {
    let dir = content_root.join("_system");
    fs::create_dir_all(&dir)?;
    let path = dir.join("cricket_changelog.md");

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let now = chrono::Local::now().format("%H:%M").to_string();

    let mut existing = fs::read_to_string(&path).unwrap_or_else(|_| {
        "# Cricket Changelog\n\nEvery automated write to `tulku/people/` goes through the `people` tool, \
which records it here — newest at the bottom, grouped by day. This is your window \
into what the nightly crickets did to your vault: skim it, trust it, or catch a bad \
write early. Nothing here is authored by hand.\n"
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
    existing.push_str(&format!("- {} · {} · **{}** — {}\n", now, action, person, detail));

    atomic_write(&path, &existing)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  Frontmatter + list helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Split a file into (tags, aliases, body-after-frontmatter, had_frontmatter).
/// Only tags/aliases are understood; any other frontmatter key would be lost on
/// rewrite, so add-alias only ever runs on files whose frontmatter is just these
/// two (or none) — which is the shape the crickets and stubs produce.
fn split_frontmatter(text: &str) -> (Vec<String>, Vec<String>, String, bool) {
    if !text.starts_with("---") {
        return (Vec::new(), Vec::new(), text.to_string(), false);
    }
    let lines: Vec<&str> = text.lines().collect();
    let end = match lines.iter().skip(1).position(|l| l.trim() == "---") {
        Some(rel) => rel + 1,
        None => return (Vec::new(), Vec::new(), text.to_string(), false),
    };
    let mut tags = Vec::new();
    let mut aliases = Vec::new();
    for line in &lines[1..end] {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_lowercase().as_str() {
                "tags" => tags = parse_list(v),
                "aliases" => aliases = parse_list(v),
                _ => {}
            }
        }
    }
    let body = after_frontmatter(text).to_string();
    (tags, aliases, body, true)
}

/// The slice of `text` after the closing `---` of a leading frontmatter block.
fn after_frontmatter(text: &str) -> &str {
    if !text.starts_with("---") {
        return text;
    }
    // Find the second `---` on its own line and return everything past that line.
    let mut seen = 0;
    let mut idx = 0;
    for line in text.split_inclusive('\n') {
        if line.trim_end_matches('\n').trim() == "---" {
            seen += 1;
            if seen == 2 {
                return &text[idx + line.len()..];
            }
        }
        idx += line.len();
    }
    text
}

fn parse_list(val: &str) -> Vec<String> {
    let v = val.trim();
    let v = v.strip_prefix('[').unwrap_or(v);
    let v = v.strip_suffix(']').unwrap_or(v);
    v.split(',')
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn format_list(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

// ═══════════════════════════════════════════════════════════════════════════
//  Small shared helpers
// ═══════════════════════════════════════════════════════════════════════════

fn content_root(c: &ContentDir) -> Result<PathBuf, Box<dyn Error>> {
    c.content_dir
        .clone()
        .or_else(|| std::env::var_os("EXOCORTEX_CONTENT_DIR").map(PathBuf::from))
        .ok_or_else(|| "no content dir: pass --content-dir or set EXOCORTEX_CONTENT_DIR".into())
}

fn people_dir(c: &ContentDir) -> Result<PathBuf, Box<dyn Error>> {
    let dir = content_root(c)?.join("people");
    Ok(dir)
}

fn list_people(pdir: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    if !pdir.exists() {
        return Err(format!("no people dir at {}", pdir.display()).into());
    }
    let mut out: Vec<PathBuf> = fs::read_dir(pdir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .collect();
    out.sort();
    Ok(out)
}

fn slug_of(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .split('-')
        .next()
        .unwrap_or("")
        .to_string()
}

fn file_label(path: &Path) -> String {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("?").to_string()
}

/// Resolve `query` to a people file by slug, then first name, then any alias —
/// the same precedence entities.py's resolve_person uses. First file wins on ties.
fn resolve_person(pdir: &Path, query: &str) -> Result<PathBuf, Box<dyn Error>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("--person is empty".into());
    }
    let files = list_people(pdir)?;

    // 1. slug (stem before the first '-')
    for p in &files {
        if slug_of(p) == q {
            return Ok(p.clone());
        }
    }
    // 2. first name of the `# Heading`, 3. any alias
    for p in &files {
        let text = fs::read_to_string(p).unwrap_or_default();
        let (_, aliases, body, _) = split_frontmatter(&text);
        if let Some(h1) = body.lines().find_map(|l| l.trim().strip_prefix("# ")) {
            if h1.split_whitespace().next().map(|w| w.to_lowercase()) == Some(q.clone()) {
                return Ok(p.clone());
            }
        }
        if aliases.iter().any(|a| a.to_lowercase() == q) {
            return Ok(p.clone());
        }
    }
    Err(format!(
        "no person matches `{}` — pass an existing slug/first name/alias, or use new-person",
        query
    )
    .into())
}

fn is_real_date(s: &str) -> bool {
    // Grammar already guaranteed \d{4}-\d{2}-\d{2} by the regex where it matters;
    // here we reject impossible months/days so a typo'd 2026-13-40 can't slip in.
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return false;
    }
    let (y, m, d) = (
        parts[0].parse::<i32>(),
        parts[1].parse::<u32>(),
        parts[2].parse::<u32>(),
    );
    match (y, m, d) {
        (Ok(_), Ok(m), Ok(d)) => (1..=12).contains(&m) && (1..=31).contains(&d),
        _ => false,
    }
}

fn first_words(s: &str, n: usize) -> String {
    let words: Vec<&str> = s.split_whitespace().take(n).collect();
    let joined = words.join(" ");
    if s.split_whitespace().count() > n {
        format!("{}…", joined)
    } else {
        joined
    }
}

fn ensure_trailing_newline(s: &str) -> String {
    if s.ends_with('\n') {
        s.to_string()
    } else {
        format!("{}\n", s)
    }
}

/// Atomic write: temp file + rename. A crash mid-write can never corrupt the file.
fn atomic_write(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, contents.as_bytes())?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tests — the contract. If these pass, a validated write is a parseable write.
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    fn errs(text: &str) -> Vec<String> {
        check_file(text, &ref_re()).0
    }
    fn warns(text: &str) -> Vec<String> {
        check_file(text, &ref_re()).1
    }

    const GOOD: &str = "---\ntags: [austin]\naliases: [my landlord]\n---\n# Sally\n\nA blurb.\n\n## Referenced In\n- [[2026-05-10]] (wikilink form)\n- 2026-02-27 (bare form)\n";

    #[test]
    fn clean_file_has_no_errors() {
        assert!(errs(GOOD).is_empty(), "{:?}", errs(GOOD));
        assert!(warns(GOOD).is_empty(), "{:?}", warns(GOOD));
    }

    #[test]
    fn both_reference_shapes_parse() {
        // Wikilinked and bare dates both validate — matches entities.py _REF_RE.
        assert!(errs("# X\n\nb\n\n## Referenced In\n- [[2026-01-02]] (a)\n- 2026-03-04 (b)\n").is_empty());
    }

    #[test]
    fn em_dash_reference_is_an_error() {
        // The exact drift found in the real vault: `- DATE — note` the DB drops.
        let e = errs("# X\n\nb\n\n## Referenced In\n- 2026-04-04 — met at party\n");
        assert_eq!(e.len(), 1);
        assert!(e[0].contains("unparseable"));
    }

    #[test]
    fn date_range_reference_is_an_error() {
        let e = errs("# X\n\nb\n\n## Referenced In\n- 2026-03-07 through 2026-03-20 (lab work)\n");
        assert_eq!(e.len(), 1);
    }

    #[test]
    fn unclosed_frontmatter_is_an_error() {
        let e = errs("---\ntags: []\n# Sally\n\nb\n\n## Referenced In\n- 2026-01-01 (x)\n");
        assert!(e.iter().any(|m| m.contains("never closed")));
    }

    #[test]
    fn impossible_date_is_an_error() {
        let e = errs("# X\n\nb\n\n## Referenced In\n- [[2026-13-40]] (nope)\n");
        assert!(e.iter().any(|m| m.contains("impossible date")));
    }

    #[test]
    fn missing_heading_is_an_error() {
        let e = errs("no heading here\n\n## Referenced In\n- 2026-01-01 (x)\n");
        assert!(e.iter().any(|m| m.contains("no `# Name`")));
    }

    #[test]
    fn missing_section_and_blurb_are_warnings() {
        let w = warns("# X\n");
        assert!(w.iter().any(|m| m.contains("Referenced In")));
        assert!(w.iter().any(|m| m.contains("blurb")));
    }

    #[test]
    fn unknown_frontmatter_key_warns() {
        let w = warns("---\ncolor: blue\n---\n# X\n\nb\n\n## Referenced In\n- 2026-01-01 (x)\n");
        assert!(w.iter().any(|m| m.contains("unknown frontmatter key")));
    }

    #[test]
    fn duplicate_date_warns() {
        let w = warns("# X\n\nb\n\n## Referenced In\n- 2026-01-01 (a)\n- 2026-01-01 (b)\n");
        assert!(w.iter().any(|m| m.contains("duplicate")));
    }

    #[test]
    fn insert_reference_appends_within_section() {
        let out = insert_reference(GOOD, "- [[2026-07-04]] (new)");
        // New line lands after the last existing ref, still inside the section.
        assert!(out.contains("- 2026-02-27 (bare form)\n- [[2026-07-04]] (new)"));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn insert_reference_creates_missing_section() {
        let out = insert_reference("# X\n\nblurb\n", "- [[2026-07-04]] (new)");
        assert!(out.contains("## Referenced In\n- [[2026-07-04]] (new)"));
    }

    #[test]
    fn split_and_rebuild_frontmatter_preserves_body() {
        let (tags, aliases, body, had) = split_frontmatter(GOOD);
        assert!(had);
        assert_eq!(tags, vec!["austin"]);
        assert_eq!(aliases, vec!["my landlord"]);
        assert!(body.starts_with("# Sally"));
    }

    #[test]
    fn parse_list_handles_brackets_and_quotes() {
        assert_eq!(parse_list("[a, \"b\", 'c']"), vec!["a", "b", "c"]);
        assert!(parse_list("[]").is_empty());
    }

    #[test]
    fn real_dates_only() {
        assert!(is_real_date("2026-07-04"));
        assert!(!is_real_date("2026-13-40"));
        assert!(!is_real_date("2026-7-4"));
        assert!(!is_real_date("not-a-date"));
    }
}
