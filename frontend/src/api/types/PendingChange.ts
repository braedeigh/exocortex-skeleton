// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.
import type { ChangeKind } from "./ChangeKind";
import type { PendingStatus } from "./PendingStatus";
import type { JsonValue } from "./serde_json/JsonValue";

/**
 * A staged change awaiting (or past) approval.
 */
export type PendingChange = { id: string, proposer: string, kind: ChangeKind, payload: JsonValue, status: PendingStatus, note?: string | null, created_at: string, decided_at?: string | null, applied_at?: string | null, error?: string | null, };
