/**
 * Boot globals injected by routes/spa.py before `</head>` on every SPA route
 * (see _spa_response). Not present under `vite dev` — consumers must treat
 * all of these as possibly-undefined.
 */
export {};

declare global {
  interface Window {
    /** Saved theme overrides from /api/theme (routes/settings.py load_theme()) — same shape sky-theme.js reads. */
    THEME_OVERRIDES?: Record<string, unknown>;
    VIEW_MODE?: 'authed' | 'public';
    /** True on a public-only mirror (EXOCORTEX_PUBLIC_ONLY): there is no login page, so hide Sign-in. */
    PUBLIC_ONLY?: boolean;
    /** Rendered HTML (already sanitized server-side) for the public landing page, or null when authed. */
    PUBLIC_INTRO_HTML?: string | null;
    /** App identity for chrome that names the site (public header, fake terminal banner). */
    APP_META?: { name: string; owner: string; version: string };
  }
}
