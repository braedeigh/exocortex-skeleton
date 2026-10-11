//! thread — the ONLY writer of `tulku/Threads/*.md`, and the linter that
//! keeps that format a contract instead of a convention.
//!
//! Same door as `people` and `add-todo`: crickets never hand-write a thread
//! file. `thread propose` drops a nomination in the SAME approval queue food
//! and symptoms already use (locked exactly like `store.mutate` in Flask, so
//! Rust and the Flask server can never interleave a read-modify-write on
//! `pending_changes.json`); once Bradie approves at the gate, the server
//! shells out to `thread open` / `thread add-card` / `thread link` the same
//! way `routes/pending.py` already shells out to `add-todo`.
//!
//!   thread check-slug topic-b
//!   thread propose thread_open --json '{"slug": "topic-b", ...}'
//!   thread open --slug topic-b --name Topic B --fronts health,job --kind standing
//!   thread add-card --slug topic-b --section "What it is" --text "..." --source 2026-07-08.1841b
//!   thread link --slug topic-b --add-parent topic-a
//!   thread set-status topic-b dormant
//!   thread set-name --slug topic-b --name Topic B
//!   thread set-charter --slug topic-b --charter "The narrower subject itself. Out: ..."
//!   thread distill topic-b
//!   thread inbox topic-b
//!   thread lint --fix-dormancy
//!
//! WHY this exists: the design of record (`personal/docs/threads-architecture.md`
//! §1) is "store only identity, membership, and lifecycle — derive everything
//! else." That only holds if the stored part can never drift into something
//! routes/threads.py can't parse. `lint` turns the shape into a contract; this
//! binary is the one door that can write it in the first place.

mod changelog;
mod graph;
mod lint;
mod model;
mod payload;
mod queue;
mod sources;
mod util;

use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

use graph::Graph;
use model::FrontMatter;

#[derive(Parser)]
#[command(
    about = "The only writer of tulku/Threads/*.md — validated writes, the approval-queue \
             proposer, and the linter that keeps routes/threads.py's parser honest."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
    /// Override the vault dir (defaults to $EXOCORTEX_CONTENT_DIR, e.g. .../personal/tulku)
    #[arg(long, global = true)]
    content_dir: Option<PathBuf>,
    /// Override the data dir (defaults to $EXOCORTEX_DATA_DIR, e.g. .../personal/data)
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// exists | pending | denied:<date> | free — always exits 0.
    CheckSlug { slug: String },
    /// Validate + append a thread_open/thread_link/thread_retire nomination to
    /// the approval queue, under an exclusive lock.
    Propose {
        /// thread_open | thread_link | thread_retire
        kind: String,
        /// The payload JSON. Pass `-` to read it from stdin.
        #[arg(long = "json")]
        json: String,
    },
    /// Create Threads/<slug>.md with full frontmatter and an empty body.
    Open(OpenArgs),
    /// Append a cited `## Heading` fact-card section to an existing thread.
    AddCard(AddCardArgs),
    /// Edit fronts:/parents:/people: membership in place.
    Link(LinkArgs),
    /// Delete Threads/<slug>.md — refused if any other thread still lists it
    /// as a parent (that would orphan a child).
    Remove {
        slug: String,
        /// Why it's being removed — recorded in the changelog.
        #[arg(long)]
        reason: String,
    },
    /// Set status (retiring stamps retired:, un-retiring clears it).
    SetStatus { slug: String, status: String },
    /// Set name — the `name:` frontmatter field, in place.
    SetName(SetNameArgs),
    /// Set the charter — the one line of scope a card is graded against.
    SetCharter(SetCharterArgs),
    /// Move the distilled: watermark to today.
    Distill { slug: String },
    /// List cards tagged <slug> dated after the distilled: watermark.
    Inbox { slug: String },
    /// Validate every Threads/*.md file; --fix-dormancy also sets dormant status.
    Lint(LintArgs),
    /// Alias for `lint` (no --fix-dormancy).
    Validate(ValidateArgs),
}

#[derive(Args)]
struct OpenArgs {
    #[arg(long)]
    slug: String,
    #[arg(long)]
    name: String,
    /// One line of scope — what belongs in this thread and what doesn't.
    /// Required: a thread nobody can say the bounds of isn't judgeable.
    #[arg(long)]
    charter: String,
    /// Comma-separated front ids, e.g. health,job. First = primary.
    #[arg(long)]
    fronts: String,
    /// standing | arc
    #[arg(long)]
    kind: String,
    /// Comma-separated parent thread slugs. First = primary.
    #[arg(long)]
    parents: Option<String>,
    #[arg(long)]
    aliases: Option<String>,
    /// The thread's cast — person-file slugs (`people/<slug>.md`). Repeatable
    /// (--people a --people b) or comma-separated (--people a,b), same as
    /// --add-parent/--parents.
    #[arg(long)]
    people: Vec<String>,
}

