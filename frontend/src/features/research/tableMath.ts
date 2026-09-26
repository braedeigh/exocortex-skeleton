/**
 * tableMath.ts — the arithmetic behind the research tables page, kept apart
 * from the page so it can be tested on its own.
 *
 * Three jobs: how a grid cell reads at a glance (its headline number and the
 * one review state that colours it), and how the hazard map — where a hazard
 * may have several parents — flattens into an indented list the page can
 * draw. Used by TablesPage.tsx and HazardMap.tsx; the shapes come from
 * types.ts (served by routes/research_tables.py).
 *
 * Built on the owner's ask: research tables her agents fill and she reviews,
 * with contaminants grouped by type.
 */

import type { CellEntry, Hazard, MeasureKind, MeasureSummary, Review } from './types';

/** "12 ppb", "89.1%" — a number and its unit, trimmed to what reads. */
export function formatAmount(amount: number, unit: string): string {
  const shown = Number.isInteger(amount) ? String(amount) : String(Number(amount.toPrecision(4)));
  return unit === '%' ? `${shown}%` : `${shown} ${unit}`;
}

/** Plain words for the kinds of number. */
export const MEASURE_WORDS: Record<MeasureKind, string> = {
  concentration: 'how much (ppb)',
  detection_rate: 'how often found (%)',
};

/** Whether a cell entry is a measurement (the other kind is a verdict). */
export function isMeasure(entry: CellEntry): entry is MeasureSummary {
  return 'amount' in entry;
}

/** The one review state a cell is coloured by — the one that most needs
 * her: anything disputed, else anything unreviewed, else confirmed. */
export function cellReview(entries: CellEntry[]): Review {
  if (entries.some((entry) => entry.review === 'disputed')) return 'disputed';
  if (entries.some((entry) => entry.review === 'unreviewed')) return 'unreviewed';
  return 'confirmed';
}

/** The number a measures cell leads with: the largest of the kind the table
 * shows (the server sends them largest first), or of the first kind present
 * when the table shows every kind — ppb and % never get compared. */
export function cellHeadline(entries: MeasureSummary[], measure: MeasureKind | null): MeasureSummary | null {
  if (!entries.length) return null;
  const kind = measure ?? entries[0].measure;
  return entries.find((entry) => entry.measure === kind) ?? entries[0];
}

/** One line of the drawn hazard map. */
export interface MapLine {
  hazard: Hazard;
  depth: number;
  /** A key unique per line: a hazard with two parents draws twice. */
  key: string;
}

/** The hazard map as an indented list, top-level hazards first, each family
 * followed by its members. A hazard with two parents appears under both —
 * that is what the map means — and the path in `key` keeps them apart. */
export function mapLines(hazards: Hazard[]): MapLine[] {
  const byName = (a: Hazard, b: Hazard) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const children = new Map<number, Hazard[]>();
  for (const hazard of hazards) {
    for (const parent of hazard.parents) {
      const list = children.get(parent) ?? [];
      list.push(hazard);
      children.set(parent, list);
    }
  }
  const lines: MapLine[] = [];
  // A depth-first walk; `path` guards against a loop the server should
  // already have refused.
  const walk = (hazard: Hazard, depth: number, path: string) => {
    lines.push({ hazard, depth, key: path });
    for (const child of (children.get(hazard.id) ?? []).slice().sort(byName)) {
      if (!path.split('/').includes(String(child.id))) walk(child, depth + 1, `${path}/${child.id}`);
    }
  };
  for (const top of hazards.filter((hazard) => hazard.parents.length === 0).sort(byName)) {
    walk(top, 0, String(top.id));
  }
  return lines;
}

/** A hazard and everything below it — the hazards that can't become its
 * parent, since that would make a loop. */
export function hazardAndBelow(hazards: Hazard[], id: number): Set<number> {
  const below = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const hazard of hazards) {
      if (!below.has(hazard.id) && hazard.parents.some((parent) => below.has(parent))) {
        below.add(hazard.id);
        grew = true;
      }
    }
  }
  return below;
}
