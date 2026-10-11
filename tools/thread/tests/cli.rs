//! Integration tests — run the built binary against a fresh tempdir copy of
//! `skeleton/tests/fixtures/threads/` (never the fixture dir itself: every
//! write-touching test copies first).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

fn fixtures_src() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/threads")
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let ty = entry.file_type().unwrap();
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// A fresh copy of the shared fixtures in a tempdir, `(content_dir, data_dir)`.
struct Sandbox {
    _tmp: TempDir,
    content: PathBuf,
    data: PathBuf,
}

fn sandbox() -> Sandbox {
    let tmp = TempDir::new().unwrap();
    copy_dir(&fixtures_src(), tmp.path());
    let content = tmp.path().join("content");
    let data = tmp.path().join("data");
    Sandbox { _tmp: tmp, content, data }
}

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_thread"))
}

fn run(sb: &Sandbox, args: &[&str]) -> Output {
    Command::new(bin())
        .arg("--content-dir")
        .arg(&sb.content)
        .arg("--data-dir")
        .arg(&sb.data)
        .args(args)
        .output()
        .expect("failed to run thread binary")
}

fn stdout(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}
fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).to_string()
}

// ═══════════════════════════════════════════════════════════════════════════
//  check-slug
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn check_slug_exists() {
    let sb = sandbox();
    let o = run(&sb, &["check-slug", "topic-b"]);
    assert!(o.status.success());
    assert_eq!(stdout(&o).trim(), "exists");
}

#[test]
fn check_slug_pending() {
    let sb = sandbox();
    let o = run(&sb, &["check-slug", "topic-c"]);
    assert!(o.status.success());
    assert_eq!(stdout(&o).trim(), "pending");
}

/// Append a `deny` decision dated `days_ago` — the denial window is measured
/// against the real clock, so a fixture with a hardcoded date silently stops
/// testing anything 30 days after it's written. Stamp it relative instead.
fn deny_slug_days_ago(sb: &Sandbox, slug: &str, days_ago: i64) -> String {
    let day = (chrono::Local::now() - chrono::Duration::days(days_ago))
        .format("%Y-%m-%d")
        .to_string();
    let line = format!(
        "{{\"ts\": \"{} 09:00:00\", \"action\": \"deny\", \"kind\": \"thread_open\", \
         \"proposed\": {{\"slug\": \"{}\", \"name\": \"X\", \"fronts\": [\"health\"]}}, \
         \"final\": null, \"edited\": false}}\n",
        day, slug
    );
    let path = sb.data.join("decisions.jsonl");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    text.push_str(&line);
    std::fs::write(&path, text).unwrap();
    day
}

#[test]
fn check_slug_denied_recent() {
    let sb = sandbox();
    let day = deny_slug_days_ago(&sb, "fresh-denial", 3);
    let o = run(&sb, &["check-slug", "fresh-denial"]);
    assert!(o.status.success());
    assert_eq!(stdout(&o).trim(), format!("denied:{}", day));
}

#[test]
fn check_slug_denial_expires_after_30_days() {
    let sb = sandbox();
    // old-denied-thread was denied 2025-01-01 — long past 30 days from "now".
    let o = run(&sb, &["check-slug", "old-denied-thread"]);
    assert!(o.status.success());
    assert_eq!(stdout(&o).trim(), "free");
}

#[test]
fn check_slug_free() {
    let sb = sandbox();
    let o = run(&sb, &["check-slug", "brand-new-thread"]);
    assert!(o.status.success());
    assert_eq!(stdout(&o).trim(), "free");
}