#[derive(Args)]
struct AddCardArgs {
    #[arg(long)]
    slug: String,
    #[arg(long)]
    section: String,
    #[arg(long)]
    text: String,
    /// Repeatable: --source SRC1 --source SRC2
    #[arg(long = "source")]
    sources: Vec<String>,
}

#[derive(Args)]
struct LinkArgs {
    #[arg(long)]
    slug: String,
    #[arg(long = "add-front")]
    add_front: Vec<String>,
    #[arg(long = "add-parent")]
    add_parent: Vec<String>,
    #[arg(long = "remove-front")]
    remove_front: Vec<String>,
    #[arg(long = "remove-parent")]
    remove_parent: Vec<String>,
    #[arg(long = "add-person")]
    add_person: Vec<String>,
    #[arg(long = "remove-person")]
    remove_person: Vec<String>,
}

#[derive(Args)]
struct SetNameArgs {
    #[arg(long)]
    slug: String,
    #[arg(long)]
    name: String,
}

#[derive(Args)]
struct SetCharterArgs {
    #[arg(long)]
    slug: String,
    #[arg(long)]
    charter: String,
}

#[derive(Args)]
struct LintArgs {
    #[arg(long)]
    quiet: bool,
    #[arg(long)]
    fix_dormancy: bool,
}

#[derive(Args)]
struct ValidateArgs {
    #[arg(long)]
    quiet: bool,
}

fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    match &cli.cmd {
        Command::CheckSlug { slug } => run_check_slug(&cli, slug),
        Command::Propose { kind, json } => run_propose(&cli, kind, json),
        Command::Open(a) => run_open(&cli, a),
        Command::AddCard(a) => run_add_card(&cli, a),
        Command::Link(a) => run_link(&cli, a),
        Command::Remove { slug, reason } => run_remove(&cli, slug, reason),
        Command::SetStatus { slug, status } => run_set_status(&cli, slug, status),
        Command::SetName(a) => run_set_name(&cli, a),
        Command::SetCharter(a) => run_set_charter(&cli, a),
        Command::Distill { slug } => run_distill(&cli, slug),
        Command::Inbox { slug } => run_inbox(&cli, slug),
        Command::Lint(a) => run_lint(&cli, a.quiet, a.fix_dormancy),
        Command::Validate(a) => run_lint(&cli, a.quiet, false),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared setup
// ═══════════════════════════════════════════════════════════════════════════

fn dirs(cli: &Cli) -> Result<(PathBuf, PathBuf), Box<dyn Error>> {
    Ok((util::content_dir(&cli.content_dir)?, util::data_dir(&cli.data_dir)?))
}

fn known_fronts_set(data_dir: &std::path::Path) -> Result<HashSet<String>, Box<dyn Error>> {
    Ok(queue::load_fronts(data_dir)?.into_iter().collect())
}

fn known_slugs_set(threads_dir: &std::path::Path) -> HashSet<String> {
    util::list_thread_slugs(threads_dir).into_iter().collect()
}

/// Every `people/<slug>.md` on disk — the people tool's domain. A thread's
/// `people:` cast can only name slugs that exist there.
fn known_people_set(content_dir: &std::path::Path) -> HashSet<String> {
    util::list_people_slugs(&util::people_dir(content_dir)).into_iter().collect()
}

/// slug -> parents, read fresh from every Threads/*.md on disk.
fn load_graph(threads_dir: &std::path::Path) -> Result<Graph, Box<dyn Error>> {
    let mut g = Graph::new();
    for slug in util::list_thread_slugs(threads_dir) {
        let path = util::thread_path(threads_dir, &slug);
        let text = fs::read_to_string(&path)?;
        let tf = model::parse_thread_file(&text);
        g.insert(slug, tf.meta.parents);
    }
    Ok(g)
}

fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn errs_to_err(errs: Vec<String>) -> Box<dyn Error> {
    format!("refused:\n  - {}", errs.join("\n  - ")).into()
}

// ═══════════════════════════════════════════════════════════════════════════
//  check-slug — always exits 0 once the dirs resolve.
// ═══════════════════════════════════════════════════════════════════════════
fn run_check_slug(cli: &Cli, slug: &str) -> Result<(), Box<dyn Error>> {
    let (content, data) = dirs(cli)?;
    let result = queue::check_slug(&content, &data, slug)?;
    println!("{}", result);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  propose — validate, then locked-append to pending_changes.json.
// ═══════════════════════════════════════════════════════════════════════════
fn run_propose(cli: &Cli, kind: &str, json_arg: &str) -> Result<(), Box<dyn Error>> {
    let (content, data) = dirs(cli)?;

    let raw = if json_arg == "-" {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        s
    } else {
        json_arg.to_string()
    };
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("--json payload is not valid JSON: {}", e))?;

    let threads_dir = util::threads_dir(&content);
    let known_fronts = known_fronts_set(&data)?;
    let known_slugs = known_slugs_set(&threads_dir);
    let known_people = known_people_set(&content);
    let graph = load_graph(&threads_dir)?;

    let summary = match kind {
        "thread_open" => {
            validate_thread_open(&value, &content, &data, &known_fronts, &known_slugs, &known_people, &graph)?
        }
        "thread_link" => {
            validate_thread_link(&value, &content, &known_fronts, &known_slugs, &known_people, &graph)?
        }
        "thread_retire" => validate_thread_retire(&value)?,
        other => {
            return Err(format!(
                "unknown proposal kind `{}` — expected thread_open | thread_link | thread_retire",
                other
            )
            .into())
        }
    };

    // A caller-supplied `summary` field always wins; otherwise use what the
    // per-kind validator generated.
    let final_summary = payload::get_str(&value, "summary")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(summary);

    let id = queue::propose(&data, kind, final_summary.clone(), value)?;
    println!("staged [{}] {} for approval: {}", id, kind, final_summary);
    Ok(())
}

fn validate_thread_open(
    v: &serde_json::Value,
    content: &std::path::Path,
    data: &std::path::Path,
    known_fronts: &HashSet<String>,
    known_slugs: &HashSet<String>,
    known_people: &HashSet<String>,
    graph: &Graph,
) -> Result<String, Box<dyn Error>> {
    let mut errs = Vec::new();

    let slug = payload::require_str(v, "slug").map_err(|e| errs_to_err(vec![e]))?;
    if !util::valid_slug(slug) {
        errs.push(format!("slug `{}` doesn't match ^[a-z0-9-]{{1,40}}$", slug));
    } else {
        let state = queue::check_slug(content, data, slug)?;
        if state != "free" {
            errs.push(format!("slug `{}` is not free ({})", slug, state));
        }
    }

    let name = payload::require_str(v, "name").unwrap_or("");
    if name.trim().is_empty() {
        errs.push("`name` is required".to_string());
    }

    // The nomination threshold already demands the proposer can name the thread
    // in one line ("if it can't, it isn't a thread yet"). The charter IS that
    // line, kept instead of discarded — so it costs a cricket nothing new and
    // gives every later grader something to measure a card against.
    let charter = payload::get_str(v, "charter").unwrap_or("").trim();
    if charter.is_empty() {
        errs.push("`charter` is required — one line of what belongs in this thread and what doesn't".to_string());
    }
    errs.extend(lint::charter_errors(charter));

    let fronts = payload::get_str_list(v, "fronts");
    if fronts.is_empty() {
        errs.push("`fronts` must have at least 1 entry".to_string());
    }
    for f in &fronts {
        if !known_fronts.contains(f) {
            errs.push(format!("unknown front `{}`", f));
        }
    }

    let parents = payload::get_str_list(v, "parents");
    for p in &parents {
        if !known_slugs.contains(p) {
            errs.push(format!("unknown parent thread `{}`", p));
        }
    }
    if let Some(cyc) = graph::would_create_cycle(graph, slug, &parents) {
        errs.push(format!("parents introduce a cycle: {}", cyc.join(" -> ")));
    }

    let people = payload::get_str_list(v, "people");
    let mut seen_people: HashSet<&String> = HashSet::new();
    for p in &people {
        if !known_people.contains(p) {
            errs.push(format!("unknown person `{}` — no people/{}.md", p, p));
        }
        if !seen_people.insert(p) {
            errs.push(format!("duplicate person `{}` in people", p));
        }
    }

    let kind = payload::require_str(v, "kind").unwrap_or("");
    if !lint::KNOWN_KINDS.contains(&kind) {
        errs.push(format!("kind `{}` is not one of: {}", kind, lint::KNOWN_KINDS.join("|")));
    }

    if let Err(e) = payload::require_str(v, "proposer") {
        errs.push(e);
    }
    if let Err(e) = payload::require_str(v, "rationale") {
        errs.push(e);
    }

    let evidence = payload::get_array(v, "evidence");
    if evidence.is_empty() {
        errs.push("`evidence` must have at least 1 entry".to_string());
    }
    let mut distinct_days: HashSet<String> = HashSet::new();
    for (i, e) in evidence.iter().enumerate() {
        let source = payload::get_str(e, "source").unwrap_or("");
        let date = payload::get_str(e, "date").unwrap_or("");
        let quote = payload::get_str(e, "quote").unwrap_or("");
        if source.trim().is_empty() {
            errs.push(format!("evidence[{}].source is required", i));
        } else if let Err(msg) = sources::check_source(source, content) {
            errs.push(format!("evidence[{}].source: {}", i, msg));
        }
        if !util::is_real_date(date) {
            errs.push(format!("evidence[{}].date `{}` is not a real YYYY-MM-DD date", i, date));
        } else {
            distinct_days.insert(date.to_string());
        }
        if quote.trim().is_empty() {
            errs.push(format!("evidence[{}].quote is required", i));
        }
    }
    if !evidence.is_empty() && distinct_days.len() < 2 {
        errs.push(format!(
            "evidence spans only {} distinct day(s) — needs at least 2",
            distinct_days.len()
        ));
    }

    for (i, c) in payload::get_array(v, "cards").iter().enumerate() {
        let section = payload::get_str(c, "section").unwrap_or("");
        let text = payload::get_str(c, "text").unwrap_or("");
        let source = payload::get_str(c, "source").unwrap_or("");
        if section.trim().is_empty() {
            errs.push(format!("cards[{}].section is required", i));
        }
        if text.trim().is_empty() {
            errs.push(format!("cards[{}].text is required", i));
        } else if text.lines().filter(|l| !l.trim().is_empty()).count() > 3 {
            errs.push(format!("cards[{}].text is over 3 lines", i));
        }
        if source.trim().is_empty() {
            errs.push(format!("cards[{}].source is required", i));
        } else if let Err(msg) = sources::check_source(source, content) {
            errs.push(format!("cards[{}].source: {}", i, msg));
        }
    }

    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    Ok(format!(
        "New thread? \"{}\" — {}, {} evidence cards",
        name,
        fronts.join("+"),
        evidence.len()
    ))
}

fn validate_thread_link(
    v: &serde_json::Value,
    content: &std::path::Path,
    known_fronts: &HashSet<String>,
    known_slugs: &HashSet<String>,
    known_people: &HashSet<String>,
    graph: &Graph,
) -> Result<String, Box<dyn Error>> {
    let mut errs = Vec::new();

    let slug = payload::require_str(v, "slug").map_err(|e| errs_to_err(vec![e]))?;
    if !known_slugs.contains(slug) {
        return Err(errs_to_err(vec![format!("unknown thread `{}`", slug)]));
    }
    let threads_dir = util::threads_dir(content);
    let existing = model::load_thread(&util::thread_path(&threads_dir, slug))?;

    let add_fronts = payload::get_str_list(v, "add_fronts");
    let remove_fronts = payload::get_str_list(v, "remove_fronts");
    let add_parents = payload::get_str_list(v, "add_parents");
    let remove_parents = payload::get_str_list(v, "remove_parents");
    let add_people = payload::get_str_list(v, "add_people");
    let remove_people = payload::get_str_list(v, "remove_people");
    // Optional on a link: a thread whose scope has drifted gets its charter
    // re-cut through the same gate as its other membership edits — it's the
    // same three questions again (threads-architecture.md §2).
    let charter = payload::get_str(v, "charter").unwrap_or("").trim();
    errs.extend(lint::charter_errors(charter));

    if add_fronts.is_empty()
        && remove_fronts.is_empty()
        && add_parents.is_empty()
        && remove_parents.is_empty()
        && add_people.is_empty()
        && remove_people.is_empty()
        && charter.is_empty()
    {
        errs.push(
            "at least one of add_fronts/remove_fronts/add_parents/remove_parents/add_people/remove_people/charter must be non-empty"
                .to_string(),
        );
    }
    if let Err(e) = payload::require_str(v, "rationale") {
        errs.push(e);
    }

    for f in &add_fronts {
        if !known_fronts.contains(f) {
            errs.push(format!("unknown front `{}`", f));
        }
    }
    for p in &add_parents {
        if !known_slugs.contains(p) && p != slug {
            errs.push(format!("unknown parent thread `{}`", p));
        }
        if p == slug {
            errs.push(format!("thread `{}` can't be its own parent", slug));
        }
    }
    for p in &add_people {
        if !known_people.contains(p) {
            errs.push(format!("unknown person `{}` — no people/{}.md", p, p));
        }
    }

    // Validate the RESULT still has >=1 front, and stays acyclic.
    let new_fronts = apply_membership(&existing.meta.fronts, &add_fronts, &remove_fronts);
    if new_fronts.is_empty() {
        errs.push("result would have empty fronts — every thread stays on at least one front".to_string());
    }
    let new_parents = apply_membership(&existing.meta.parents, &add_parents, &remove_parents);
    if let Some(cyc) = graph::would_create_cycle(graph, slug, &new_parents) {
        errs.push(format!("parents introduce a cycle: {}", cyc.join(" -> ")));
    }

    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    let mut ops = Vec::new();
    for f in &add_fronts {
        ops.push(format!("+front:{}", f));
    }
    for f in &remove_fronts {
        ops.push(format!("-front:{}", f));
    }
    for p in &add_parents {
        ops.push(format!("+parent:{}", p));
    }
    for p in &remove_parents {
        ops.push(format!("-parent:{}", p));
    }
    for p in &add_people {
        ops.push(format!("+person:{}", p));
    }
    for p in &remove_people {
        ops.push(format!("-person:{}", p));
    }
    if !charter.is_empty() {
        ops.push("charter".to_string());
    }
    Ok(format!("Edit thread? \"{}\" — {}", slug, ops.join(" ")))
}

fn validate_thread_retire(v: &serde_json::Value) -> Result<String, Box<dyn Error>> {
    let mut errs = Vec::new();
    let slug = payload::require_str(v, "slug").unwrap_or("");
    if slug.is_empty() {
        errs.push("`slug` is required".to_string());
    }
    if let Err(e) = payload::require_str(v, "reason") {
        errs.push(e);
    }
    let last_card_date = payload::require_str(v, "last_card_date").unwrap_or("");
    if last_card_date.is_empty() {
        errs.push("`last_card_date` is required".to_string());
    } else if !util::is_real_date(last_card_date) {
        errs.push(format!("last_card_date `{}` is not a real YYYY-MM-DD date", last_card_date));
    }
    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }
    let reason = payload::get_str(v, "reason").unwrap_or("");
    Ok(format!("Retire thread? \"{}\" — {}", slug, first_words(reason, 12)))
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

fn apply_membership(current: &[String], add: &[String], remove: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current.iter().filter(|c| !remove.contains(c)).cloned().collect();
    for a in add {
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════
//  open
// ═══════════════════════════════════════════════════════════════════════════
fn run_open(cli: &Cli, a: &OpenArgs) -> Result<(), Box<dyn Error>> {
    let (content, data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, &a.slug);
    if path.exists() {
        return Err(format!("Threads/{}.md already exists — use add-card/link instead", a.slug).into());
    }

    let fronts = split_csv(&a.fronts);
    let parents = a.parents.as_deref().map(split_csv).unwrap_or_default();
    let aliases = a.aliases.as_deref().map(split_csv).unwrap_or_default();
    // --people accepts both repeated flags and comma lists, like --source and
    // --parents respectively — flatten either shape into one list.
    let people: Vec<String> = a.people.iter().flat_map(|s| split_csv(s)).collect();

    let fm = FrontMatter {
        name: a.name.trim().to_string(),
        charter: a.charter.trim().to_string(),
        aliases,
        fronts,
        parents,
        people,
        kind: a.kind.trim().to_string(),
        status: "active".to_string(),
        opened: util::today_str(),
        retired: None,
        distilled: None,
    };

    let known_fronts = known_fronts_set(&data)?;
    let known_slugs = known_slugs_set(&threads_dir);
    let known_people = known_people_set(&content);
    let mut errs = lint::check_frontmatter(&a.slug, &fm, &known_fronts, &known_slugs, &known_people);
    // check_frontmatter tolerates an empty charter (old files predate the
    // field); birth doesn't. Nothing new opens without a stated scope.
    if fm.charter.is_empty() {
        errs.push("--charter is required — one line of what belongs in this thread and what doesn't".to_string());
    }
    let graph = load_graph(&threads_dir)?;
    if let Some(cyc) = graph::would_create_cycle(&graph, &a.slug, &fm.parents) {
        errs.push(format!("parents introduce a cycle: {}", cyc.join(" -> ")));
    }
    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    let text = model::render_file(&fm, "");
    fs::create_dir_all(&threads_dir)?;
    util::atomic_write(&path, &text)?;

    changelog::log_change(
        &content,
        "thread-open",
        &a.slug,
        &format!("created — fronts: {}, kind: {}", fm.fronts.join("+"), fm.kind),
    )?;
    println!("created Threads/{}.md", a.slug);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  add-card
// ═══════════════════════════════════════════════════════════════════════════
fn run_add_card(cli: &Cli, a: &AddCardArgs) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, &a.slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", a.slug, a.slug).into());
    }

    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);

    let mut errs = Vec::new();
    if tf.meta.status == "retired" {
        errs.push(format!("thread `{}` is retired — no new cards", a.slug));
    }
    let heading = a.section.trim().to_string();
    if heading.is_empty() {
        errs.push("--section is empty".to_string());
    }
    if model::existing_headings(&tf.raw_body).contains(&heading) {
        errs.push(format!("duplicate heading `## {}` already exists in {}.md", heading, a.slug));
    }
    let text = a.text.trim();
    let text_lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if text_lines.is_empty() {
        errs.push("--text is empty".to_string());
    } else if text_lines.len() > 3 {
        errs.push(format!("--text is {} lines (over the 3-line limit)", text_lines.len()));
    }
    for l in &text_lines {
        if model::is_bold_metadata(l) {
            errs.push(format!("--text line looks like frontmatter metadata, not prose: `{}`", l));
        }
    }
    if a.sources.is_empty() {
        errs.push("at least one --source is required".to_string());
    }
    for s in &a.sources {
        if let Err(msg) = sources::check_source(s, &content) {
            errs.push(msg);
        }
    }
    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    let section_text = text_lines.join("\n");
    let new_section = model::render_section(&heading, &section_text, &a.sources);
    let new_body = model::append_section(&tf.raw_body, &new_section);
    let out = model::render_file(&tf.meta, &new_body);
    util::atomic_write(&path, &out)?;

    changelog::log_change(
        &content,
        "thread-card",
        &a.slug,
        &format!("added \"## {}\" ({} source(s))", heading, a.sources.len()),
    )?;
    println!("added \"## {}\" to Threads/{}.md", heading, a.slug);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  link
// ═══════════════════════════════════════════════════════════════════════════
fn run_link(cli: &Cli, a: &LinkArgs) -> Result<(), Box<dyn Error>> {
    let (content, data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, &a.slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", a.slug, a.slug).into());
    }

    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let mut meta = tf.meta.clone();

    let new_fronts = apply_membership(&meta.fronts, &a.add_front, &a.remove_front);
    let new_parents = apply_membership(&meta.parents, &a.add_parent, &a.remove_parent);
    let new_people = apply_membership(&meta.people, &a.add_person, &a.remove_person);

    let known_fronts = known_fronts_set(&data)?;
    let known_slugs = known_slugs_set(&threads_dir);
    let known_people = known_people_set(&content);

    let mut errs = Vec::new();
    if new_fronts.is_empty() {
        errs.push("result would have empty fronts — every thread stays on at least one front".to_string());
    }
    for f in &a.add_front {
        if !known_fronts.contains(f) {
            errs.push(format!("unknown front `{}`", f));
        }
    }
    for p in &a.add_parent {
        if p == &a.slug {
            errs.push(format!("thread `{}` can't be its own parent", a.slug));
        } else if !known_slugs.contains(p) {
            errs.push(format!("unknown parent thread `{}` — no Threads/{}.md", p, p));
        }
    }
    for p in &a.add_person {
        if !known_people.contains(p) {
            errs.push(format!("unknown person `{}` — no people/{}.md", p, p));
        }
    }
    let graph = load_graph(&threads_dir)?;
    if let Some(cyc) = graph::would_create_cycle(&graph, &a.slug, &new_parents) {
        errs.push(format!("parents introduce a cycle: {}", cyc.join(" -> ")));
    }
    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    meta.fronts = new_fronts;
    meta.parents = new_parents;
    meta.people = new_people;
    let out = model::render_file(&meta, &tf.raw_body);
    util::atomic_write(&path, &out)?;

    let mut ops = Vec::new();
    for f in &a.add_front {
        ops.push(format!("+front:{}", f));
    }
    for f in &a.remove_front {
        ops.push(format!("-front:{}", f));
    }
    for p in &a.add_parent {
        ops.push(format!("+parent:{}", p));
    }
    for p in &a.remove_parent {
        ops.push(format!("-parent:{}", p));
    }
    for p in &a.add_person {
        ops.push(format!("+person:{}", p));
    }
    for p in &a.remove_person {
        ops.push(format!("-person:{}", p));
    }
    changelog::log_change(&content, "thread-link", &a.slug, &ops.join(" "))?;
    println!("updated Threads/{}.md: {}", a.slug, ops.join(" "));
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  remove — direct human/CLI action only, never staged via propose.
// ═══════════════════════════════════════════════════════════════════════════
fn run_remove(cli: &Cli, slug: &str, reason: &str) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", slug, slug).into());
    }
    if reason.trim().is_empty() {
        return Err("--reason is empty".into());
    }

    // Refuse if any OTHER thread still lists this one as a parent — removing
    // it would orphan a child.
    let mut children = Vec::new();
    for other in util::list_thread_slugs(&threads_dir) {
        if other == slug {
            continue;
        }
        let other_path = util::thread_path(&threads_dir, &other);
        let text = fs::read_to_string(&other_path)?;
        let tf = model::parse_thread_file(&text);
        if tf.meta.parents.iter().any(|p| p == slug) {
            children.push(other);
        }
    }
    if !children.is_empty() {
        return Err(errs_to_err(vec![format!(
            "thread `{}` is still the parent of: {} — relink or remove those first",
            slug,
            children.join(", ")
        )]));
    }

    fs::remove_file(&path)?;

    changelog::log_change(&content, "thread-remove", slug, reason)?;
    println!("removed Threads/{}.md", slug);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  set-status
// ═══════════════════════════════════════════════════════════════════════════
fn run_set_status(cli: &Cli, slug: &str, status: &str) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", slug, slug).into());
    }
    if status == "seedling" {
        return Err("status `seedling` never appears on disk — seedlings live in the pending queue".into());
    }
    if !lint::KNOWN_STATUSES.contains(&status) {
        return Err(format!("status `{}` is not one of: {}", status, lint::KNOWN_STATUSES.join("|")).into());
    }

    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let mut meta = tf.meta.clone();
    let old_status = meta.status.clone();
    meta.status = status.to_string();
    meta.retired = if status == "retired" {
        Some(util::today_str())
    } else {
        None
    };

    let out = model::render_file(&meta, &tf.raw_body);
    util::atomic_write(&path, &out)?;

    changelog::log_change(
        &content,
        "thread-status",
        slug,
        &format!("{} -> {}", old_status, status),
    )?;
    println!("Threads/{}.md: {} -> {}", slug, old_status, status);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  set-name
// ═══════════════════════════════════════════════════════════════════════════
fn run_set_name(cli: &Cli, a: &SetNameArgs) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, &a.slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", a.slug, a.slug).into());
    }
    let new_name = a.name.trim();
    if new_name.is_empty() {
        return Err("name is required and must be non-empty".into());
    }

    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let mut meta = tf.meta.clone();
    let old_name = meta.name.clone();
    meta.name = new_name.to_string();

    let out = model::render_file(&meta, &tf.raw_body);
    util::atomic_write(&path, &out)?;

    changelog::log_change(
        &content,
        "thread-rename",
        &a.slug,
        &format!("\"{}\" -> \"{}\"", old_name, new_name),
    )?;
    println!("Threads/{}.md: \"{}\" -> \"{}\"", a.slug, old_name, new_name);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  set-charter — the backfill door for threads written before charters, and
