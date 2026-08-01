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

/** The owner-profile fields (routes/profile.py) — owner_name/owner_email/
 * app_name, each independently settable/clearable. */
export interface ProfileFields {
  owner_name: string;
  owner_email: string;
  app_name: string;
}

/** GET /api/profile response — `profile` is the resolved value (stored ->
 * env -> default precedence), `stored` is only what's explicitly set (an
 * absent/empty key there means the field is currently inherited). */
export interface ProfileResponse {
  profile: ProfileFields;
  stored: Partial<ProfileFields>;
}

/** GET /api/profile (routes/profile.py). */
export function fetchProfile(): Promise<ProfileResponse> {
  return api.get('/api/profile');
}

/** Where the box's Claude Code re-login stands (routes/claude_auth.py).
 *
 * `state` walks idle -> starting -> awaiting_code -> done. `url` is only set
 * at awaiting_code and is the OAuth link she has to open in a real browser.
 * `days_left` is runway on the CURRENT token and is reported at every state —
 * it comes from the credentials file, not from the flow. */
export interface ClaudeAuthStatus {
  state: 'idle' | 'starting' | 'awaiting_code' | 'done';
  url: string | null;
  expires_at: string | null;
  days_left: number | null;
}

/** GET /api/claude-auth/status — read-only, safe to poll. */
export function fetchClaudeAuth(): Promise<ClaudeAuthStatus> {
  return api.get('/api/claude-auth/status');
}

/** POST /api/claude-auth/start — spawns the login pane. Returns immediately;
 * the URL shows up on a later status poll. */
export function startClaudeAuth(): Promise<{ ok: boolean }> {
  return api.post('/api/claude-auth/start', {});
}

/** POST /api/claude-auth/code — 400 when the code doesn't take (the pane
 * stays alive so she can retype), 409 when no login is running. */
export function submitClaudeAuthCode(code: string): Promise<ClaudeAuthStatus> {
  return api.post('/api/claude-auth/code', { code });
}

/** POST /api/claude-auth/cancel — drops the pane. */
export function cancelClaudeAuth(): Promise<{ ok: boolean }> {
  return api.post('/api/claude-auth/cancel', {});
}

/** PUT /api/profile (routes/profile.py) — partial object merges; a key set
 * to "" clears it back to inherited (env/default). 400 {"error"} on invalid
 * values (e.g. malformed email), surfaced via ApiError.message. */
export function saveProfile(updates: Partial<ProfileFields>): Promise<ProfileResponse> {
  return api.put('/api/profile', updates);
}
