/**
 * frontsOverview.ts — the query hook + weighting math behind the Fronts
 * overview page (FrontsOverviewPage.tsx). Talks to /api/fronts/overview
 * (routes/fronts.py), which counts how many live things sit on each front
 * across every surface that tags with the shared vocabulary: to-dos, threads,
 * the buy list, research topics.
 *
 * The only real logic here is `tierFor` — turning a front's share of the
 * heaviest front into a size tier. That's the page's whole thesis: a front's
 * size on screen IS its weight in the data, so the surface reads as a picture
 * of where things currently sit rather than as a menu of twelve equal buttons.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** One front's counts. `sources` keys match the server's `sources` list. */
export interface FrontOverviewEntry {
  id: string;
  name: string;
  total: number;
  sources: Record<string, number>;
}

export interface FrontsOverview {
  fronts: FrontOverviewEntry[];
  /** Surface names, in the order the server counts them. */
  sources: string[];
  /** Per-surface count of live things carrying NO front at all. */
  untagged: Record<string, number>;
  /** Per-surface count of live things, tagged or not — the denominator. */
  totals: Record<string, number>;
  /** front id -> count, for ids in the data but missing from fronts.json. */
  orphans: Record<string, number>;
}

export const FRONTS_OVERVIEW_KEY = ['fronts', 'overview'] as const;

/** Human labels for the surfaces the server counts. */
export const SOURCE_LABELS: Record<string, string> = {
  todos: 'to-dos',
  threads: 'threads',
  buy_list: 'buy list',
  research: 'research',
};

/**
 * Size tiers, largest first. `min` is the front's share of the heaviest
 * front's total — so the scale is always relative to whatever currently
 * dominates, and the picture re-composes itself as life moves rather than
 * being pinned to absolute counts that only ever grow.
 */
export type FrontTier = 'xl' | 'lg' | 'md' | 'sm';

const TIERS: { tier: FrontTier; min: number }[] = [
  { tier: 'xl', min: 0.7 },
  { tier: 'lg', min: 0.35 },
  { tier: 'md', min: 0.15 },
  { tier: 'sm', min: 0 },
];

export function tierFor(total: number, max: number): FrontTier {
  // No data at all → everything sits at the floor rather than every front
  // claiming to be the biggest (0/0 would otherwise read as a full share).
  if (max <= 0 || total <= 0) return 'sm';
  const share = total / max;
  return (TIERS.find((t) => share >= t.min) as { tier: FrontTier }).tier;
}

/** The heaviest front's total — the scale everything else is measured against. */
export function maxTotal(fronts: FrontOverviewEntry[]): number {
  return fronts.reduce((m, f) => (f.total > m ? f.total : m), 0);
}

/** GET /api/fronts/overview */
function getOverview(signal?: AbortSignal): Promise<FrontsOverview> {
  return api.get('/api/fronts/overview', signal);
}

/** Counts move only when the underlying data does — no polling. */
export function useFrontsOverview() {
  return useQuery({
    queryKey: FRONTS_OVERVIEW_KEY,
    queryFn: ({ signal }) => getOverview(signal),
  });
}
