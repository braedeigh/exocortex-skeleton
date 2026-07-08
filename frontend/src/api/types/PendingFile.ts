// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.
import type { PendingChange } from "./PendingChange";

/**
 * The root shape of `data/pending_changes.json`: `{"pending": [...]}`.
 */
export type PendingFile = { pending: Array<PendingChange>, };
