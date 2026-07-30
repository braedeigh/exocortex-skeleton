/**
 * orchestra.ts — the pure marriage behind the Observatory's live "Orchestra"
 * section. Two signals that already exist in the app get combined here, with
 * NO new backend plumbing:
 *
 *   - WHICH sessions are running now  ← the roster (GET /api/observatory,
 *     already `_effective_running`-corrected server-side).
 *   - WHAT each one is writing        ← the terrain payload (GET
 *     /api/observatory/terrain), which live-re-parses a running session's
 *     jsonl and attributes writes/creates/reads per file.
 *
 * The roster is the authority on running-ness; terrain only supplies files.
 * A session that's running but hasn't written anything yet still shows (with an
 * empty file list) — Orchestra never claims more than the data knows.
 *
 * We keep WRITES + CREATES and drop pure reads on purpose: Orchestra shows work
 * being *produced*, not files merely glanced at — the same writing/creating
 * signal S3 (fork-the-work) will read to seed a take-over spinoff.
 */
import type { PendingApproval, SessionMeta } from './api';
import type { TerrainData } from '../terrain/api';

export interface OrchestraFile {
  /** Terrain repo id the file lives under ('skeleton' | 'vault' | …). */
  repo: string;
  /** Repo-relative path. */
  path: string;
  writes: number;
  creates: number;
}

export interface OrchestraRow {
  id: string;
  title: string;
  /** The cached Haiku one-liner of what this session is working on. It rides
   * the roster payload already — the live section just never showed it, so a
   * running card said WHICH files but never WHAT for. */
  summary: string | null;
  /** A turn is running server-side right now (breathing dot). */
  running: boolean;
  /** The question a session raised via request_input, or null. A non-null
   * value makes the card glow orange — it's waiting on her, even if its turn
   * has already ended (that's the whole point: the ask outlives the turn). */
  awaiting: string | null;
  /** A gated command the act-ask gate is blocking on this session, or null.
   * Non-null raises the inline Approve/Deny card — the most urgent state, even
   * above awaiting (she can't do anything until she resolves it). */
  pendingApproval: PendingApproval | null;
  /** The last turn's failure message, or null. Makes the card glow red — the
   * one state that isn't about her attention but about the session being
   * broken, so it outranks unread. */
  error: string | null;
  /** Files this session is writing/creating, most-active first. */
  files: OrchestraFile[];
  fileCount: number;
}

/**
 * Invert the terrain payload into one row per session: the files it's
 * writing/creating, plus its live state. Rows preserve the order they were
 * handed in, so a lane reads the way its roster is sorted; the component
 * floats the ones needing her to the top.
 *
 * Takes WHATEVER sessions it's given — since 07-27 that's every session in a
 * lane, not just the running ones. An idle session simply comes back with an
 * empty file list, which is exactly what the card should render for it.
 */
export function orchestraRows(
  sessions: SessionMeta[],
  terrain: TerrainData | undefined,
): OrchestraRow[] {
  const byId = new Map<string, OrchestraRow>();
  for (const s of sessions) {
    byId.set(s.id, {
      id: s.id,
      title: s.title || s.id,
      summary: s.summary ?? null,
      running: s.running === true,
      awaiting: s.awaiting_input ?? null,
      pendingApproval: s.awaiting_approval ?? null,
      error: s.last_error ?? null,
      files: [],
      fileCount: 0,
    });
  }

  for (const repo of terrain?.repos ?? []) {
    for (const file of repo.files) {
      for (const sess of file.sessions) {
        const row = byId.get(sess.id);
        if (!row) continue; // a footprint from a session that isn't running now
        const writes = sess.writes || 0;
        const creates = sess.creates || 0;
        if (writes + creates <= 0) continue; // read-only touch — not "writing"
        row.files.push({ repo: repo.id, path: file.path, writes, creates });
      }
    }
  }

  for (const row of byId.values()) {
    // Most-active first (writes+creates), then path so equal-weight files sort
    // stably instead of jittering between polls.
    row.files.sort(
      (a, b) =>
        b.writes + b.creates - (a.writes + a.creates) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    row.fileCount = row.files.length;
  }

  return sessions.map((s) => byId.get(s.id)).filter((r): r is OrchestraRow => r != null);
}