//  the way a scope gets re-cut when a thread turns out to be about something
//  slightly different than it was born as.
// ═══════════════════════════════════════════════════════════════════════════
fn run_set_charter(cli: &Cli, a: &SetCharterArgs) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, &a.slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", a.slug, a.slug).into());
    }
    let charter = a.charter.trim();
    let mut errs = lint::charter_errors(charter);
    if charter.is_empty() {
        errs.push("--charter is empty — a charter can be re-cut but not removed".to_string());
    }
    if !errs.is_empty() {
        return Err(errs_to_err(errs));
    }

    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let mut meta = tf.meta.clone();
    let had_one = !meta.charter.trim().is_empty();
    meta.charter = charter.to_string();

    let out = model::render_file(&meta, &tf.raw_body);
    util::atomic_write(&path, &out)?;

    changelog::log_change(
        &content,
        "thread-charter",
        &a.slug,
        &format!("{} — {}", if had_one { "re-cut" } else { "set" }, charter),
    )?;
    println!("Threads/{}.md: charter {}", a.slug, if had_one { "re-cut" } else { "set" });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  distill
// ═══════════════════════════════════════════════════════════════════════════
fn run_distill(cli: &Cli, slug: &str) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", slug, slug).into());
    }
    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let mut meta = tf.meta.clone();
    let today = util::today_str();
    meta.distilled = Some(today.clone());
    let out = model::render_file(&meta, &tf.raw_body);
    util::atomic_write(&path, &out)?;

    changelog::log_change(&content, "thread-distill", slug, &format!("distilled -> {}", today))?;
    println!("Threads/{}.md: distilled -> {}", slug, today);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
