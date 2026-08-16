//! The thread file shape: frontmatter + fact-card body. This module owns
//! parsing AND serializing — the two must be exact inverses of each other,
//! because this binary is the only writer and the format is the contract
//! routes/threads.py (and the lint in this crate) parses.

use std::path::Path;

use crate::sources::{extract_tokens, extract_wikilinks};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub name: String,
    /// One line of scope: what belongs in this thread and what doesn't. This is
    /// the only *judgment* stored in a thread file — everything else here is
    /// identity, membership, or lifecycle. It exists so "is this thread
    /// capturing what it's supposed to?" is a checkable question instead of a
    /// matter of taste: a grader compares a card against this sentence. May be
    /// empty on files written before charters existed; `lint` warns, and
    /// `open` refuses to create a new thread without one.
    pub charter: String,
    pub aliases: Vec<String>,
    pub fronts: Vec<String>,
    pub parents: Vec<String>,
    /// The thread's cast — person-file slugs (`people/<slug>.md`) this thread
    /// is about. People are NOT threads; they're assigned into threads here.
    /// Optional, may be empty.
    pub people: Vec<String>,
    pub kind: String,
    pub status: String,
    pub opened: String,
    pub retired: Option<String>,
    pub distilled: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Bullet {
    pub text: String,
    pub tokens: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone)]
pub struct Section {
    pub heading: String,
    pub statement_lines: Vec<String>,
    pub source_tokens: Vec<String>,
    pub bullets: Vec<Bullet>,
}

impl Section {
    /// Every backtick token this section cites (statement + bullets).
    pub fn all_tokens(&self) -> Vec<String> {
        let mut out = self.source_tokens.clone();
        for b in &self.bullets {
            out.extend(b.tokens.clone());
        }
        out
    }

