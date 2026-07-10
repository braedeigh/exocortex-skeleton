/**
 * settingsApi.ts — the Settings page's server calls that aren't already in
 * src/api/endpoints.ts (dev-note CRUD lives there). Same contracts the
 * legacy static/js/settings.js hit.
 */
import { api } from '../../api/client';
import type { OkResponse } from '../../api/endpoints';
import type { ThemeOverrides } from '../../theme';

/** POST /api/theme/save (routes/settings.py) — whitelists and persists the
 * six override keys to theme_settings.json. */
export function saveTheme(payload: ThemeOverrides): Promise<OkResponse> {
  return api.post('/api/theme/save', payload);
}

/** POST /api/auth/change-password (server.py) — {current, new}; 403 wrong
 * current, 400 too short, 410 when passwords are managed by `exo user`. */
export function changePassword(current: string, next: string): Promise<OkResponse> {
  return api.post('/api/auth/change-password', { current, new: next });
}
