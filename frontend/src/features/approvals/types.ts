/**
 * types.ts — pending-approval wire shapes + the per-kind editor contract.
 *
 * `PendingChange` mirrors the hand-maintained vendored type in
 * `src/api/types/PendingChange.ts` but is copied here with fields relaxed to
 * what the live writers actually produce, verified against:
 *   - tools/add-todo/src/main.rs — the only stager today writes
 *     `{ id, kind, summary, payload, created }`
 *   - routes/pending.py — reads only `id` / `kind` / `payload`
 *   - static/js/pending.js + static/js/approvals/*.js — read
 *     `id` / `kind` / `payload` / `summary`
 *
 * The vendored `ChangeKind` union ("todo" | "life_todo" | "life_remove" |
 * "unknown") only covers kinds routes/pending.py::_commit can apply
 * server-side. Crickets also stage "food", "symptoms" and "contact", which
 * commit through their own native endpoints client-side — so `kind` is an
 * open string here (with `ChangeKind` kept for autocomplete).
 */
import type { ComponentType } from 'react';
import type { ChangeKind } from '../../api/types/ChangeKind';
import type { PendingStatus } from '../../api/types/PendingStatus';
import type { JsonValue } from '../../api/types/serde_json/JsonValue';

export type { ChangeKind, PendingStatus, JsonValue };

/** One staged change in the approval queue. */
export interface PendingChange {
  id: string;
  /** Open superset of the vendored ChangeKind — see header comment. */
  kind: ChangeKind | (string & {});
  payload: JsonValue;
  /** One-line human summary written by the stager. */
  summary?: string | null;
  /** Stamped by tools/add-todo (`YYYY-MM-DD HH:MM`). */
  created?: string | null;
  // Vendored lifecycle fields (src/api/types/PendingChange.ts) — not written
  // by today's stager; kept optional so richer stagers keep type-checking.
  proposer?: string | null;
  status?: PendingStatus | null;
  note?: string | null;
  created_at?: string | null;
  decided_at?: string | null;
  applied_at?: string | null;
  error?: string | null;
}

/** Root of GET /api/pending — `{"pending": [...]}` (see api/types/PendingFile.ts). */
export interface PendingQueue {
  pending: PendingChange[];
}

// ── Per-kind editor contract (the React port of window._approvalEditors) ────

/** What a per-kind editor hands the host when the user taps Approve. */
export interface ApprovalCommitPlan {
  /** What the user actually kept — logged to the decisions ledger as `final`. */
  final: Record<string, JsonValue>;
  /**
   * Commit through the kind's NATIVE endpoint (the same one that kind's
   * native editor uses). Resolves to the undo offered on the toast, or null
   * for no undo. Throw/reject to leave the item queued — the host surfaces
   * the error and keeps the editor open.
   */
  commit: () => Promise<ApprovalUndo | null>;
  /** Toast text after a successful commit, e.g. `Logged food for 2026-07-09`. */
  toastMessage: string;
  /**
   * Default true: after commit() succeeds the host POSTs /api/pending/deny to
   * drop the queue entry (legacy ApprovalKit.removeFromQueue). The generic
   * fallback sets false — its /api/pending/approve commits AND dequeues
   * server-side in one call.
   */
  dequeue?: boolean;
}

export type ApprovalUndo =
  /** Real reversal — an endpoint call that puts the old state back. */
  | { run: () => Promise<void> }
  /** Best-effort — reopen this change's editor. Legacy symptoms flow when no
   * prior row existed: there is no /api/symptoms DELETE, so a newly created
   * row can't be erased cleanly. */
  | { reopen: true };

export interface ApprovalEditorProps {
  change: PendingChange;
  /** True while the host is mid-request — editors disable their actions. */
  busy: boolean;
  onApprove: (plan: ApprovalCommitPlan) => void;
  onDeny: () => void;
}

/** A registry entry: sheet title + the editor component for one change kind. */
export interface ApprovalEditorEntry {
  /** Sheet title, e.g. "Log food? ✍️" (the legacy modal titles). */
  title: string;
  Editor: ComponentType<ApprovalEditorProps>;
}
