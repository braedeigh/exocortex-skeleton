/**
 * buildsApi.ts — the typed fetches behind Terrain's Builds room and a build's
 * report (routes/terrain_builds.py). The shapes live in buildReport.ts; the
 * build's MAP comes through the ordinary terrain fetch with a build id
 * (api.ts `useTerrain`).
 *
 * Owner only: every one of these answers a visitor 401, and the rooms that
 * call them aren't reachable for a visitor in the first place.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { BuildInfo, BuildReportData } from './buildReport';

export const BUILDS_KEY = ['terrain-builds'] as const;

export interface BuildsList {
  builds: BuildInfo[];
  /** Where clones from GitHub are kept on this machine. */
  clone_dir: string;
}

/**
 * Every build on the list. While any of them is still cloning this polls
 * every few seconds, so the card flips to "ready" by itself; otherwise it
 * holds still.
 */
export function useBuilds() {
  return useQuery({
    queryKey: BUILDS_KEY,
    queryFn: ({ signal }) => api.get<BuildsList>('/api/observatory/terrain/builds', signal),
    refetchInterval: (query) =>
      query.state.data?.builds.some((build) => build.state === 'cloning') ? 3_000 : false,
  });
}

/** One build's report: summary, sessions, commits. Off while `id` is null. */
export function useBuildReport(id: string | null) {
  return useQuery({
    queryKey: [...BUILDS_KEY, 'report', id] as const,
    queryFn: ({ signal }) =>
      api.get<BuildReportData>(
        `/api/observatory/terrain/builds/${encodeURIComponent(id ?? '')}/report`,
        signal,
      ),
    enabled: id !== null,
  });
}

/** Add a build from a GitHub repo address or a full folder path. A refusal
 * arrives as an ApiError whose message is a sentence to show as written. */
export function addBuild(source: string): Promise<{ ok: boolean; build: BuildInfo }> {
  return api.post('/api/observatory/terrain/builds', { source });
}

/** Take a build off the list. The folder on disk is left alone. */
export function removeBuild(id: string): Promise<{ ok: boolean }> {
  return api.delete(`/api/observatory/terrain/builds/${encodeURIComponent(id)}`);
}

/** Pull a clone up to date (or restart a failed clone), then re-index. */
export function refreshBuild(id: string): Promise<{ ok: boolean; detail: string | null; build: BuildInfo }> {
  return api.post(`/api/observatory/terrain/builds/${encodeURIComponent(id)}/refresh`);
}