/// The 30-day boundary itself, computed relative to the real clock so this
/// test never rots: a denial 29 days ago still counts, one 31 days ago
/// doesn't. Uses its own scratch data dir instead of the shared fixture so
/// it's independent of when the shared fixture's fixed dates were written.
#[test]
fn check_slug_denial_boundary_is_relative_to_now() {
    let sb = sandbox();
    let today = chrono::Local::now().date_naive();
    let recent = today - chrono::Duration::days(29);
    let old = today - chrono::Duration::days(31);
    let jsonl = format!(
        "{{\"ts\": \"{} 10:00:00\", \"action\": \"deny\", \"kind\": \"thread_open\", \"proposed\": {{\"slug\": \"recent-deny\"}}, \"final\": null, \"edited\": false}}\n\
         {{\"ts\": \"{} 10:00:00\", \"action\": \"deny\", \"kind\": \"thread_open\", \"proposed\": {{\"slug\": \"old-deny\"}}, \"final\": null, \"edited\": false}}\n",
        recent.format("%Y-%m-%d"),
        old.format("%Y-%m-%d"),
    );
    std::fs::write(sb.data.join("decisions.jsonl"), jsonl).unwrap();

    let o1 = run(&sb, &["check-slug", "recent-deny"]);
    assert!(stdout(&o1).trim().starts_with("denied:"), "{}", stdout(&o1));

    let o2 = run(&sb, &["check-slug", "old-deny"]);
    assert_eq!(stdout(&o2).trim(), "free");
}

// ═══════════════════════════════════════════════════════════════════════════
//  lint — every error class, plus a clean file staying clean
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn lint_fails_on_the_fixture_vault_due_to_broken_thread() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    assert!(!o.status.success());
    let out = stdout(&o);
    assert!(out.contains("broken-thread.md"));
}

#[test]
fn lint_catches_missing_source() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("no source line"), "{}", out);
}

#[test]
fn lint_catches_four_line_statement() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("over the 3-line limit"), "{}", out);
}

#[test]
fn lint_catches_bad_front() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("unknown front `nope`"), "{}", out);
}

#[test]
fn lint_catches_dangling_parent() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("unknown parent thread `ghost-parent`"), "{}", out);
}

#[test]
fn lint_catches_body_metadata() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("metadata belongs in frontmatter only"), "{}", out);
}

#[test]
fn lint_catches_duplicate_heading() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("duplicate heading"), "{}", out);
}

#[test]
fn lint_catches_retired_without_date() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("status: retired requires a retired"), "{}", out);
}

#[test]
fn lint_catches_frozen_casefile_source() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    assert!(out.contains("frozen casefile"), "{}", out);
}

#[test]
fn lint_reports_dangling_wikilink_as_warning_not_error() {
    let sb = sandbox();
    let o = run(&sb, &["lint"]);
    let out = stdout(&o);
    // topic-b.md links [[other-topic]], which doesn't exist as a fixture thread.
    assert!(out.contains("[[other-topic]]"), "{}", out);
    assert!(out.contains("topic-b.md: warning:"), "{}", out);
}

