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
    /** Rendered HTML (already sanitized server-side) for the public landing page, or null when authed. */
    PUBLIC_INTRO_HTML?: string | null;
  }
}
