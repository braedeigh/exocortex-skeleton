import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';

/**
 * api.ts — the one read the Apps room makes: GET /api/apps (routes/apps.py),
 * the apps, what each is made of, the Based Foods port checklist, and the
 * crossings between apps (appboundaries.py).
 */

export interface AppParts {
  routes: string[];
  modules: string[];
  frontend: string[];
  scripts: string[];
  tables: string[];
}

export interface AppColumn extends AppParts {
  id: string;
  name: string;
  glyph: string;
  pages: string[];
  borrows: string[];
  projects: string[];
}

export interface PortPage {
  path: string;
  status: 'in-based-foods' | 'to-port' | 'exocortex-only';
  note: string;
}

export interface Crossing {
  kind: 'import' | 'frontend' | 'table' | 'page';
  from: string;
  to: string;
  from_app: string;
  to_app: string;
  /** In the baseline already (app_boundaries_baseline.json). */
  known: boolean;
}

export interface AppsMap {
  apps: AppColumn[];
  shared: AppParts & { pages: string[]; projects: string[] };
  based_foods: AppParts & { id: string; name: string; glyph: string; pages: PortPage[]; projects: string[] };
  crossings: Crossing[];
}

export function useAppsMap() {
  return useQuery({
    queryKey: ['apps-map'],
    queryFn: ({ signal }) => api.get<AppsMap>('/api/apps', signal),
    staleTime: 5 * 60_000,
  });
}
