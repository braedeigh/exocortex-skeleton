/**
 * savedView.ts — how the pond was left, and how to say it in a few words.
 *
 * The pond has always remembered its own settings across visits (localStorage,
 * the same house pattern as the collapsible cards remembering open/closed).
 * What's new is that something ELSE now needs to read them: the little pond
 * floating on the terrain map wears its current filters, so she can see from
 * the map what the pond is set to and step back into it exactly as she left
 * it.
 *
 * That's why the key, the shape, and the reading live here instead of inside
 * PondView.tsx. Two components reading one localStorage key by hand is two
 * copies of a magic string free to drift apart — and the failure would be
 * silent and confusing: a landmark cheerfully reporting filters the pond
 * isn't actually using.
 *
 * Touched by: PondView.tsx (writes it, restores from it) and
 * terrain/PondLandmark.tsx (reads it to label itself). `describeSavedView` is
 * pure and tested in savedView.test.ts.
 *
 * Prompt that produced it: "and you can come back out of it with the filters
 * you set if that makes sense. so its floating with the filter display".
 */

// Type-only, so this module stays free of pondMath at runtime — the terrain
// page imports it and has no business pulling the pond's layout engine in.
import type { PondMode } from './pondMath';

/** The three switchable layers of the working half. */
export type WorkLayer = 'turns' | 'writes' | 'sessions';

/** The rail's shelves. */
export type PondGroup = 'front' | 'thread' | 'person' | 'topic';

/** How the pond was left. Every field optional — a saved view written by an
 * older build is read as "whatever it does say", never as a reason to error. */
export interface PondSavedView {
  mode?: PondMode;
  zoom?: number;
  group?: PondGroup;
  hideKeeper?: boolean;
  range?: string;
  /** The lit row's key: `front:<id>`, `tag:<slug>`, `unfiled`, or null. */
  litKey?: string | null;
  /** The lit row's display name, so anything reading this back can SAY what's
   * lit without having to re-fetch the whole thread rail to translate a key
   * into a name. The pond writes it alongside the key. */
  litLabel?: string | null;
  layers?: Partial<Record<WorkLayer, boolean>>;
}

export const POND_VIEW_KEY = 'pond-view';

/** Read the saved view, or an empty one. Never throws: a blocked or corrupt
 * localStorage means the pond opens at its defaults, which is fine. */
export function loadPondView(): PondSavedView {
  try {
    const raw = localStorage.getItem(POND_VIEW_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PondSavedView) : {};
  } catch {
    return {};
  }
}

/**
 * How the LANDMARK's words pane was left — its own key, deliberately.
 *
 * These are facts about a thumbnail on the map (how big she dragged it, how far
 * she'd zoomed its marks, whether she steps by week or month), not about the
 * pond itself. Folding them into PondSavedView would mean the pond's filter
 * chips and the map's furniture shared one blob, and a stale field from one
 * would read as a setting of the other.
 *
 * Not remembered on purpose: the scroll position. The pane opens at NOW every
 * time, because the question it answers when she glances at the map is "what
 * has the pond been doing lately" — landing three months back because that's
 * where she left it a week ago would be the drawing answering a question
 * nobody asked.
 */
export interface PondPaneView {
  /** The drawing box she dragged it to, in CSS px. */
  w?: number;
  h?: number;
  /** Rung of the pane's zoom ladder (pondPane.PANE_ZOOMS). */
  zoom?: number;
  /** What the step arrows move by, and the floor under the colour ramp. */
  jump?: 'week' | 'month';
}

export const POND_PANE_KEY = 'pond-pane';

/** Read the pane's settings, or an empty set. Never throws — a blocked or
 * corrupt localStorage just means the pane opens at its defaults. */
export function loadPondPane(): PondPaneView {
  try {
    const raw = localStorage.getItem(POND_PANE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PondPaneView) : {};
  } catch {
    return {};
  }
}

/** Remember the pane's settings. Silent on failure for the same reason. */
export function savePondPane(view: PondPaneView): void {
  try {
    localStorage.setItem(POND_PANE_KEY, JSON.stringify(view));
  } catch {
    /* a pane that can't remember its size still draws */
  }
}

/** One labelled fact about how the pond is set. */
export interface PondFacet {
  /** What kind of setting — the landmark uses it to give the lit thread its
   * own weight, since that's the one she actually chose rather than a default. */
  kind: 'lit' | 'mode' | 'range' | 'keeper' | 'layers';
  label: string;
}

const RANGE_LABELS: Record<string, string> = {
  all: 'all time',
  '90': '90 days',
  '30': '30 days',
};

/**
 * The saved view as a short list of facets, for the landmark's filter display.
 *
 * Only says what's worth saying. A pond at its defaults — everything lit,
 * arranged by time, all layers on — reports NOTHING, so a landmark she has
 * never filtered stays a quiet little pond instead of wearing a row of chips
 * that all say "normal". Restraint here is what makes the chips mean something
 * when they do appear.
 *
 * Ordered by how much she chose it: the lit thread first (a deliberate act),
 * then the arrangement and window, then the two subtractions.
 */
export function describeSavedView(view: PondSavedView): PondFacet[] {
  const out: PondFacet[] = [];

  if (view.litKey) {
    // The label the pond stored beside the key. A view saved before labels
    // were stored still has the key, and a key is better than silence — strip
    // its prefix so it reads as a name rather than as a database row.
    const named = view.litLabel || view.litKey.replace(/^(front|tag):/, '');
    out.push({ kind: 'lit', label: named });
  }
  if (view.mode === 'words') out.push({ kind: 'mode', label: 'words' });
  if (view.range && view.range !== 'all') {
    out.push({ kind: 'range', label: RANGE_LABELS[view.range] ?? `${view.range} days` });
  }
  if (view.hideKeeper) out.push({ kind: 'keeper', label: 'no Keeper' });

  // The working half only gets a chip when some of it is off — "all three on"
  // is the default and says nothing. Named when it's down to one, counted
  // otherwise, so the chip never grows into a list.
  const layers = view.layers;
  if (layers) {
    const off = (['turns', 'writes', 'sessions'] as WorkLayer[]).filter((k) => layers[k] === false);
    if (off.length === 3) {
      out.push({ kind: 'layers', label: 'journal only' });
    } else if (off.length > 0) {
      const on = (['turns', 'writes', 'sessions'] as WorkLayer[]).filter((k) => layers[k] !== false);
      out.push({
        kind: 'layers',
        label: on.length === 1 ? `${LAYER_NAMES[on[0]]} only` : `${on.length} work layers`,
      });
    }
  }

  return out;
}

const LAYER_NAMES: Record<WorkLayer, string> = {
  turns: 'messages',
  writes: 'files',
  sessions: 'open',
};
