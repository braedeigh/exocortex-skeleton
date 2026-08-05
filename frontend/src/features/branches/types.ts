/**
 * types.ts — the shapes routes/branches.py returns. Mirrors it exactly.
 */

/** What a branch is to her — see _state() in routes/branches.py for why
 * `done` is deliberately vaguer than the others. */
export type BranchState = 'waiting' | 'working' | 'taken' | 'empty' | 'done';

export interface BranchSession {
  conversation_id: string;
  title: string | null;
  slug: string | null;
  archived: boolean;
  lane: string | null;
}

export interface NightRun {
  status: string | null;
  note: string | null;
  reason: string | null;
  /** The night crew is the only thing that currently runs the tests itself. */
  tested: boolean;
}

export interface Branch {
  branch: string;
  subject: string;
  committed: string;
  age_days: number | null;
  merged: boolean;
  state: BranchState;
  /** Present only while the session's copy of the app still exists. */
  worktree: string | null;
  session: BranchSession | null;
  night_run: NightRun | null;
  has_report: boolean;
  commits: number;
  diff_stat: string;
  files: string[];
  /** Work in the copy that never reached the branch — a merge would NOT get it. */
  uncommitted: string[];
}

export interface BranchesResponse {
  branches: Branch[];
  worktree_root: string;
}

export interface ReportResponse {
  branch: string;
  slug?: string;
  report: string | null;
  reason?: string;
}