    pub fn all_wikilinks(&self) -> Vec<String> {
        let mut out = Vec::new();
        for l in &self.statement_lines {
            out.extend(extract_wikilinks(l));
        }
        for b in &self.bullets {
            out.extend(extract_wikilinks(&b.text));
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct ThreadFile {
    pub meta: FrontMatter,
    pub sections: Vec<Section>,
    /// Body-level errors found while parsing (preamble prose, stray heading
    /// levels, duplicate headings, malformed lines) — collected here so
    /// `lint` and the write commands share exactly one parser.
    pub body_errors: Vec<String>,
    pub fm_errors: Vec<String>,
    pub fm_warnings: Vec<String>,
    /// Always empty today — wikilink warnings need the known-slugs set, which
    /// this module doesn't have; `lint::check_body` computes them separately
    /// from `Section::all_wikilinks()`. Kept on the struct so the parser's
    /// full result shape (errors AND warnings, frontmatter AND body) stays
    /// visible at the type level even though nothing reads it yet.
    #[allow(dead_code)]
    pub body_warnings: Vec<String>,
    /// The raw body text (after frontmatter), used verbatim by commands that
    /// only touch frontmatter (link/set-status/distill) so untouched bodies
    /// are never lossily reserialized.
    pub raw_body: String,
}

/// Split `key: value` / `key: [a, b, c]` frontmatter into a map, preserving
/// nothing but the last value per key (mirrors entities.py's `_parse_frontmatter`
/// forgivingness — a file with a repeated key isn't this parser's problem to
/// flag, lint doesn't check for it).
fn parse_kv_block(block: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in block.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    out
}

fn parse_list(val: &str) -> Vec<String> {
    let v = val.trim();
    let v = v.strip_prefix('[').unwrap_or(v);
    let v = v.strip_suffix(']').unwrap_or(v);
    if v.trim().is_empty() {
        return Vec::new();
    }
    v.split(',')
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn format_list(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

/// The charter is the one frontmatter value that is *prose* — it carries commas
/// and colons, and both tiny frontmatter parsers that read these files (the one
/// above, and `_parse_frontmatter` in routes/entities.py) would otherwise read a
/// comma as a list separator. So it's always written double-quoted with inner
/// quotes backslash-escaped, and unquoted again on the way in.
fn quote_scalar(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unquote_scalar(v: &str) -> String {
    let t = v.trim();
    if t.len() < 2 || !t.starts_with('"') || !t.ends_with('"') {
        return t.to_string();
    }
    let mut out = String::new();
    let mut chars = t[1..t.len() - 1].chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Parse the full text of a `Threads/<slug>.md` file into a `ThreadFile`,
/// collecting (not raising on) every rule violation so `lint` can report all
/// of them in one pass. `known_slugs` and `known_fronts` are used for the
/// membership checks (parents exist, fronts known).
pub fn parse_thread_file(text: &str) -> ThreadFile {
    let mut fm_errors = Vec::new();
    let mut fm_warnings = Vec::new();

    let (meta, raw_body) = if text.starts_with("---") {
        let lines: Vec<&str> = text.lines().collect();
        match lines.iter().skip(1).position(|l| l.trim() == "---") {
            None => {
                fm_errors.push("frontmatter opened with `---` but never closed".to_string());
                (FrontMatter::default(), text.to_string())
            }
            Some(rel_end) => {
                let end = rel_end + 1;
                let block = lines[1..end].join("\n");
                let kv = parse_kv_block(&block);
                let mut m = FrontMatter::default();
                let known_keys = [
                    "name", "charter", "aliases", "fronts", "parents", "people", "kind",
                    "status", "opened", "retired", "distilled",
                ];
                for (k, v) in kv {
                    match k.as_str() {
                        "name" => m.name = v,
                        "charter" => m.charter = unquote_scalar(&v),
                        "aliases" => m.aliases = parse_list(&v),
                        "fronts" => m.fronts = parse_list(&v),
                        "parents" => m.parents = parse_list(&v),
                        "people" => m.people = parse_list(&v),
                        "kind" => m.kind = v,
                        "status" => m.status = v,
                        "opened" => m.opened = v,
                        "retired" => {
                            m.retired = if v.trim().is_empty() { None } else { Some(v) }
                        }
                        "distilled" => {
                            m.distilled = if v.trim().is_empty() { None } else { Some(v) }
                        }
                        other => {
                            if !known_keys.contains(&other) {
                                fm_warnings.push(format!("unknown frontmatter key `{}`", other));
                            }
                        }
                    }
                }
                let body = after_frontmatter(text, end);
                (m, body)
            }
        }
    } else {
        fm_errors.push("no frontmatter block (`---` header) found".to_string());
        (FrontMatter::default(), text.to_string())
    };

    let (sections, body_errors, body_warnings) = parse_body(&raw_body);

    ThreadFile {
        meta,
        sections,
        body_errors,
        fm_errors,
        fm_warnings,
        body_warnings,
        raw_body,
    }
}

/// `text` lines, `close_idx` = the index (into `text.lines()`) of the closing
/// `---`. Returns everything after that line.
fn after_frontmatter(text: &str, close_idx: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if close_idx + 1 >= lines.len() {
        return String::new();
    }
    lines[close_idx + 1..].join("\n")
}

static BOLD_META_RE_SRC: &str = r"^\*\*[^*\n]+:\*\*";

pub fn is_bold_metadata(line: &str) -> bool {
    regex::Regex::new(BOLD_META_RE_SRC).unwrap().is_match(line.trim())
}

/// Body grammar: only `## Heading` sections, no preamble, one heading = one
/// section, each section = 1-3 prose lines + >=1 source line + optional
/// bullets (each carrying its own inline source).
fn parse_body(body: &str) -> (Vec<Section>, Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let warnings: Vec<String> = Vec::new();
    let mut sections = Vec::new();
    let mut seen_headings = std::collections::HashSet::new();

    let lines: Vec<&str> = body.lines().map(|l| l.trim_end()).collect();

    // Find section boundaries.
    let mut first_seen = false;
    let mut i = 0usize;
    while i < lines.len() {
        let raw = lines[i];
        let s = raw.trim();
        if s.is_empty() {
            i += 1;
            continue;
        }
        if s.starts_with("## ") {
            first_seen = true;
            let heading = s[3..].trim().to_string();
            // Gather this section's lines up to the next heading.
            let mut j = i + 1;
            let mut inner: Vec<&str> = Vec::new();
            while j < lines.len() {
                let t = lines[j].trim();
                if t.starts_with('#') {
                    break;
                }
                if !t.is_empty() {
                    inner.push(lines[j]);
                }
                j += 1;
            }
            let dup = seen_headings.contains(&heading);
            if dup {
                errors.push(format!("duplicate heading `## {}`", heading));
            } else {
                seen_headings.insert(heading.clone());
            }
            let (sec, mut errs) = parse_section(&heading, &inner);
            errors.append(&mut errs);
            if !dup {
                sections.push(sec);
            }
            i = j;
            continue;
        }
        if !first_seen {
            errors.push(format!(
                "preamble content before the first `## ` section (no H1, no prose): `{}`",
                s
            ));
            first_seen = true; // report once
            i += 1;
            continue;
        }
        if s.starts_with('#') {
            errors.push(format!(
                "only `## Heading` sections are allowed, found: `{}`",
                s
            ));
            i += 1;
            continue;
        }
        // A non-heading, non-blank line reached with no open section: stray content.
        errors.push(format!("stray line outside any `## ` section: `{}`", s));
        i += 1;
    }

    // Wikilink + bold-metadata warnings/errors are collected in parse_section
    // itself and folded into `errors`/`warnings` here via the section outputs.
    for sec in &sections {
        for l in &sec.statement_lines {
            if is_bold_metadata(l) {
                errors.push(format!(
                    "section `{}`: metadata belongs in frontmatter only (`{}`)",
                    sec.heading, l
                ));
            }
        }
        for b in &sec.bullets {
            if is_bold_metadata(&b.text) {
                errors.push(format!(
                    "section `{}`: metadata belongs in frontmatter only (`{}`)",
                    sec.heading, b.raw
                ));
            }
        }
    }
    // Wikilink warnings need the known-thread-slugs set, which this module
    // doesn't have — `lint.rs` computes them from `Section::all_wikilinks()`.
    (sections, errors, warnings)
}

enum LineKind {
    Arrow,
    Bullet,
    Prose,
}

fn classify_line(l: &str) -> LineKind {
    let t = l.trim();
    if t.starts_with('\u{2192}') {
        LineKind::Arrow
    } else if t.starts_with("- ") || t == "-" {
        LineKind::Bullet
    } else {
        LineKind::Prose
    }
}

fn parse_section(heading: &str, inner: &[&str]) -> (Section, Vec<String>) {
    let mut errors = Vec::new();
    let mut idx = 0usize;
    let mut statement_lines = Vec::new();

    while idx < inner.len() {
        match classify_line(inner[idx]) {
            LineKind::Prose => {
                statement_lines.push(inner[idx].trim().to_string());
                idx += 1;
            }
            _ => break,
        }
    }
    if statement_lines.is_empty() {
        errors.push(format!(
            "section `{}` has no statement prose before its source line",
            heading
        ));
    }
    if statement_lines.len() > 3 {
        errors.push(format!(
            "section `{}` statement is {} lines (over the 3-line limit)",
            heading,
            statement_lines.len()
        ));
    }

    let mut source_tokens = Vec::new();
    let mut saw_arrow = false;
    while idx < inner.len() {
        match classify_line(inner[idx]) {
            LineKind::Arrow => {
                saw_arrow = true;
                let toks = extract_tokens(inner[idx]);
                if toks.is_empty() {
                    errors.push(format!(
                        "section `{}` source line has no backtick token(s): `{}`",
                        heading,
                        inner[idx].trim()
                    ));
                }
                source_tokens.extend(toks);
                idx += 1;
            }
            _ => break,
        }
    }
    if !saw_arrow {
        errors.push(format!(
            "section `{}` statement has no source line (`\u{2192} ...`) — a fact with no source is not a fact",
            heading
        ));
    }

    let mut bullets = Vec::new();
    while idx < inner.len() {
        match classify_line(inner[idx]) {
            LineKind::Bullet => {
                let raw = inner[idx].trim().to_string();
                let after_dash = raw.strip_prefix('-').unwrap_or(&raw).trim();
                // Split on the arrow marker to separate bullet prose from its
                // trailing source token(s).
                if let Some(pos) = after_dash.find('\u{2192}') {
                    let (text_part, src_part) = after_dash.split_at(pos);
                    let toks = extract_tokens(src_part);
                    if toks.is_empty() {
                        errors.push(format!(
                            "section `{}` bullet has no backtick token(s) after its arrow: `{}`",
                            heading, raw
                        ));
                    }
                    bullets.push(Bullet {
                        text: text_part.trim().to_string(),
                        tokens: toks,
                        raw,
                    });
                } else {
                    errors.push(format!(
                        "section `{}` bullet carries no trailing source: `{}`",
                        heading, raw
                    ));
                    bullets.push(Bullet {
                        text: after_dash.to_string(),
                        tokens: Vec::new(),
                        raw,
                    });
                }
                idx += 1;
            }
            _ => break,
        }
    }

    if idx != inner.len() {
        errors.push(format!(
            "section `{}` has an unexpected line after its bullets: `{}`",
            heading,
            inner[idx].trim()
        ));
    }

    let sec = Section {
        heading: heading.to_string(),
        statement_lines,
        source_tokens,
        bullets,
    };
    (sec, errors)
}

// ── Serialization: the ONE canonical shape this binary ever writes. ─────────
pub fn render_frontmatter(m: &FrontMatter) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", m.name));
    if m.charter.trim().is_empty() {
        out.push_str("charter:\n");
    } else {
        out.push_str(&format!("charter: {}\n", quote_scalar(&m.charter)));
    }
    out.push_str(&format!("aliases: {}\n", format_list(&m.aliases)));
    out.push_str(&format!("fronts: {}\n", format_list(&m.fronts)));
    out.push_str(&format!("parents: {}\n", format_list(&m.parents)));
    out.push_str(&format!("people: {}\n", format_list(&m.people)));
    out.push_str(&format!("kind: {}\n", m.kind));
    out.push_str(&format!("status: {}\n", m.status));
    out.push_str(&format!("opened: {}\n", m.opened));
    out.push_str(&kv_line("retired", m.retired.as_deref()));
    out.push_str(&kv_line("distilled", m.distilled.as_deref()));
    out.push_str("---\n");
    out
}

/// `key: value\n`, or bare `key:\n` when there's no value — matches the type
/// specimen (`retired:` with nothing after it, not a trailing space).
fn kv_line(key: &str, val: Option<&str>) -> String {
    match val {
        Some(v) if !v.is_empty() => format!("{}: {}\n", key, v),
        _ => format!("{}:\n", key),
    }
}

/// Render a whole file: frontmatter + raw body verbatim.
pub fn render_file(m: &FrontMatter, raw_body: &str) -> String {
    let mut out = render_frontmatter(m);
    let body = raw_body.trim_start_matches('\n');
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body.trim_end());
        out.push('\n');
    }
    out
}

/// Render one new `## Heading` section (statement + source line) the way
/// `add-card` appends it.
pub fn render_section(section: &str, text: &str, sources: &[String]) -> String {
    let mut out = String::new();
    out.push_str(&format!("## {}\n", section));
    for line in text.lines() {
        out.push_str(line.trim());
        out.push('\n');
    }
    let toks: Vec<String> = sources.iter().map(|s| format!("`{}`", s)).collect();
    out.push_str(&format!("\u{2192} {}\n", toks.join(" \u{b7} ")));
    out
}

/// Where an existing file's body ends without a trailing blank line, so a new
/// section can be appended cleanly.
pub fn append_section(existing_body: &str, new_section: &str) -> String {
    let mut body = existing_body.trim_end().to_string();
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(new_section.trim_end());
    body.push('\n');
    body
}

pub fn load_thread(path: &Path) -> std::io::Result<ThreadFile> {
    let text = std::fs::read_to_string(path)?;
    Ok(parse_thread_file(&text))
}

/// Every `## Heading` already in a raw body — used by `add-card` to refuse a
/// duplicate without needing the full section parse (and its error plumbing).
pub fn existing_headings(raw_body: &str) -> std::collections::HashSet<String> {
    raw_body
        .lines()
        .filter_map(|l| l.trim().strip_prefix("## ").map(|h| h.trim().to_string()))
        .collect()
}
