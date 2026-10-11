/**
 * useWikiHome.ts — data hook for the wiki home page (routes/wiki.py,
 * GET /api/wiki/home). Same shape as useFronts.ts: a small, rarely-changing
 * document, so no polling — just a query-cache with a longish staleTime.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** A `people:` slug resolved to a display name (routes/wiki.py
 * `_resolve_people`, itself built on routes/threads.py `_resolve_cast`).
 * `resolved` is false when there's no people/<slug>.md yet — the frontend
 * renders that as a muted "redlink" chip instead of a live person link. */
export interface WikiPerson {
  slug: string;
  name: string;
  resolved: boolean;
}

/** One thread in the browse-by-front index — every living (non-retired)
 * thread from the same roster /api/threads is built from (routes/wiki.py
 * `_wiki_threads`). `status` is "active" | "dormant" | "" (seedling/unset);
 * the first entry in `fronts` is its primary front (grouping key when no
 * filter is active). `summary` doesn't exist yet on the backend — it's a
 * forward-compatible slot for a future per-thread generated one-liner. */
export interface WikiThreadSummary {
  slug: string;
  name: string;
  fronts: string[];
  status: string;
  // TODO: per-thread generated summary lands here once the backend derives one.
  summary?: string;
}

/** One life-domain front, {id, name} only (routes/wiki.py trims the
 * `created` timestamp fronts.json carries — this page doesn't need it). */
export interface WikiFront {
  id: string;
  name: string;
}

/** GET /api/wiki/home's payload — the parsed context/home.md (now three
 * body sections: `lead`, `organizedBlurb`, `howToRead`) plus the derived
 * thread browse index and front vocabulary. */
export interface WikiHome {
  title: string;
  pronouns: string;
  age: string;
  birthday: string;
  place: string;
  lead: string;
  organizedBlurb: string;
  howToRead: string;
  people: WikiPerson[];
  threads: WikiThreadSummary[];
  fronts: WikiFront[];
}

export const WIKI_HOME_KEY = ['wiki', 'home'] as const;

function getWikiHome(signal?: AbortSignal): Promise<WikiHome> {
  return api.get('/api/wiki/home', signal);
}

/** The wiki home doc — changes rarely (she edits home.md by hand), so a
 * 10-minute staleTime like useFronts rather than journal-style polling. */
export function useWikiHome() {
  return useQuery({
    queryKey: WIKI_HOME_KEY,
    queryFn: ({ signal }) => getWikiHome(signal),
    staleTime: 10 * 60_000,
  });
}
