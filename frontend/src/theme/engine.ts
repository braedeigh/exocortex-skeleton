/**
 * engine.ts — the runtime side of the sky-theme engine (the React/TS port of
 * static/js/sky-theme.js). Owns the DOM effects the pure modules
 * (solar/blend/resolve) stay clear of:
 *
 *  - applies the computed palette as inline styles on documentElement, same
 *    CSS custom property names as always (--bg, --card-bg, --text,
 *    --text-secondary, --text-muted, --border, plus the four accents), so
 *    every stylesheet — React CSS Modules and legacy static/css alike —
 *    keeps working unchanged;
 *  - re-computes every 2 minutes so 'auto'/'sky' modes track the sun;
 *  - listens for cross-frame 'theme-changed' postMessage (legacy pages still
 *    iframed in the SPA save themes too) and re-skins live;
 *  - broadcasts 'theme-changed' to every mounted iframe when the native
 *    Settings page commits, via shell/frameBridge's broadcastThemeChanged.
 *
 * Boot contract: routes/spa.py injects `window.THEME_OVERRIDES = {...}` at
 * the end of <head>; main.tsx calls initTheme() once at module scope, which
 * runs after <head> is parsed, so the overrides are always there (absent
 * under `vite dev`, where the defaults apply).
 */
import { broadcastThemeChanged } from '../shell/frameBridge';
import type { PhaseColors, ThemeMode, ThemeOverrides } from './palettes';
import { computeModeTheme, currentThemeMode, resolveSkyConfig } from './resolve';
import { localTimeInputs } from './solar';

export type ThemeListener = (overrides: ThemeOverrides) => void;

const listeners = new Set<ThemeListener>();
let initialized = false;

const THEME_MODE_STORAGE_KEY = 'themeMode';

/** The overrides currently in effect — window.THEME_OVERRIDES is kept as the
 * single source of truth so legacy code paths reading it stay correct. */
export function getThemeOverrides(): ThemeOverrides {
  if (typeof window === 'undefined') return {};
  return (window.THEME_OVERRIDES as ThemeOverrides | undefined) ?? {};
}

export function readStoredThemeMode(): string | null {
  try {
    return localStorage.getItem(THEME_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the mode browser-side so it survives before the server round-trip
 * lands (same localStorage key sky-theme.js/settings.js used). */
export function rememberThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // private mode / storage denied — the server-saved mode still applies
  }
}

function applyTheme(theme: PhaseColors): void {
  const r = document.documentElement.style;
  r.setProperty('--bg', theme.bg);
  r.setProperty('--card-bg', theme.cardBg);
  r.setProperty('--text', theme.text);
  r.setProperty('--text-secondary', theme.textSecondary);
  r.setProperty('--text-muted', theme.textMuted);
  r.setProperty('--border', theme.border);
}

/**
 * Recompute and apply the theme for "now" — the port of updateSkyTheme().
 * Accents always apply (they don't shift with the day); the palette applies
 * unless the mode says to leave the stylesheet defaults alone. Like the
 * legacy engine, a null palette leaves previously-applied inline styles in
 * place rather than clearing them (they persist until reload — deliberate
 * parity, callers depend on nothing here).
 */
export function refreshTheme(): void {
  const overrides = getThemeOverrides();
  const cfg = resolveSkyConfig(overrides);

  const r = document.documentElement.style;
  r.setProperty('--morning', cfg.accents.morning);
  r.setProperty('--evening', cfg.accents.evening);
  r.setProperty('--ongoing', cfg.accents.ongoing);
  r.setProperty('--accent', cfg.accents.accent);

  const mode = currentThemeMode(overrides, readStoredThemeMode());
  const { hour, dayOfYear } = localTimeInputs();
  const theme = computeModeTheme(cfg, mode, hour, dayOfYear);
  if (theme) applyTheme(theme);
}

function setOverrides(overrides: ThemeOverrides): void {
  window.THEME_OVERRIDES = overrides as Record<string, unknown>;
  refreshTheme();
  for (const listener of listeners) listener(overrides);
}

/**
 * Live preview: swap the in-memory overrides and re-skin this document only
 * — no server save, no cross-frame broadcast. The Settings page uses this
 * for instant mode switches.
 */
export function previewThemeOverrides(overrides: ThemeOverrides): void {
  setOverrides(overrides);
}

/**
 * Commit: apply here AND broadcast 'theme-changed' to every mounted iframe
 * (legacy tabs, keeper, research…) so they re-skin live — the role the old
 * settings.js → parent postMessage → split.html relay chain played.
 * Persisting to the server is the caller's job (POST /api/theme/save first).
 */
export function commitThemeOverrides(overrides: ThemeOverrides): void {
  setOverrides(overrides);
  broadcastThemeChanged(overrides);
}

/** Notifies whenever the effective overrides change (preview, commit, or a
 * 'theme-changed' message from another frame). Returns an unsubscriber. */
export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Boot the engine: apply immediately, re-apply every 2 minutes, and react to
 * cross-frame 'theme-changed' messages. Idempotent — call once from main.tsx.
 */
export function initTheme(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  refreshTheme();
  window.setInterval(refreshTheme, 120000);

  // Cross-frame theme refresh: a legacy settings page saving inside an
  // iframe posts {type:'theme-changed', overrides} up to this window
  // (shell/frameBridge relays it on to the *other* iframes; this listener
  // re-skins the shell document itself, exactly as sky-theme.js did).
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const msg = e.data as { type?: string; overrides?: unknown } | null;
    if (!msg || msg.type !== 'theme-changed' || !msg.overrides) return;
    setOverrides(msg.overrides as ThemeOverrides);
  });
}
