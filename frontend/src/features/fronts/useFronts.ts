/**
 * useFronts.ts — the shared "fronts" vocabulary (routes/fronts.py,
 * fronts.json): a small set of life-domain tags (health, appearance,
 * finances, living-space, job, hobbies, learning, exocortex) used across
 * features. Originally lived in the research feature (it backs topic
 * tagging there); the todos feature also stamps a front id onto each to-do's
 * `theme` field, so the query hook + label helpers moved here to be shared
 * rather than duplicated.
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
  errands: '📦',
  'self-becoming': '🪞',
};

const FALLBACK_EMOJI = '🏷️';

export function frontLabel(fronts: Front[], key: string | null | undefined): string {
  if (key === '__none__') return '🏷️ Other';
  const f = fronts.find((x) => x.id === key);
  if (f) return `${FRONT_EMOJI[f.id] || FALLBACK_EMOJI} ${f.name}`;
  return key || '';
}
