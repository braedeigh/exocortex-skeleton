/**
 * api.ts — typed fetch for GET /api/reading-room/atlas (routes/reading_room.py).
 * The atlas is a read-only map of every reading-room session sorted into its
 * home: the 12 life fronts (routes/fronts.py's vocabulary — see
 * ../fronts/useFronts.ts), one of which ("exocortex") further splits into
 * five domain shelves.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export interface AtlasFront {
  id: string;
  name: string;
}

export interface AtlasDomain {
  id: string;
  name: string;
  description?: string;
}

export interface AtlasSession {
  id: string;
  title: string;
  gist?: string;
  tags?: string[];
  front: string | null;
  domain?: string | null;
  bot: string;
  started?: string;
  last_at?: string;
  archived?: boolean;
  pinned?: boolean;
}

export interface AtlasData {
  fronts: AtlasFront[];
  domains: AtlasDomain[];
  sessions: AtlasSession[];
}

export const ATLAS_KEY = ['atlas'] as const;

function getAtlas(signal?: AbortSignal): Promise<AtlasData> {
  return api.get('/api/reading-room/atlas', signal);
}

/** The atlas is a slow-changing map, not a live feed — no polling. */
export function useAtlas() {
  return useQuery({
    queryKey: ATLAS_KEY,
    queryFn: async ({ signal }) => getAtlas(signal),
    staleTime: 60_000,
  });
}
