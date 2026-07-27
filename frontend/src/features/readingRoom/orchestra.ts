/**
 * orchestra.ts — the pure marriage behind the Observatory's live "Orchestra"
 * section. Two signals that already exist in the app get combined here, with
 * NO new backend plumbing:
 *
 *   - WHICH sessions are running now  ← the roster (GET /api/reading-room,
 *     already `_effective_running`-corrected server-side).
 *   - WHAT each one is writing        ← the terrain payload (GET
 *     /api/reading-room/terrain), which live-re-parses a running session's
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
import type { SessionMeta } from './api';
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
  /** A turn is running server-side right now (breathing dot). */
  running: boolean;
  /** The question a session raised via request_input, or null. A non-null
   * value makes the card glow orange — it's waiting on her, even if its turn
   * has already ended (that's the whole point: the ask outlives the turn). */
  awaiting: string | null;
  /** Files this session is writing/creating, most-active first. */
  files: OrchestraFile[];
  fileCount: number;
}

/**
 * Invert the terrain payload into one row per Orchestra session (running OR
 * awaiting her input): the files that session is writing/creating, plus its
 * live state. Rows preserve the roster's order, so the section reads the same
 * way the roster does; the component floats the awaiting ones to the top.
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
      running: s.running === true,
      awaiting: s.awaiting_input ?? null,
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
