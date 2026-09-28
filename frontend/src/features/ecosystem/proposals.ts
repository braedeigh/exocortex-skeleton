/**
 * proposals.ts — the machine's suggested sources, as the pages read them.
 *
 * The research pass proposes where a food comes from; the checker tests each
 * answer. Every live proposal is shown, marked as the machine's and not yet
 * approved by her — including the ones the checker failed, with its reasons.
 * They arrive as `eco_proposals` on /api/data/ecosystem (all of them, owner
 * only) and as `proposals` on /api/food/page (one food and its products).
 * Server side: proposalstore.py live().
 *
 * This file holds the shape, the words for each check status, and the
 * grouping the review page and the "N waiting" chip use. Tested in
 * proposals.test.ts. Drawn by ProposalList.tsx.
 */

export type ProposalCheck = 'unchecked' | 'passed' | 'failed';

/** One piece of evidence behind a proposal, with the checker's verdict on it. */
export interface ProposalEvidence {
  entry_id: number;
  role: 'usda' | 'web' | 'model' | string;
  check_status: ProposalCheck;
  check_reason: string | null;
  kind: string | null;
  text: string;
  url: string;
}

/** One ingredient of a multi-ingredient product, and where it's from. */
export interface ProposalPart {
  seq: number;
  ingredient: string;
  food_id: number | null;
  place: string | null;
  transparency: string | null;
  geo_source: string | null;
  health_concern: string | null;
  health_basis: string | null;
  note: string | null;
}

/** One live proposal: a suggested place for a food, a product, or a fix to
 * one of her sources (amends_source_id). */
export interface EcoProposal {
  id: number;
  food_id: number | null;
  product_id: number | null;
  request_id: number | null;
  amends_source_id: string | null;
  name: string;
  note: string | null;
  lat: number | null;
  lng: number | null;
  precision: string | null;
  radius_km: number | null;
  area_kind: string | null;
  region_name: string | null;
  country: string | null;
  transparency: string | null;
  geo_source: 'proxy' | 'guess' | string | null;
  origin: string | null;
  origin_detail: string | null;
  origin_url: string | null;
  origin_date: string | null;
  usda_commodity: string | null;
  summary: string | null;
  check_status: ProposalCheck;
  check_reason: string | null;
  checked_at: string | null;
  counties: string[];
  parts: ProposalPart[];
  evidence: ProposalEvidence[];
}

/** The words each check status wears, everywhere a proposal is shown. */
export const CHECK_WORDS: Record<ProposalCheck, string> = {
  unchecked: 'not checked yet',
  passed: 'checked by machine, not by you',
  failed: 'failed the check',
};

/** Order for the review list: passed first (closest to ready), failed last. */
const CHECK_ORDER: Record<ProposalCheck, number> = { passed: 0, unchecked: 1, failed: 2 };

/** Group proposals by the food they're about, busiest food first. Proposals
 * with no food (a fix to a source, a lone product) share the null group. */
export function groupByFood(proposals: EcoProposal[]): { foodId: number | null; proposals: EcoProposal[] }[] {
  const groups = new Map<number | null, EcoProposal[]>();
  for (const proposal of proposals) {
    const key = proposal.food_id ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(proposal);
  }
  return [...groups.entries()]
    .map(([foodId, list]) => ({
      foodId,
      proposals: [...list].sort((a, b) => CHECK_ORDER[a.check_status] - CHECK_ORDER[b.check_status] || a.id - b.id),
    }))
    .sort((a, b) => (a.foodId === null ? 1 : b.foodId === null ? -1 : b.proposals.length - a.proposals.length));
}

/** Count proposals per food id — what the "N waiting" chips show. */
export function waitingByFood(proposals: EcoProposal[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const proposal of proposals) {
    if (proposal.food_id == null) continue;
    counts.set(proposal.food_id, (counts.get(proposal.food_id) ?? 0) + 1);
  }
  return counts;
}
