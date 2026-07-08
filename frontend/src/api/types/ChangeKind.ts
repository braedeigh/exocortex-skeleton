// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.

/**
 * What kind of change is staged. Mirrors the `kind` strings understood by
 * `routes/pending.py::_commit`.
 */
export type ChangeKind = "todo" | "life_todo" | "life_remove" | "unknown";
