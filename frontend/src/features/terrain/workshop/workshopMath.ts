import type { TerrainData } from '../api';
import type { FlowEvent } from '../flow/api';
import { sessionLastSeconds } from '../terrainGraph';

/**
 * workshopMath.ts — the pure logic under the Workshop room (WorkshopPage.tsx):
 * which files make up an agent's working set and in what order, where the
 * newest edit sits inside a file's text, and what window of lines a side
 * panel should show. No React, no fetching — tested in workshopMath.test.ts.
 *
 * Prompt that produced it: "a UI where i can open all the code in panels that
 * something has been writing on … highlight the panels that were last
 * touched … the last edited code will be on the left and there will be
 * panels for the rest of the code".
 */

/** One file an agent has been writing, with everything the room needs to
 * order and label its panel. */
export interface WorkingFile {
  repo: string;
  path: string;
  /** Unix seconds of the newest touch — terrain history or a live flow
   * event, whichever is fresher. null = the payload couldn't date it. */
  last: number | null;
  writes: number;
  creates: number;
  /** The newest flow event on this file, when one is in the window — the
   * live edge: its snippet is what the hero scrolls to and highlights. */
  event: FlowEvent | null;
}

const fileKey = (repo: string, path: string): string => `${repo}:${path}`;

/**
 * The agent's working set: every file it has WRITTEN (reads are context, not
 * work — the room is "code it's been writing on"), newest touch first.
 * Terrain attribution gives the whole history; flow events (already filtered
 * to this agent by the caller) refresh recency on the live edge and carry the
 * newest edit's text.
 */
export function agentWorkingSet(
  data: TerrainData | undefined,
  convId: string,
  agentEvents: FlowEvent[],
): WorkingFile[] {
  const byFile = new Map<string, WorkingFile>();
  for (const repo of data?.repos ?? []) {
    for (const file of repo.files) {
      const sess = file.sessions.find((s) => s.id === convId);
      if (!sess || (sess.writes ?? 0) + (sess.creates ?? 0) === 0) continue;
      byFile.set(fileKey(repo.id, file.path), {
        repo: repo.id,
        path: file.path,
        last: sessionLastSeconds(sess.last),
        writes: sess.writes ?? 0,
        creates: sess.creates ?? 0,
        event: null,
      });
    }
  }
  // The live edge: an event may refresh a known file or introduce one the
  // terrain payload hasn't attributed yet (a write seconds old).
  for (const ev of agentEvents) {
    const key = fileKey(ev.repo, ev.path);
    const cur = byFile.get(key);
    if (!cur) {
      byFile.set(key, {
        repo: ev.repo,
        path: ev.path,
        last: ev.epoch,
        writes: 1,
        creates: ev.kind === 'create' ? 1 : 0,
        event: ev,
      });
      continue;
    }
    if (cur.event === null || ev.epoch > cur.event.epoch) cur.event = ev;
    if (cur.last === null || ev.epoch > cur.last) cur.last = ev.epoch;
  }
  return [...byFile.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
}

/** Inclusive line range, 0-indexed. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Where a written snippet landed in the file's current text — the hero
 * panel's scroll target. Lines are compared TRIMMED (the file has real
 * indentation; a snippet's may have been mangled in transit), and the match
 * anchors on the snippet's first non-empty line, preferring the candidate
 * spot where the most following lines also agree — a one-line anchor alone
 * can hit the wrong `}` in a big file. null = the text isn't there (the file
 * has moved on since the edit).
 */
export function findSnippetRange(content: string, snippet: string): LineRange | null {
  const contentLines = content.split('\n');
  const snippetLines = snippet.split('\n');
  const firstIdx = snippetLines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return null;
  const anchor = snippetLines[firstIdx].trim();
  const rest = snippetLines.slice(firstIdx).map((l) => l.trim());

  let best: { start: number; score: number } | null = null;
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== anchor) continue;
    let score = 0;
    for (let j = 0; j < rest.length && i + j < contentLines.length; j++) {
      if (contentLines[i + j].trim() === rest[j]) score++;
    }
    if (!best || score > best.score) best = { start: i, score };
  }
  if (!best) return null;
  const end = Math.min(best.start + rest.length - 1, contentLines.length - 1);
  return { start: best.start, end };
}

/**
 * The side panel's porthole: a window of lines around the newest edit —
 * glanceable, not the whole document (reading whole files is the hero's
 * job). With no located edit it shows the file's head instead, which in this
 * codebase is the plain-English block — the file introducing itself.
 */
export function portholeWindow(
  totalLines: number,
  range: LineRange | null,
  size = 20,
): LineRange {
  if (totalLines <= 0) return { start: 0, end: 0 };
  if (range === null) return { start: 0, end: Math.min(size - 1, totalLines - 1) };
  const mid = Math.floor((range.start + range.end) / 2);
  let start = Math.max(0, mid - Math.floor(size / 2));
  const end = Math.min(totalLines - 1, start + size - 1);
  start = Math.max(0, Math.min(start, end - size + 1));
  return { start, end };
}
