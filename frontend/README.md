# frontend — Exocortex v2 SPA

React 19 + TypeScript SPA, built and served by the skeleton Flask app
(`routes/spa.py` serves `frontend/dist/` under the same origin as the API).
No SSR — static build, client-side routing. Moved here from `exocortex-rs`
during the Rust pause (see that repo's README); the API it talks to is the
existing Flask app, unchanged.

## Stack

- **Vite** — build tool / dev server
- **React 19** + **TypeScript**
- **TanStack Router** (`@tanstack/react-router` + `@tanstack/router-plugin`) —
  typed, file-based routing. Route files live in `src/routes/`; the plugin
  generates `src/routeTree.gen.ts` on every `dev`/`build` run.
- **TanStack Query** (`@tanstack/react-query`) — server-state cache for API
  calls
- **vite-plugin-pwa** (Workbox) — app-shell precache + PWA manifest
- No UI kit, no CSS framework — hand-rolled CSS Modules + CSS custom
  properties (`src/theme.css`)

## Commands

```
npm install
npm run dev         # vite dev server, proxies /api /tab /login /logout /static
                     # /journal-view /research-view /settings-view /keeper to :5000
npm run build        # vite build, then `tsc --noEmit` over the built tree
npm run typecheck    # `tsc --noEmit` on its own (needs routeTree.gen.ts to
                      # already exist — run `dev` or `build` at least once first)
npm run preview      # serve the production build locally
npm run lint          # oxlint
```

`npm run dev` proxies to a Flask instance on `http://127.0.0.1:5000` — run
the skeleton app (`sudo systemctl status exocortex.service` or run it
locally) for `/api`, `/tab/*`, `/login`, `/static/*`, and the iframe view
routes to resolve while developing.

## Layout

```
src/
  theme.css        base palette + spacing scale (light "post-dawn" / dark
                    "twilight", ported from skeleton's sky-theme.js + style.css —
                    NOT the full time-of-day engine, just the two static endpoints)
  index.css        reset + body defaults, imports theme.css
  main.tsx          QueryClientProvider + RouterProvider bootstrap
  ui/               touch-first primitives — Button, IconButton, TapRow,
                    Checkbox, Sheet
  api/
    client.ts       thin typed fetch wrapper — same-origin, credentials:
                    'include', JSON in/out, 401 -> redirect to /login.
                    Everything server-bound goes through this (the frontend's
                    store.py).
    endpoints.ts    typed functions: getData(tab), getVersion()
    types/          hand-maintained payload types (Todo, Bucket, Reminder,
                    RemindersFile, PendingChange, ...) — formerly ts-rs output
                    from exo-core, vendored as regular source when the
                    frontend moved here. See the header comment on each file.
  shell/
    TabBar.tsx      bottom tab bar: Today, Todos, Kitchen, More
  routes/
    __root.tsx      root layout: <Outlet /> + <TabBar />
    index.tsx        "/" -> redirect to "/todos"
    todos.tsx         "/todos" — placeholder page, calls getData('today') via
                      TanStack Query, dumps raw JSON in a <pre> (proof of data
                      flow; real UI comes later)
    legacy.$tab.tsx   "/legacy/$tab" — <iframe src="/tab/$tab"> full-bleed
                      under the tab bar. Strangler-fig bridge: Today, Kitchen,
                      and More route here until each gets ported to native
                      React. Only Todos has a native route so far.
```

## Touch-first rules (non-negotiable, enforced in component CSS)

From the owner's designer friend, ported forward from the skeleton app's UI
guidelines:

- Every interactive element (`Button`, `IconButton`, `TapRow`, `Checkbox`'s
  clickable label, `Sheet`'s close control, tab bar items) has
  `min-height: var(--tap-target)` = **44px**, with comfortable padding.
- **No text below 12px** anywhere (`--font-size-sm: 12px` is the floor);
  default body text is **16px** (`--font-size-base`, set on `body` in
  `index.css`).
- Delete/close (×) buttons use `IconButton` with a visibly tinted background
  by default (`danger` variant) — not just a hover reveal — so they're never
  faint or hard to find, and they're never paired with a sub-12px label.
- "Small until edit": these primitives stay compact/clean in normal display;
  call sites that need the "grow to 44px in edit mode" pattern (e.g. a
  `.card.editing` toggle) implement that at the call site using the same
  `--tap-target` variable, not inside the primitive.

## Theme

`src/theme.css` defines `:root` custom properties for spacing (`--space-1`
… `--space-8`, 4px base), radius (`--radius-sm` … `--radius-pill`), and the
two color endpoints pulled from the skeleton's `sky-theme.js`:

- **light** ("post-dawn") — default
- **dark** ("twilight") — via `@media (prefers-color-scheme: dark)`

`:root[data-theme="light"]` / `:root[data-theme="dark"]` force one or the
other regardless of OS preference (set the attribute on `<html>` from app
code once user-facing theme settings exist). This intentionally does *not*
port the skeleton's full time-of-day sun-position blending engine — just the
two static palettes as CSS variables.

## Generated code — do not hand-edit

- `src/routeTree.gen.ts` — written by `@tanstack/router-plugin` from the
  files in `src/routes/`. Gitignored, regenerated by `dev`/`build`.

`src/api/types/` is *not* generated — it's vendored, hand-maintained source
(re-derive from exo-core if the Rust rewrite resumes; see its header
comments).

## Known lint warnings

`oxlint`'s `react(only-export-components)` rule warns on every route file in
`src/routes/` (they export both a `Route` object and a component). This is
the standard TanStack Router file-based-routing shape — expected, not a bug.

## PWA

`vite-plugin-pwa` precaches the built app shell (JS/CSS/HTML/icons) and uses
a `NetworkFirst` runtime strategy for `/api/*`. The manifest reuses the
skeleton's `icon-192.png`/`icon-512.png` (copied into `public/`) and the
`--accent` / palette colors for `theme_color`/`background_color`. The service
worker is disabled under `npm run dev` (`devOptions.enabled: false`) to keep
HMR + the API proxy from fighting a cached SW — test PWA behavior via
`npm run build && npm run preview`.
