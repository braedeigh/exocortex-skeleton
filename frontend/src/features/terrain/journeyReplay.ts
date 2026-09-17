/**
 * journeyReplay.ts — a captured trace turned into beats the terrain can play.
 *
 * Plain English: a trace (Wiring room, runtime_trace.py) is a list of hops
 * between files with a clock on each. The terrain is a map of those same files
 * as dots. This module lines the two up: for each hop it says WHEN (ms from
 * the start of the whole journey), WHICH DOT lights, and WHICH DOT it came
 * from — so TerrainPage can flash the dot and draw the thread at the right
 * moment, and nothing else. No React, no canvas, no fetching; tested in
 * journeyReplay.test.ts.
 *
 * THE CLOCKS. Every part of a trace has its own zero — the request's
 * perf_counter, the turn process's, the browser's — so their `t0_us` can't be
 * compared directly. What they share is `started_at`, wall-clock ISO with
 * milliseconds, so a part's beats are placed at (its started_at − the root's
 * started_at) + t0. Millisecond-honest across processes; anything finer is
 * the part's own clock and is kept exact within it.
 *
 * WHAT MAKES A BEAT.
 *   - a Python hop: lights `dst`, thread from `src` when there is one;
 *   - a browser click/key/submit whose component resolved to a file: lights it;
 *   - a browser fetch: a thread from the last lit browser file to the entry
 *     file of the request part whose `entry` matches "METHOD path" — the
 *     tap becoming the request, drawn as one thread across the two halves;
 *   - an agent tool call with a repo-relative path: lights that file,
 *     threaded from the turn's own last-lit file (the host script), labelled
 *     with the tool name. A path outside both repos becomes a beat with no
 *     dot — it still counts and is listed, it just has nowhere to land.
 *
 * Dot ids are the terrain's own: `<repo>:file:<path>`.
 */
import type { TraceDetail, TracePart, TraceSpan } from '../wiring/api';

export type BeatKind = 'browser' | 'http' | 'turn' | 'agent';

export interface Beat {
  /** ms from the root's started_at */
  atMs: number;
  /** duration in ms when known */
  durMs: number | null;
  kind: BeatKind;
  /** terrain node id, or null when the hop has no dot on the map */
  nodeId: string | null;
  fromId: string | null;
  label: string;
  partId: string;
}

export function fileNodeId(repo: string, path: string): string {
  return `${repo}:file:${path}`;
}

function partOffsetMs(root: { started_at: string }, part: { started_at: string }): number {
  const a = Date.parse(root.started_at);
  const b = Date.parse(part.started_at);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}

function spanBeats(part: { id: string; spans: TraceSpan[] }, offset: number, kind: BeatKind): Beat[] {
  return part.spans.map((s) => ({
    atMs: offset + s.t0_us / 1000,
    durMs: s.t1_us == null ? null : (s.t1_us - s.t0_us) / 1000,
    kind,
    nodeId: fileNodeId(s.dst_repo, s.dst),
    fromId: s.src && s.src_repo ? fileNodeId(s.src_repo, s.src) : null,
    label: s.dst_func,
    partId: part.id,
  }));
}

/** The dot a request part "starts" at: its first hop's destination. */
function entryNode(part: { spans: TraceSpan[] }): string | null {
  const first = part.spans[0];
  return first ? fileNodeId(first.dst_repo, first.dst) : null;
}

export function buildJourneyBeats(trace: TraceDetail): Beat[] {
  const beats: Beat[] = [];
  const rootKind: BeatKind = trace.kind === 'turn' ? 'turn' : 'http';
  if (trace.kind !== 'journey') beats.push(...spanBeats(trace, 0, rootKind));

  const httpParts = trace.parts.filter((p) => p.kind === 'http');
  const claimed = new Set<string>();

  for (const part of trace.parts) {
    const offset = partOffsetMs(trace, part);
    if (part.kind === 'browser') {
      let lastFile: string | null = null;
      for (const s of part.spans) {
        const at = offset + s.t0_us / 1000;
        const dur = s.t1_us == null ? null : (s.t1_us - s.t0_us) / 1000;
        if (s.src_func === 'fetch') {
          const target = matchRequest(httpParts, claimed, s.dst_func, at, trace);
          beats.push({
            atMs: at,
            durMs: dur,
            kind: 'browser',
            nodeId: target ? entryNode(target) : null,
            fromId: lastFile,
            label: s.dst_func || s.dst,
            partId: part.id,
          });
          continue;
        }
        const node = s.dst_repo !== 'browser' ? fileNodeId(s.dst_repo, s.dst) : null;
        if (node) lastFile = node;
        beats.push({
          atMs: at,
          durMs: dur,
          kind: 'browser',
          nodeId: node,
          fromId: null,
          label: `${s.src_func}: ${s.dst_func || s.src || s.dst}`,
          partId: part.id,
        });
      }
      continue;
    }
    const kind: BeatKind = part.kind === 'turn' ? 'turn' : 'http';
    beats.push(...spanBeats(part, offset, kind));
    if (part.kind === 'turn' && part.agent_calls) {
      const host = part.spans.length ? fileNodeId(part.spans[0].dst_repo, part.spans[0].dst) : null;
      for (const call of part.agent_calls) {
        beats.push({
          atMs: offset + call.t0_us / 1000,
          durMs: null,
          kind: 'agent',
          nodeId: call.repo && call.rel ? fileNodeId(call.repo, call.rel) : null,
          fromId: host,
          label: `${call.name} ${call.rel ?? call.path}`,
          partId: part.id,
        });
      }
    }
  }
  beats.sort((a, b) => a.atMs - b.atMs);
  return beats;
}

/**
 * Which request part a browser fetch became. Matched on entry text ("POST
 * /api/x") and closeness in time, each part claimed once — two identical polls
 * a second apart go to two different parts, in order.
 */
function matchRequest(
  parts: TracePart[],
  claimed: Set<string>,
  label: string,
  atMs: number,
  root: { started_at: string },
): TracePart | null {
  let best: TracePart | null = null;
  let bestGap = Infinity;
  for (const p of parts) {
    if (claimed.has(p.id) || p.entry !== label) continue;
    const gap = Math.abs(partOffsetMs(root, p) - atMs);
    if (gap < bestGap) {
      best = p;
      bestGap = gap;
    }
  }
  if (best) claimed.add(best.id);
  return best;
}

/** Every dot a journey lands on, for pinning them onto the map before play —
 * a file the Files dial cut away can't flash. */
export function beatNodeIds(beats: readonly Beat[]): Set<string> {
  const ids = new Set<string>();
  for (const b of beats) {
    if (b.nodeId) ids.add(b.nodeId);
    if (b.fromId) ids.add(b.fromId);
  }
  return ids;
}

/**
 * Group beats into frames at most `stepMs` apart so a burst of forty hops in
 * two milliseconds becomes one visible flash rather than forty timers.
 * Playback stretches real time by `slow` (1 = real time).
 */
export function scheduleFrames(beats: readonly Beat[], slow = 1, stepMs = 40): { atMs: number; beats: Beat[] }[] {
  const frames: { atMs: number; beats: Beat[] }[] = [];
  for (const b of beats) {
    const at = b.atMs * slow;
    const last = frames[frames.length - 1];
    if (last && at - last.atMs < stepMs) last.beats.push(b);
    else frames.push({ atMs: at, beats: [b] });
  }
  return frames;
}
