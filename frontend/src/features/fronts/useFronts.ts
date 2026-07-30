/**
 * useFronts.ts — the shared "fronts" vocabulary (routes/fronts.py,
 * fronts.json): a small set of life-domain tags (health, appearance,
 * finances, living-space, job, hobbies, learning, exocortex) used across
 * features. Originally lived in the research feature (it backs topic
 * tagging there); the todos feature also tags each to-do, via a `fronts`
 * LIST on the item — an item can sit on several fronts at once (see
 * todoHelpers.itemFronts) — so the query hook + label helpers moved here to
 * be shared rather than duplicated.
 *
 * Every front id used out in the data must exist in fronts.json. FocusChips
 * builds its chip row by mapping over THIS vocabulary, so an item tagged with
 * an id that isn't here gets no chip — and because it does have a front, it
 * doesn't fall into "Other" either. It goes reachable only from "All".
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** A shared life-domain vocabulary entry (routes/fronts.py, fronts.json). */
export interface Front {
  id: string;
  name: string;
  created?: string;
}

export const FRONTS_KEY = ['fronts'] as const;

/** GET /api/fronts -> {fronts: Front[]} */
function getFronts(signal?: AbortSignal): Promise<{ fronts: Front[] }> {
  return api.get('/api/fronts', signal);
}

/** The shared fronts vocabulary — rarely changes, no polling. */
export function useFronts() {
  return useQuery({
    queryKey: FRONTS_KEY,
    queryFn: async ({ signal }) => (await getFronts(signal)).fronts ?? [],
  });
}

export const FRONT_EMOJI: Record<string, string> = {
  health: '🩺',
  appearance: '💄',
  finances: '💵',
  'living-space': '🏠',
  job: '💼',
  hobbies: '🎨',
  learning: '📚',
  exocortex: '🧠',
  practice: '🪷',
  connection: '🫂',
  bureaucracy: '🏛️',
  'self-becoming': '🪞',
};

const FALLBACK_EMOJI = '🏷️';

export function frontLabel(fronts: Front[], key: string | null | undefined): string {
  if (key === '__none__') return '🏷️ Other';
  const f = fronts.find((x) => x.id === key);
  if (f) return `${FRONT_EMOJI[f.id] || FALLBACK_EMOJI} ${f.name}`;
  return key || '';
}
