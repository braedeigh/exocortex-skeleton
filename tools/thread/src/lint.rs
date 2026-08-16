//! `thread lint` / `thread validate` — every rule in the spec's "file format"
//! section, run against one file or the whole `Threads/` directory, plus the
//! graph-level checks (cycles, dangling parents) that need every file at once.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs;
use std::path::Path;

use crate::graph::{find_all_cycles, Graph};
use crate::model::{parse_thread_file, FrontMatter, ThreadFile};
use crate::queue::load_fronts;
use crate::sources::check_source;
use crate::util::{is_real_date, list_thread_slugs, threads_dir, valid_slug};

pub struct FileReport {
    pub slug: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub const KNOWN_KINDS: [&str; 2] = ["standing", "arc"];
pub const KNOWN_STATUSES: [&str; 3] = ["active", "dormant", "retired"];

/// "One line" made a number. Long enough for scope plus an explicit `Out: ...`
/// clause; short enough that it can't quietly become a summary — which is the
/// thing the whole design refuses to store (threads-architecture.md §1).
pub const CHARTER_MAX_CHARS: usize = 240;

/// Shape checks for a charter's text, shared by `lint`, `open`, `set-charter`,
/// and the `propose` validators — so every door enforces the same sentence.
/// An EMPTY charter is not an error here: existing threads predate the field
/// and only get a lint warning. The write commands require non-empty
/// separately, so nothing new is born without one.
pub fn charter_errors(text: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if text.contains('\n') {
        errors.push("charter must be a single line — it's a scope sentence, not a summary".to_string());
    }
    let len = text.chars().count();
    if len > CHARTER_MAX_CHARS {
        errors.push(format!(
            "charter is {} chars (over the {}-char one-line limit)",
            len, CHARTER_MAX_CHARS
        ));
    }
    errors
}

/// Frontmatter-only checks that don't need the rest of the vault — used both
/// by full `lint` and by the write commands (`open`, `link`, ...) before they
/// commit a change.
pub fn check_frontmatter(
    slug: &str,
    m: &FrontMatter,
    known_fronts: &HashSet<String>,
    known_slugs: &HashSet<String>,
    known_people: &HashSet<String>,
) -> Vec<String> {
    let mut errors = Vec::new();

    if !valid_slug(slug) {
        errors.push(format!(
            "slug `{}` doesn't match ^[a-z0-9-]{{1,40}}$",
            slug
        ));
    }

    if m.name.trim().is_empty() {
        errors.push("name is required and must be non-empty".to_string());
    }

    errors.extend(charter_errors(&m.charter));

    if m.fronts.is_empty() {
        errors.push("fronts must have at least 1 entry — every thread is on at least one front".to_string());
    }
    for f in &m.fronts {
        if !known_fronts.contains(f) {
            let mut known: Vec<&String> = known_fronts.iter().collect();
            known.sort();
            let known_list: Vec<String> = known.into_iter().cloned().collect();
            errors.push(format!(
                "unknown front `{}` — known fronts: {}",
                f,
                known_list.join(", ")
            ));
        }
    }

    for p in &m.parents {
        if p == slug {
            errors.push(format!("thread `{}` lists itself as its own parent", slug));
        } else if !known_slugs.contains(p) {
            errors.push(format!(
                "unknown parent thread `{}` — no Threads/{}.md",
                p, p
            ));
        }
    }

    let mut seen_people: HashSet<&String> = HashSet::new();
    for p in &m.people {
        if !known_people.contains(p) {
            errors.push(format!("unknown person `{}` — no people/{}.md", p, p));
        }
        if !seen_people.insert(p) {
            errors.push(format!("duplicate person `{}` in people:", p));
        }
    }

    if m.kind.trim().is_empty() {
        errors.push("kind is required (standing|arc)".to_string());
    } else if !KNOWN_KINDS.contains(&m.kind.as_str()) {
        errors.push(format!(
            "kind `{}` is not one of: {}",
            m.kind,
            KNOWN_KINDS.join("|")
        ));
    }

    if m.status.trim().is_empty() {
        errors.push("status is required (active|dormant|retired)".to_string());
    } else if m.status == "seedling" {
        errors.push("status `seedling` never appears on disk — seedlings live in the pending queue".to_string());
    } else if !KNOWN_STATUSES.contains(&m.status.as_str()) {
        errors.push(format!(
            "status `{}` is not one of: {}",
            m.status,
            KNOWN_STATUSES.join("|")
        ));
    }

    if m.opened.trim().is_empty() {
        errors.push("opened is required (YYYY-MM-DD)".to_string());
    } else if !is_real_date(&m.opened) {
        errors.push(format!("opened `{}` is not a real YYYY-MM-DD date", m.opened));
    }

    match (&m.retired, m.status.as_str()) {
        (Some(d), "retired") => {
            if !is_real_date(d) {
                errors.push(format!("retired `{}` is not a real YYYY-MM-DD date", d));
            }
        }
        (Some(_), _) => {
            errors.push("retired: is set but status isn't `retired`".to_string());
        }
        (None, "retired") => {
            errors.push("status: retired requires a retired: <date>".to_string());
        }
        (None, _) => {}
    }

    if let Some(d) = &m.distilled {
        if !is_real_date(d) {
            errors.push(format!("distilled `{}` is not a real YYYY-MM-DD date", d));
        }
    }

    errors
}

/// Body checks that need the vault filesystem (source resolution) and the
/// known-slugs set (wikilink warnings).
pub fn check_body(
    tf: &ThreadFile,
    content_dir: &Path,
    known_slugs: &HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut errors = tf.body_errors.clone();
    let mut warnings = Vec::new();

    for sec in &tf.sections {
        for tok in sec.all_tokens() {
            if let Err(msg) = check_source(&tok, content_dir) {
                errors.push(format!("section `{}`: {}", sec.heading, msg));
            }
        }
        for link in sec.all_wikilinks() {
            if !known_slugs.contains(&link) {
                warnings.push(format!(
                    "section `{}`: [[{}]] doesn't match an existing thread — worth opening later",
                    sec.heading, link
                ));
            }
        }
    }
    (errors, warnings)
}

/// Lint one already-parsed file (frontmatter + body), NOT including
/// graph-level (cycle) checks — those need every file at once, see
/// `lint_all`.
pub fn lint_one(
    slug: &str,
    tf: &ThreadFile,
    content_dir: &Path,
    known_fronts: &HashSet<String>,
    known_slugs: &HashSet<String>,
    known_people: &HashSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut errors = tf.fm_errors.clone();
    errors.extend(check_frontmatter(slug, &tf.meta, known_fronts, known_slugs, known_people));
    let mut warnings = tf.fm_warnings.clone();
    // Backfill grace: threads written before charters existed warn rather than
    // fail, so the vault doesn't go red on every file at once. `open` refuses a
    // new thread with no charter, so the warning count only ever goes down.
    if tf.meta.charter.trim().is_empty() {
        warnings.push(
            "no charter — one line of scope (what belongs here, what doesn't) is what makes \
             this thread's cards gradeable; set it with `thread set-charter`"
                .to_string(),
        );
    }
    let (body_errors, body_warnings) = check_body(tf, content_dir, known_slugs);
    errors.extend(body_errors);
    warnings.extend(body_warnings);
    (errors, warnings)
}

/// Build the parent graph from every thread currently on disk (dangling
/// parents just produce an empty adjacency for that entry — the frontmatter
/// check above already flags them).
pub fn build_graph(files: &HashMap<String, FrontMatter>) -> Graph {
    files
        .iter()
        .map(|(slug, m)| (slug.clone(), m.parents.clone()))
        .collect()
}

/// Full `lint`/`validate`: every file in `Threads/`, plus graph-level cycle
/// detection. Returns one report per file plus the standalone cycle errors
/// (attached to whichever slug starts the reported cycle path).
pub fn lint_all(content_dir: &Path, data_dir: &Path) -> Result<Vec<FileReport>, Box<dyn Error>> {
    let tdir = threads_dir(content_dir);
    let slugs = list_thread_slugs(&tdir);
    let known_slugs: HashSet<String> = slugs.iter().cloned().collect();
    let known_fronts: HashSet<String> = load_fronts(data_dir)?.into_iter().collect();
    let known_people: HashSet<String> =
        crate::util::list_people_slugs(&crate::util::people_dir(content_dir))
            .into_iter()
            .collect();

    let mut parsed: HashMap<String, ThreadFile> = HashMap::new();
    let mut metas: HashMap<String, FrontMatter> = HashMap::new();
    for slug in &slugs {
        let path = tdir.join(format!("{}.md", slug));
        let text = fs::read_to_string(&path)?;
        let tf = parse_thread_file(&text);
        metas.insert(slug.clone(), tf.meta.clone());
        parsed.insert(slug.clone(), tf);
    }

    let graph = build_graph(&metas);
    let cycles = find_all_cycles(&graph);

    let mut reports = Vec::new();
    for slug in &slugs {
        let tf = &parsed[slug];
        let (mut errors, warnings) =
            lint_one(slug, tf, content_dir, &known_fronts, &known_slugs, &known_people);
        for cyc in &cycles {
            if cyc.first() == Some(slug) {
                errors.push(format!("cycle in parent graph: {}", cyc.join(" -> ")));
            }
        }
        reports.push(FileReport {
            slug: slug.clone(),
            errors,
            warnings,
        });
    }
    Ok(reports)
}

/// The most recent dated source in a file: max over card-id dates, bare-day
/// dates found in its sections, and `opened`. Used by `--fix-dormancy`.
pub fn most_recent_source_date(tf: &ThreadFile) -> Option<chrono::NaiveDate> {
    let mut best = crate::util::parse_date(&tf.meta.opened);
    for sec in &tf.sections {
        for tok in sec.all_tokens() {
            if let Some(d) = crate::sources::source_date(&tok) {
                best = Some(best.map_or(d, |b| b.max(d)));
            }
        }
    }
    best
}