#[test]
fn topic_b_thread_alone_is_clean() {
    // Remove the broken fixture so we can assert the *valid* thread lints
    // clean on its own (isolating it from the deliberately-broken file).
    let sb = sandbox();
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["lint", "--quiet"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
}

// ═══════════════════════════════════════════════════════════════════════════
//  cycle detection
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn link_refuses_a_direct_cycle() {
    let sb = sandbox();
    // mid-thread already has parent root-thread; adding mid as root's parent
    // closes a direct 2-cycle.
    let o = run(&sb, &["link", "--slug", "root-thread", "--add-parent", "mid-thread"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("cycle"), "{}", stderr(&o));
}

#[test]
fn link_refuses_a_transitive_cycle() {
    let sb = sandbox();
    // root -> (nothing) currently; leaf -> mid -> root already. Adding
    // leaf-thread as root's parent closes root -> leaf -> mid -> root.
    let o = run(&sb, &["link", "--slug", "root-thread", "--add-parent", "leaf-thread"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("cycle"), "{}", stderr(&o));
}

#[test]
fn link_allows_a_non_cyclic_parent_add() {
    let sb = sandbox();
    let o = run(&sb, &["link", "--slug", "root-thread", "--add-parent", "topic-a"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/root-thread.md")).unwrap();
    assert!(text.contains("parents: [topic-a]"));
}

// ═══════════════════════════════════════════════════════════════════════════
//  people: cast membership — open --people, link --add-person/--remove-person
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn open_with_people_writes_canonical_frontmatter_and_reparses_the_same_list() {
    let sb = sandbox();
    let o = run(
        &sb,
        &[
            "open",
            "--slug",
            "new-cast-thread",
            "--name",
            "New Cast Thread",
            "--charter",
            "A test thread — what belongs here. Out: everything else.",
            "--fronts",
            "health",
            "--kind",
            "standing",
            "--people",
            "alex",
            "--people",
            "jordan",
        ],
    );
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    let text = std::fs::read_to_string(sb.content.join("Threads/new-cast-thread.md")).unwrap();
    // Canonical position: immediately after parents:, before kind:, same
    // inline-list style as parents.
    let lines: Vec<&str> = text.lines().collect();
    let parents_idx = lines.iter().position(|l| l.starts_with("parents:")).unwrap();
    assert_eq!(lines[parents_idx + 1], "people: [alex, jordan]");
    assert_eq!(lines[parents_idx + 2], "kind: standing");

    // Re-parse (via lint, which reads the file back through the same parser)
    // yields the same list — round-trip stability.
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["lint", "--quiet"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
}

#[test]
fn open_with_nonexistent_person_is_refused() {
    let sb = sandbox();
    let o = run(
        &sb,
        &[
            "open",
            "--slug",
            "bad-cast-thread",
            "--name",
            "Bad Cast Thread",
            "--charter",
            "A test thread — what belongs here. Out: everything else.",
            "--fronts",
            "health",
            "--kind",
            "standing",
            "--people",
            "nobody",
        ],
    );
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown person `nobody` — no people/nobody.md"), "{}", stderr(&o));
    assert!(!sb.content.join("Threads/bad-cast-thread.md").exists());
}

#[test]
fn link_add_and_remove_person_mutate_the_cast_in_place() {
    let sb = sandbox();
    // topic-b.md starts with people: [alex] in the fixture.
    let o = run(&sb, &["link", "--slug", "topic-b", "--add-person", "jordan"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains("people: [alex, jordan]"), "{}", text);

    let o = run(&sb, &["link", "--slug", "topic-b", "--remove-person", "alex"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains("people: [jordan]"), "{}", text);
}

#[test]
fn link_add_person_refuses_a_nonexistent_person() {
    let sb = sandbox();
    let o = run(&sb, &["link", "--slug", "topic-b", "--add-person", "nobody"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown person `nobody` — no people/nobody.md"), "{}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains("people: [alex]"), "file changed despite refusal: {}", text);
}

// ═══════════════════════════════════════════════════════════════════════════
//  round-trip stability: parse -> serialize -> parse is identity, with and
//  without a people: cast.
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn round_trip_is_stable_with_people_present() {
    let sb = sandbox();
    let before = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(before.contains("people: [alex]"));

    // distill only touches the distilled: watermark, reserializing the rest
    // of the frontmatter verbatim through parse -> render — a clean way to
    // exercise the round trip without changing the cast itself.
    let o = run(&sb, &["distill", "topic-b"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let after = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(after.contains("people: [alex]"), "{}", after);

    // Round again through set-status and back — people: must survive intact.
    let o = run(&sb, &["set-status", "topic-b", "dormant"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let o = run(&sb, &["set-status", "topic-b", "active"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let final_text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(final_text.contains("people: [alex]"), "{}", final_text);
}

#[test]
fn round_trip_is_stable_with_people_absent() {
    let sb = sandbox();
    // root-thread.md has no people: key in the fixture at all.
    let before = std::fs::read_to_string(sb.content.join("Threads/root-thread.md")).unwrap();
    assert!(!before.contains("people:"));

    let o = run(&sb, &["distill", "root-thread"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let after = std::fs::read_to_string(sb.content.join("Threads/root-thread.md")).unwrap();
    // Once written by this binary, an absent cast serializes as people: []
    // (same empty-handling as parents:).
    assert!(after.contains("people: []"), "{}", after);
    assert!(after.contains("parents: []"), "{}", after);
}

// ═══════════════════════════════════════════════════════════════════════════
//  propose
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn propose_thread_open_appends_under_lock() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "new-topic",
        "name": "New Topic",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "3 cards across 2 days.",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    let pending_text = std::fs::read_to_string(sb.data.join("pending_changes.json")).unwrap();
    let pending: serde_json::Value = serde_json::from_str(&pending_text).unwrap();
    let arr = pending["pending"].as_array().unwrap();
    assert_eq!(arr.len(), 2); // the fixture's topic-c entry + this one
    let new_entry = arr.iter().find(|e| e["payload"]["slug"] == "new-topic").unwrap();
    assert_eq!(new_entry["kind"], "thread_open");
    assert!(new_entry["summary"].as_str().unwrap().contains("New Topic"));
}

#[test]
fn propose_thread_open_with_people_validates() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "new-topic-with-cast",
        "name": "New Topic With Cast",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "people": ["alex", "jordan"],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "3 cards across 2 days.",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
}

#[test]
fn propose_thread_open_with_a_bad_person_is_refused() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "new-topic-bad-cast",
        "name": "New Topic Bad Cast",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "people": ["nobody"],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "3 cards across 2 days.",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown person `nobody`"), "{}", stderr(&o));
}

#[test]
fn propose_refuses_a_slug_that_already_exists() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "topic-b",
        "name": "Topic B Again",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "x",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("not free"), "{}", stderr(&o));
}

#[test]
fn propose_refuses_a_slug_that_is_already_pending() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "topic-c",
        "name": "Topic C",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "x",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("pending"), "{}", stderr(&o));
}

#[test]
fn propose_refuses_evidence_from_a_single_day() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "single-day-thread",
        "name": "Single Day Thread",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "x",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("distinct day"), "{}", stderr(&o));
}

#[test]
fn propose_accepts_evidence_that_is_entirely_bare_days() {
    // The regression that motivated card -> source + loosened validation: the
    // card pool only starts partway through the journal, so evidence for a
    // retrospective sweep has to be able to cite bare days that predate it
    // (no card exists for them at all), not just card ids.
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "bare-day-thread",
        "name": "Bare Day Thread",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "predates the card pool",
        "evidence": [
            {"source": "2026-02-27", "date": "2026-02-27", "quote": "a"},
            {"source": "2026-05-12", "date": "2026-05-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
}

#[test]
fn propose_refuses_evidence_citing_a_nonexistent_day() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "nonexistent-evidence-thread",
        "name": "Nonexistent Evidence Thread",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "x",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2099-01-01", "date": "2099-01-01", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("evidence[1].source"), "{}", stderr(&o));
}

#[test]
fn propose_reads_json_from_stdin_with_dash() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "stdin-topic",
        "name": "Stdin Topic",
        "charter": "A test thread — what belongs here. Out: everything else.",
        "fronts": ["health"],
        "parents": [],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "x",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    use std::io::Write;
    let mut child = Command::new(bin())
        .arg("--content-dir")
        .arg(&sb.content)
        .arg("--data-dir")
        .arg(&sb.data)
        .args(["propose", "thread_open", "--json", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
}

#[test]
fn propose_thread_link_valid_and_refuses_empty_ops() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "topic-b",
        "add_fronts": ["practice"],
        "rationale": "testing"
    });
    let o = run(&sb, &["propose", "thread_link", "--json", &payload.to_string()]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
    assert!(stdout(&o).contains("+front:practice"), "{}", stdout(&o));

    let empty_ops = serde_json::json!({ "slug": "topic-b", "rationale": "testing" });
    let o = run(&sb, &["propose", "thread_link", "--json", &empty_ops.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("must be non-empty"), "{}", stderr(&o));
}

#[test]
fn propose_thread_link_refuses_unknown_thread() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "nope-thread",
        "add_fronts": ["health"],
        "rationale": "x"
    });
    let o = run(&sb, &["propose", "thread_link", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown thread"), "{}", stderr(&o));
}

#[test]
fn propose_thread_retire_valid_and_refuses_bad_date() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "topic-b",
        "reason": "resolved",
        "last_card_date": "2026-07-14"
    });
    let o = run(&sb, &["propose", "thread_retire", "--json", &payload.to_string()]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    let bad = serde_json::json!({
        "slug": "topic-b",
        "reason": "resolved",
        "last_card_date": "not-a-date"
    });
    let o = run(&sb, &["propose", "thread_retire", "--json", &bad.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("not a real"), "{}", stderr(&o));
}

// ═══════════════════════════════════════════════════════════════════════════
//  open / add-card / set-status / distill round-trip
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn open_add_card_set_status_distill_round_trip_relints_clean() {
    let sb = sandbox();

    let o = run(
        &sb,
        &[
            "open",
            "--slug",
            "new-standing",
            "--name",
            "New Standing",
            "--charter",
            "A test thread — what belongs here. Out: everything else.",
            "--fronts",
            "health",
            "--kind",
            "standing",
        ],
    );
    assert!(o.status.success(), "open: {}", stderr(&o));
    assert!(sb.content.join("Threads/new-standing.md").exists());

    let o = run(
        &sb,
        &[
            "add-card",
            "--slug",
            "new-standing",
            "--section",
            "What it is",
            "--text",
            "A fresh thread with one cited fact.",
            "--source",
            "2026-07-08.1841b",
        ],
    );
    assert!(o.status.success(), "add-card: {}", stderr(&o));

    let o = run(&sb, &["set-status", "new-standing", "dormant"]);
    assert!(o.status.success(), "set-status: {}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/new-standing.md")).unwrap();
    assert!(text.contains("status: dormant"));

    let o = run(&sb, &["distill", "new-standing"]);
    assert!(o.status.success(), "distill: {}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/new-standing.md")).unwrap();
    assert!(text.contains(&format!("distilled: {}", chrono::Local::now().format("%Y-%m-%d"))));

    // Remove the deliberately-broken fixture thread so only files this test
    // cares about are linted.
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["lint", "--quiet"]);
    assert!(o.status.success(), "post-roundtrip lint: {}\n{}", stdout(&o), stderr(&o));
}

#[test]
fn set_status_retired_stamps_date_and_unretiring_clears_it() {
    let sb = sandbox();
    let o = run(&sb, &["set-status", "topic-b", "retired"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains(&format!("retired: {}", chrono::Local::now().format("%Y-%m-%d"))));

    let o = run(&sb, &["set-status", "topic-b", "active"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains("retired:\n") || text.contains("retired:\r\n"));
}

// ═══════════════════════════════════════════════════════════════════════════
//  set-name
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn set_name_renames_in_place_leaving_body_and_other_frontmatter_untouched() {
    let sb = sandbox();
    let before = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();

    let o = run(&sb, &["set-name", "--slug", "topic-b", "--name", "Topic B Renamed"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    let after = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(after.contains("name: Topic B Renamed"), "{}", after);
    assert!(!after.contains("name: Topic B\n"), "{}", after);

    // Everything else — other frontmatter fields and the body — is untouched.
    let before_sans_name: Vec<&str> = before.lines().filter(|l| !l.starts_with("name:")).collect();
    let after_sans_name: Vec<&str> = after.lines().filter(|l| !l.starts_with("name:")).collect();
    assert_eq!(before_sans_name, after_sans_name);

    let changelog = std::fs::read_to_string(sb.content.join("_system/cricket_changelog.md")).unwrap();
    assert!(changelog.contains("thread-rename"), "{}", changelog);
    assert!(changelog.contains("**topic-b**"), "{}", changelog);
    assert!(changelog.contains("Topic B"), "{}", changelog);
    assert!(changelog.contains("Topic B Renamed"), "{}", changelog);
}

#[test]
fn set_name_on_a_nonexistent_slug_is_refused() {
    let sb = sandbox();
    let o = run(&sb, &["set-name", "--slug", "no-such-thread", "--name", "Anything"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown thread `no-such-thread`"), "{}", stderr(&o));
    assert!(stderr(&o).contains("no Threads/no-such-thread.md"), "{}", stderr(&o));
}

#[test]
fn set_name_round_trips_apostrophe_and_ampersand() {
    let sb = sandbox();
    let tricky_name = "Mom & the family's non-acceptance";
    let o = run(&sb, &["set-name", "--slug", "topic-b", "--name", tricky_name]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains(&format!("name: {}\n", tricky_name)), "{}", text);

    // Re-parse through the same model the binary uses for every other
    // command (lint reads it back through parse_thread_file) — the name
    // must come back exactly, and the file must still lint clean.
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["lint", "--quiet"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));

    // distill re-renders the whole frontmatter from the parsed struct — if
    // the apostrophe/ampersand had been mis-parsed or mis-escaped, this
    // second round trip would show it.
    let o = run(&sb, &["distill", "topic-b"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/topic-b.md")).unwrap();
    assert!(text.contains(&format!("name: {}\n", tricky_name)), "{}", text);
}

// ═══════════════════════════════════════════════════════════════════════════
//  add-card refusals
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn add_card_refuses_duplicate_heading() {
    let sb = sandbox();
    let o = run(
        &sb,
        &[
            "add-card",
            "--slug",
            "topic-b",
            "--section",
            "What it is",
            "--text",
            "Trying to reuse an existing heading.",
            "--source",
            "2026-07-08.1841b",
        ],
    );
    assert!(!o.status.success());
    assert!(stderr(&o).contains("duplicate heading"), "{}", stderr(&o));
}

#[test]
fn add_card_refuses_over_three_lines() {
    let sb = sandbox();
    let o = run(
        &sb,
        &[
            "add-card",
            "--slug",
            "topic-b",
            "--section",
            "Brand New Section",
            "--text",
            "line one\nline two\nline three\nline four",
            "--source",
            "2026-07-08.1841b",
        ],
    );
    assert!(!o.status.success());
    assert!(stderr(&o).contains("3-line limit"), "{}", stderr(&o));
}

#[test]
fn add_card_refuses_unresolvable_source() {
    let sb = sandbox();
    let o = run(
        &sb,
        &[
            "add-card",
            "--slug",
            "topic-b",
            "--section",
            "Brand New Section",
            "--text",
            "A fact with a source that doesn't exist.",
            "--source",
            "2099-01-01.zzzz",
        ],
    );
    assert!(!o.status.success());
    assert!(stderr(&o).contains("not found"), "{}", stderr(&o));
}

#[test]
fn add_card_refuses_on_retired_thread() {
    let sb = sandbox();
    let o = run(&sb, &["set-status", "topic-b", "retired"]);
    assert!(o.status.success());
    let o = run(
        &sb,
        &[
            "add-card",
            "--slug",
            "topic-b",
            "--section",
            "Brand New Section",
            "--text",
            "A fact added after retirement.",
            "--source",
            "2026-07-08.1841b",
        ],
    );
    assert!(!o.status.success());
    assert!(stderr(&o).contains("retired"), "{}", stderr(&o));
}

// ═══════════════════════════════════════════════════════════════════════════
//  inbox
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn inbox_filters_by_distilled_watermark_and_sorts_oldest_first() {
    let sb = sandbox();
    // topic-b.md: distilled 2026-07-10. Tagged cards: 2026-07-05 (before,
    // excluded), 2026-07-12 and 2026-07-14 (after, included, oldest first).
    let o = run(&sb, &["inbox", "topic-b"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let out = stdout(&o);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{:?}", lines);
    assert!(lines[0].starts_with("2026-07-12.1200a\t"));
    assert!(lines[1].starts_with("2026-07-14.1655c\t"));
    assert!(!out.contains("2026-07-05.0900a"));
}

#[test]
fn inbox_exits_zero_when_empty() {
    let sb = sandbox();
    let o = run(&sb, &["inbox", "topic-a"]);
    assert!(o.status.success(), "{}", stderr(&o));
    assert_eq!(stdout(&o).trim(), "");
}

// ═══════════════════════════════════════════════════════════════════════════
//  remove
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn remove_deletes_the_file_and_writes_a_changelog_line() {
    let sb = sandbox();
    // leaf-thread has no children (nothing lists it as a parent) — safe to remove.
    assert!(sb.content.join("Threads/leaf-thread.md").exists());
    let o = run(&sb, &["remove", "leaf-thread", "--reason", "smoke test cleanup"]);
    assert!(o.status.success(), "stdout: {}\nstderr: {}", stdout(&o), stderr(&o));
    assert!(!sb.content.join("Threads/leaf-thread.md").exists());

    let changelog = std::fs::read_to_string(sb.content.join("_system/cricket_changelog.md")).unwrap();
    assert!(changelog.contains("thread-remove"), "{}", changelog);
    assert!(changelog.contains("**leaf-thread**"), "{}", changelog);
    assert!(changelog.contains("smoke test cleanup"), "{}", changelog);
}

#[test]
fn remove_is_refused_when_another_thread_names_it_as_a_parent() {
    let sb = sandbox();
    // mid-thread is root-thread's child (mid-thread.md has parents: [root-thread]);
    // leaf-thread is mid-thread's child. Removing root-thread must be refused
    // and must name mid-thread as the offending child.
    let o = run(&sb, &["remove", "root-thread", "--reason", "no longer needed"]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("mid-thread"), "{}", stderr(&o));
    assert!(sb.content.join("Threads/root-thread.md").exists());
}

// ═══════════════════════════════════════════════════════════════════════════
//  validate is a lint alias
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn validate_matches_lint_pass_fail() {
    let sb = sandbox();
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["validate", "--quiet"]);
    assert!(o.status.success(), "{}", stderr(&o));
}

// ═══════════════════════════════════════════════════════════════════════════
//  charter — the one line of scope a thread's cards get graded against.
//  Required at birth, warned about on files that predate it, and the only
//  frontmatter value that is prose (so quoting is part of the contract).
// ═══════════════════════════════════════════════════════════════════════════

/// A charter with a comma AND a colon AND a quote in it — the exact shape that
/// would be mis-read as a list (Rust side) or split on the colon (Python side)
/// if it weren't written quoted.
const TRICKY_CHARTER: &str =
    "Sleep itself: onset, waking, dreams. Out: the \"tired all day\" thread, and meds.";

fn open_with_charter(sb: &Sandbox, slug: &str, charter: &str) -> std::process::Output {
    run(
        sb,
        &[
            "open", "--slug", slug, "--name", "Charter Test",
            "--charter", charter, "--fronts", "health", "--kind", "standing",
        ],
    )
}

#[test]
fn open_refuses_an_empty_charter() {
    let sb = sandbox();
    let o = open_with_charter(&sb, "no-charter-thread", "   ");
    assert!(!o.status.success());
    assert!(stderr(&o).contains("--charter is required"), "{}", stderr(&o));
    assert!(!sb.content.join("Threads/no-charter-thread.md").exists());
}

#[test]
fn open_refuses_a_charter_over_the_length_limit() {
    let sb = sandbox();
    let long = "x".repeat(241);
    let o = open_with_charter(&sb, "long-charter-thread", &long);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("over the 240-char one-line limit"), "{}", stderr(&o));
}

#[test]
fn charter_round_trips_commas_colons_and_quotes() {
    let sb = sandbox();
    let o = open_with_charter(&sb, "sleep", TRICKY_CHARTER);
    assert!(o.status.success(), "{}", stderr(&o));

    // On disk: quoted, inner quotes escaped, on one line directly under name:.
    let text = std::fs::read_to_string(sb.content.join("Threads/sleep.md")).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let name_idx = lines.iter().position(|l| l.starts_with("name:")).unwrap();
    assert!(lines[name_idx + 1].starts_with("charter: \""), "{}", text);
    assert!(lines[name_idx + 1].ends_with('"'), "{}", text);
    assert!(lines[name_idx + 1].contains("\\\""), "escaped inner quote missing: {}", text);

    // Read back through a command that reserializes the whole file: the charter
    // survives byte-for-byte, so parse and render really are inverses.
    let o = run(&sb, &["set-name", "--slug", "sleep", "--name", "Sleep"]);
    assert!(o.status.success(), "{}", stderr(&o));
    let after = std::fs::read_to_string(sb.content.join("Threads/sleep.md")).unwrap();
    assert_eq!(
        after.lines().find(|l| l.starts_with("charter:")),
        text.lines().find(|l| l.starts_with("charter:")),
    );
}

#[test]
fn lint_warns_but_does_not_fail_on_a_thread_with_no_charter() {
    let sb = sandbox();
    // leaf-thread.md is the fixture deliberately left uncharted — old threads
    // predate the field and must not turn the whole vault red.
    std::fs::remove_file(sb.content.join("Threads/broken-thread.md")).unwrap();
    let o = run(&sb, &["lint"]);
    assert!(o.status.success(), "warnings must not fail the lint: {}", stderr(&o));
    let out = stdout(&o);
    assert!(out.contains("leaf-thread.md: warning: no charter"), "{}", out);
    // Every other fixture IS charted, so exactly one file carries this warning
    // (the vault's other warnings are dangling-wikilink ones on topic-b).
    assert_eq!(out.matches("warning: no charter").count(), 1, "{}", out);
}

#[test]
fn set_charter_backfills_then_recuts_in_place() {
    let sb = sandbox();
    let before = std::fs::read_to_string(sb.content.join("Threads/leaf-thread.md")).unwrap();

    let o = run(&sb, &["set-charter", "--slug", "leaf-thread", "--charter", TRICKY_CHARTER]);
    assert!(o.status.success(), "{}", stderr(&o));
    assert!(stdout(&o).contains("charter set"), "{}", stdout(&o));

    let after = std::fs::read_to_string(sb.content.join("Threads/leaf-thread.md")).unwrap();
    // Body and every other frontmatter field untouched. `people:` is filtered
    // alongside `charter:` because ANY write command reserializes the file
    // through the canonical renderer, so a fixture predating the people: field
    // gains an empty one here — a pre-existing normalization, not this command.
    let strip = |t: &str| -> Vec<String> {
        t.lines()
            .filter(|l| !l.starts_with("charter:") && !l.starts_with("people:"))
            .map(str::to_string)
            .collect()
    };
    assert_eq!(strip(&before), strip(&after));

    // Re-cutting an existing charter reports differently and overwrites.
    let o = run(&sb, &["set-charter", "--slug", "leaf-thread", "--charter", "A narrower scope. Out: the rest."]);
    assert!(o.status.success(), "{}", stderr(&o));
    assert!(stdout(&o).contains("charter re-cut"), "{}", stdout(&o));
    let text = std::fs::read_to_string(sb.content.join("Threads/leaf-thread.md")).unwrap();
    assert!(text.contains("charter: \"A narrower scope. Out: the rest.\""), "{}", text);

    let changelog = std::fs::read_to_string(sb.content.join("_system/cricket_changelog.md")).unwrap();
    assert!(changelog.contains("thread-charter"), "{}", changelog);
}

#[test]
fn set_charter_refuses_removal_and_bad_slugs() {
    let sb = sandbox();
    let o = run(&sb, &["set-charter", "--slug", "leaf-thread", "--charter", "  "]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("can be re-cut but not removed"), "{}", stderr(&o));

    let o = run(&sb, &["set-charter", "--slug", "no-such-thread", "--charter", "Anything. Out: nothing."]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("unknown thread `no-such-thread`"), "{}", stderr(&o));
}

#[test]
fn propose_thread_open_without_a_charter_is_refused() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "uncharted-topic",
        "name": "Uncharted Topic",
        "fronts": ["health"],
        "kind": "standing",
        "proposer": "cricket-health",
        "rationale": "3 cards across 2 days.",
        "evidence": [
            {"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"},
            {"source": "2026-07-12.1200a", "date": "2026-07-12", "quote": "b"}
        ]
    });
    let o = run(&sb, &["propose", "thread_open", "--json", &payload.to_string()]);
    assert!(!o.status.success());
    assert!(stderr(&o).contains("`charter` is required"), "{}", stderr(&o));
}

#[test]
fn propose_thread_link_accepts_a_charter_recut_on_its_own() {
    let sb = sandbox();
    let payload = serde_json::json!({
        "slug": "topic-b",
        "charter": "A re-cut scope for the topic-b thread. Out: the parent subject.",
        "rationale": "The week showed this thread is narrower than its charter says.",
        "evidence": [{"source": "2026-07-05.0900a", "date": "2026-07-05", "quote": "a"}]
    });
    let o = run(&sb, &["propose", "thread_link", "--json", &payload.to_string()]);
    assert!(o.status.success(), "{}", stderr(&o));
    assert!(stdout(&o).contains("charter"), "{}", stdout(&o));
}
