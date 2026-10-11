/**
 * journeyMath.ts — what one journey did to the creek.
 *
 * Plain English: the creek draws every file that touches the store on the
 * left, every collection on the right, ribbons between. A journey is one
 * recorded action (runtime_trace.py): the files its requests and turn ran
 * through, and the store writes the journal saw while it ran. This module
 * turns that into "which rows and ribbons to light" — pure arithmetic, no
 * React, tested in journeyMath.test.ts.
 *
 * Two grades of lit, kept apart on purpose:
 *   - `exact`    a WRITE ribbon whose file the journey ran through AND whose
 *                collection the write journal saw change inside the window.
 *                Two independent records agree; this happened.
 *   - `possible` a READ ribbon whose file the journey ran through. Reads
 *                leave nothing in the journal, so the most the evidence says
 *                is "this file ran and it has a read call to that collection".
 * Anything else is dimmed. A written collection whose writer the trace didn't
 * cross (a background job writing during the window) is lit on the right
 * bank with no ribbon — true, and honestly unattributed.
 *
 * Files are matched on the skeleton repo's relative path — the creek's static
 * scan and the tracer both key by it. Agent tool calls are NOT files "run":
 * editing store.py isn't store.py running, so they don't light anything here.
 */
import type { CreekFile } from './api';
import type { TraceDetail } from '../wiring/api';

export type JourneyLit = 'exact' | 'possible';

export interface JourneySets {
  /** repo-relative paths the journey's Python ran through */
  files: Set<string>;
  /** collections the write journal saw change in the window */
  written: Set<string>;
  /** `${path} ${collection} ${kind}` -> grade */
  ribbons: Map<string, JourneyLit>;
  /** writes the journal saw whose caller file the trace never crossed */
  unattributed: string[];
}

export function ribbonKey(path: string, collection: string, kind: 'write' | 'read'): string {
  return `${path} ${collection} ${kind}`;
}

export function journeySets(trace: TraceDetail | null | undefined, files: readonly CreekFile[]): JourneySets | null {
  if (!trace) return null;
  const ran = new Set<string>();
  for (const part of [trace, ...trace.parts]) {
    if (part.kind === 'browser') continue;
    for (const s of part.spans) {
      if (s.dst_repo === 'skeleton') ran.add(s.dst);
      if (s.src_repo === 'skeleton' && s.src) ran.add(s.src);
    }
  }
  const written = new Set<string>();
  for (const w of trace.writes ?? []) if (w.collection) written.add(w.collection);

  const ribbons = new Map<string, JourneyLit>();
  const attributed = new Set<string>();
  for (const f of files) {
    if (!ran.has(f.path)) continue;
    for (const call of f.calls) {
      const kind = call.verb === 'read' ? 'read' : 'write';
      if (kind === 'write') {
        if (written.has(call.collection)) {
          ribbons.set(ribbonKey(f.path, call.collection, 'write'), 'exact');
          attributed.add(call.collection);
        }
      } else {
        ribbons.set(ribbonKey(f.path, call.collection, 'read'), 'possible');
      }
    }
  }
  const unattributed = [...written].filter((c) => !attributed.has(c)).sort();
  return { files: ran, written, ribbons, unattributed };
}