//  inbox
// ═══════════════════════════════════════════════════════════════════════════
fn run_inbox(cli: &Cli, slug: &str) -> Result<(), Box<dyn Error>> {
    let (content, _data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);
    let path = util::thread_path(&threads_dir, slug);
    if !path.exists() {
        return Err(format!("unknown thread `{}` — no Threads/{}.md", slug, slug).into());
    }
    let raw = fs::read_to_string(&path)?;
    let tf = model::parse_thread_file(&raw);
    let watermark = tf.meta.distilled.as_deref().and_then(util::parse_date);

    let cards_dir = util::cards_dir(&content);
    let mut hits: Vec<(String, String)> = Vec::new(); // (id, first-line)
    if let Ok(rd) = fs::read_dir(&cards_dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.extension().map(|e| e != "md").unwrap_or(true) {
                continue;
            }
            let text = match fs::read_to_string(&p) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let card = parse_card(&text, &p);
            if !card.tags.iter().any(|t| t == slug) {
                continue;
            }
            let id_date = card.id.split('.').next().and_then(util::parse_date);
            let after_watermark = match (watermark, id_date) {
                (Some(w), Some(d)) => d > w,
                (None, Some(_)) => true,
                (_, None) => false,
            };
            if after_watermark {
                hits.push((card.id.clone(), truncate(&card.first_line, 120)));
            }
        }
    }
    hits.sort_by(|a, b| a.0.cmp(&b.0));
    for (id, line) in hits {
        println!("{}\t{}", id, line);
    }
    Ok(())
}

