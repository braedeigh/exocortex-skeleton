import { createContext, useContext } from 'react';
import appsData from '../../../apps.json';

/**
 * apps.ts — which APP is this window (or this desktop pane), and which pages
 * does it hold?
 *
 * The site is cut into apps — Journal, Observatory, Finances, Inventory —
 * each installed on its own on a phone and each showing only its own tabs.
 * Based Foods is a separate app at its own address, only ever linked to. The
 * one list of them is apps.json at the repo root; this file reads it for the
 * page (appmap.py reads it for the server).
 *
 * WHICH APP: an installed app opens on its start page with `?app=<id>` (the
 * manifest's start_url, routes/spa.py). That id is remembered for the life of
 * the window in sessionStorage — NOT localStorage, which Android shares
 * between installed apps on one site, so two apps would fight over it. A
 * window with no app shows the launcher at "/" (features/launcher). On the
 * desktop each workspace pane can wear a different app: the pane's tab set
 * says which (an app set's id is `app:<id>`, panels/tabSets.ts), handed down
 * through AppContext below, so useCurrentApp() answers per pane.
 *
 * WHICH PAGES: an app holds the pages under its prefixes (longest prefix
 * wins across apps, so /terrain/pond is the Journal's), the shared pages
 * every app may show (Settings, a code file), and the few addresses it
 * BORROWS from another app, matched exactly — the Journal shows the
 * Observatory's session list and a session in its own shell. Everything
 * else opens bare, with a way back (shell/TopTabs.tsx).
 *
 * Deliberately imports nothing else from the shell: standalone.ts reads this
 * file, and sections.ts reads standalone.ts, so importing either here would
 * make a loop. Turning a tab into a section lives in appTabs.ts.
 *
 * Touches: routes/__root.tsx and TopTabs.tsx (the strip), standalone.ts
 * (pageIsOffered asks appAllows), panels/tabSets.ts (apps as tab sets),
 * features/observatory/sessionFilters.ts (an app's rooms), routes/index.tsx
 * (the launcher). The design: docs/apps.md.
 *
 * Her ask: "I want to separate my journal, my based foods/grocery app, and my
 * observatory into separate apps to use on my phone." / "desktop should be
 * able to click per app ... click an app to be in a split screen window."
 */

/** Where a tab sits: always shown, shown while it fits, or always in More. */
export type TabPlace = 'bar' | 'fit' | 'more';

export interface AppTab {
  /** A section id from panels/sections.ts, or 'based-foods' for the link out. */
  section: string;
  place: TabPlace;
}

export interface AppDef {
  id: string;
  name: string;
  short_name: string;
  glyph: string;
  letter: string;
  color: string;
  /** The page it opens on, without ?app=. */
  start: string;
  /** Address prefixes it holds. */
  pages: string[];
  /** Exact addresses it shows though another app holds them. */
  borrows: string[];
  tabs: AppTab[];
  /** The rooms its session list shows; null = every room. */
  rooms: string[] | null;
  /** Whether its session list shows the pinned Keeper. */
  keeper: boolean;
  projects: string[];
}

interface AppsFile {
  apps: Record<string, Omit<AppDef, 'id'>>;
  shared: { pages: string[] };
  launcher: string;
  based_foods: { name: string; glyph: string; pages: { path: string; status: string; note: string }[] };
}

const DATA = appsData as unknown as AppsFile;

/** Every installable app, in apps.json's order. */
export const APPS: readonly AppDef[] = Object.entries(DATA.apps).map(([id, app]) => ({ id, ...app }));

/** Pages every app may show. */
export const SHARED_PAGES: readonly string[] = DATA.shared.pages;

/** Based Foods' name and glyph, for the link out of each app. */
export const BASED_FOODS = { name: DATA.based_foods.name, glyph: DATA.based_foods.glyph };

export function appById(id: string | null | undefined): AppDef | null {
  return APPS.find((app) => app.id === id) ?? null;
}

/** Where this install's Based Foods lives, or '' when it has none set — in
 * which case no link is drawn (routes/spa.py injects it from config). */
export function basedFoodsUrl(): string {
  return typeof window !== 'undefined' && typeof window.BASED_FOODS_URL === 'string' ? window.BASED_FOODS_URL : '';
}

/* ---------- which app this window is ---------- */

const STORAGE_KEY = 'exo-app';

/** The `?app=` in a query string, if it names a real app. Exported for tests. */
export function appFromSearch(search: string): AppDef | null {
  return appById(new URLSearchParams(search).get('app'));
}

/**
 * The app this window is, or null for none.
 *
 * A `?app=` in the address wins and is remembered for the rest of the
 * window's life; after that the remembered one answers, so the app survives
 * every navigation that drops the query. An `?app=` naming no app is ignored.
 */
export function currentApp(): AppDef | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = appFromSearch(window.location.search);
  try {
    if (fromUrl) {
      window.sessionStorage.setItem(STORAGE_KEY, fromUrl.id);
      return fromUrl;
    }
    return appById(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage refused (a locked-down browser): the address alone decides.
    return fromUrl;
  }
}

/** Forget the window's app — what choosing "All apps" does, so the
 * launcher isn't immediately overruled by the app it was opened from. */
export function leaveApp(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing remembered, nothing to forget
  }
}

/* ---------- which app a desktop pane is ---------- */

/** The id of the tab set that IS an app (panels/tabSets.ts). */
export function appSetId(appId: string): string {
  return `app:${appId}`;
}

/** The app a tab set stands for, or null for one of her own sets. */
export function appOfSet(setId: string | null | undefined): AppDef | null {
  return setId && setId.startsWith('app:') ? appById(setId.slice(4)) : null;
}

/**
 * The app a desktop pane is wearing. `undefined` outside the workspace (the
 * window's own app answers there); `null` for a pane wearing one of her own
 * sets, which belongs to no app. Provided by panels/Workspace.tsx.
 */
export const AppContext = createContext<AppDef | null | undefined>(undefined);

/** The app the calling component is in: its pane's, else the window's. */
export function useCurrentApp(): AppDef | null {
  const pane = useContext(AppContext);
  return pane === undefined ? currentApp() : pane;
}

/* ---------- which pages an app holds ---------- */

/** Strip the query, the hash and any trailing slash. */
function pathOnly(url: string): string {
  return url.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
}

/** True when `path` is `prefix` itself or a page under it. The boundary
 * check is what stops /codex counting as part of /code. */
function isUnder(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** Which app holds this page, by longest prefix; null for a page no app
 * holds (shared, the launcher, a Based Foods page). */
export function appOwning(url: string): AppDef | null {
  const path = pathOnly(url);
  let best: AppDef | null = null;
  let bestLength = -1;
  for (const app of APPS) {
    for (const prefix of app.pages) {
      if (isUnder(prefix, path) && prefix.length > bestLength) {
        best = app;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** Does `app` show this page in its own shell? Its own pages, the shared
 * ones, and the exact addresses it borrows. */
export function appAllows(url: string, app: AppDef): boolean {
  const path = pathOnly(url);
  if (SHARED_PAGES.some((page) => isUnder(page, path))) return true;
  if (app.borrows.includes(path)) return true;
  return appOwning(path)?.id === app.id;
}

/** The address an app opens on, carrying its id. */
export function appStartHref(app: AppDef): string {
  return `${app.start}?app=${app.id}`;
}