struct Card {
    id: String,
    tags: Vec<String>,
    first_line: String,
}

fn parse_card(text: &str, path: &std::path::Path) -> Card {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let mut id = stem;
    let mut tags = Vec::new();
    let mut first_line = String::new();

    if text.starts_with("---") {
        let lines: Vec<&str> = text.lines().collect();
        if let Some(rel_end) = lines.iter().skip(1).position(|l| l.trim() == "---") {
            let end = rel_end + 1;
            for line in &lines[1..end] {
                if let Some((k, v)) = line.split_once(':') {
                    let k = k.trim().to_lowercase();
                    let v = v.trim();
                    match k.as_str() {
                        "id" if !v.is_empty() => id = v.to_string(),
                        "tags" => {
                            let v2 = v.strip_prefix('[').unwrap_or(v);
                            let v2 = v2.strip_suffix(']').unwrap_or(v2);
                            tags = v2
                                .split(',')
                                .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
                                .filter(|s| !s.is_empty())
                                .collect();
                        }
                        _ => {}
                    }
                }
            }
            first_line = lines[end + 1..]
                .iter()
                .map(|l| l.trim())
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string();
        }
    } else {
        first_line = text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string();
    }

    Card { id, tags, first_line }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", truncated)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  lint / validate
// ═══════════════════════════════════════════════════════════════════════════
fn run_lint(cli: &Cli, quiet: bool, fix_dormancy: bool) -> Result<(), Box<dyn Error>> {
    let (content, data) = dirs(cli)?;
    let threads_dir = util::threads_dir(&content);

    if fix_dormancy {
        let changed = apply_fix_dormancy(&content, &threads_dir)?;
        for line in &changed {
            println!("{}", line);
        }
    }

    let reports = lint::lint_all(&content, &data)?;
    let mut total_err = 0usize;
    let mut total_warn = 0usize;
    for r in &reports {
        total_err += r.errors.len();
        total_warn += r.warnings.len();
        let label = format!("{}.md", r.slug);
        if r.errors.is_empty() && r.warnings.is_empty() {
            if !quiet {
                println!("{}: ok", label);
            }
            continue;
        }
        for e in &r.errors {
            println!("{}: ERROR: {}", label, e);
        }
        for w in &r.warnings {
            println!("{}: warning: {}", label, w);
        }
    }
    println!(
        "\n{} file(s) checked — {} error(s), {} warning(s)",
        reports.len(),
        total_err,
        total_warn
    );
    if total_err > 0 {
        std::process::exit(1);
    }
    Ok(())
}

/// `--fix-dormancy`: any `status: active` thread whose most recent dated
/// source is >28 days old gets `status: dormant`. Returns report lines.
fn apply_fix_dormancy(
    content: &std::path::Path,
    threads_dir: &std::path::Path,
) -> Result<Vec<String>, Box<dyn Error>> {
    let mut report = Vec::new();
    let today = util::today();
    for slug in util::list_thread_slugs(threads_dir) {
        let path = util::thread_path(threads_dir, &slug);
        let raw = fs::read_to_string(&path)?;
        let tf = model::parse_thread_file(&raw);
        if tf.meta.status != "active" {
            continue;
        }
        let most_recent = lint::most_recent_source_date(&tf);
        let age_days = most_recent.map(|d| (today - d).num_days());
        if let Some(age) = age_days {
            if age > 28 {
                let mut meta = tf.meta.clone();
                meta.status = "dormant".to_string();
                let out = model::render_file(&meta, &tf.raw_body);
                util::atomic_write(&path, &out)?;
                changelog::log_change(
                    content,
                    "thread-status",
                    &slug,
                    &format!(
                        "active -> dormant (most recent source {}, {} days old)",
                        most_recent.unwrap(),
                        age
                    ),
                )?;
                report.push(format!(
                    "{}.md: active -> dormant (most recent source {}, {} days old)",
                    slug,
                    most_recent.unwrap(),
                    age
                ));
            }
        }
    }
    Ok(report)
}
