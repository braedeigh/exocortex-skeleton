/**
 * standalone.ts — is this the DESKTOP APP, and if so, which pages does it hold?
 *
 * The desktop app is this same page served by a small server on the person's
 * own machine (standalone_app.py, started by scripts/standalone.py). That
 * server writes `window.STANDALONE = true` into the page (routes/spa.py),
 * beside VIEW_MODE. On the normal site the flag is false or missing and
 * nothing in this file changes anything.
 *
 * In the desktop app only the Observatory and Terrain exist (plus the
 * journal, when the server says it has one — see STANDALONE_EXTRA_PARTS). The rest of the
 * site (journal, to-dos, food, and so on) is still in the build but the
 * server behind it has none of their data, so every way to reach them is
 * closed here, in one list, rather than page by page:
 *
 *   - routes/__root.tsx asks standaloneRedirect() before every navigation;
 *   - shell/panels/sections.ts keeps only STANDALONE_SECTION_IDS on the
 *     desktop tab bar;
 *   - shell/TopTabs.tsx draws a two-button strip instead of the site's;
 *   - a page that has doors to other pages (the roster, Terrain's hallway)
 *     asks pageIsOffered() before drawing each door.
 *
 * The whole picture, and the list of what in the page still assumes the
 * owner's own install: docs/desktop-page.md.
 *
 * Prompt that produced it: "What would it take to turn the observatory and
 * terrain into a downloadable desktop app?"
 */

/** True in the desktop app. Read off the boot global the server injects, so
 * the shell knows before anything is drawn or fetched. */
export function isStandalone(): boolean {
  return typeof window !== 'undefined' && window.STANDALONE === true;
}

/** The parts of the site the desktop app keeps, as path prefixes. `/code` is
 * the page a file opens in when it's tapped on the map or a session card;
 * `/sql` is the same page as Terrain's SQL room. */
export const STANDALONE_KEEPS: readonly string[] = ['/observatory', '/terrain', '/code', '/sql'];

/**
 * Pages inside those parts that the desktop app leaves out.
 *
 * Each one draws something only the owner's own install has: her Linear
 * board, her research desk, the night crew and helper jobs her cron starts,
 * the worktree map of that crew, and the two Terrain rooms that draw her
 * journal.
 */
export const STANDALONE_LEAVES_OUT: readonly string[] = [
  '/observatory/linear',
  '/observatory/research',
  '/observatory/nightcrew',
  '/observatory/helpers',
  '/observatory/worktrees',
  '/terrain/pond',
  '/terrain/creek',
];

/** The desktop tab bar's sections (ids from shell/panels/sections.ts), in the
 * order the menu lists them. */
export const STANDALONE_SECTION_IDS: readonly string[] = [
  'observatory',
  'terrain',
  'flow',
  'workshop',
  'activity',
  'code',
  'sql',
  'setup',
];

/** Where the first-run screen can be opened again later. Under /observatory
 * so the server needs no new address for it. */
export const SETUP_PATH = '/observatory/setup';

/** True when `path` is `prefix` itself or a page under it. The boundary check
 * is what stops /codex being counted as part of /code. */
function isUnder(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** Strip the query and any trailing slash — everything here matches on path. */
function pathOnly(url: string): string {
  return url.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
}

/**
 * Parts the desktop app holds only when its server says it has them.
 *
 * The server lists them in `window.STANDALONE_EXTRAS` once the routes behind
 * them answer. Until it names one, that part doesn't exist in the page: no
 * tab, no button, and its address goes home like any other. The journal is
 * the first: its page needs the journal's own data on the machine, which a
 * fresh install has only when the server has set it up.
 *
 * Her ask: "I want journal to be actually in the build at first".
 */
export const STANDALONE_EXTRA_PARTS: Readonly<Record<string, { keeps: readonly string[]; sectionIds: readonly string[] }>> = {
  journal: { keeps: ['/journal'], sectionIds: ['journal'] },
};

/** The extra parts this desktop app's server offers. Names the page doesn't
 * know are dropped, so a newer server can't break an older page. */
export function standaloneExtras(): string[] {
  if (typeof window === 'undefined' || !Array.isArray(window.STANDALONE_EXTRAS)) return [];
  return window.STANDALONE_EXTRAS.filter((name) => typeof name === 'string' && name in STANDALONE_EXTRA_PARTS);
}

/** Does the desktop app hold this page? Kept parts and any extras the server
 * offers, minus what's left out. `extras` is passed in by tests; the app
 * reads it from the page. */
export function standaloneAllows(url: string, extras: readonly string[] = standaloneExtras()): boolean {
  const path = pathOnly(url);
  if (STANDALONE_LEAVES_OUT.some((left) => isUnder(left, path))) return false;
  const kept = [...STANDALONE_KEEPS, ...extras.flatMap((name) => STANDALONE_EXTRA_PARTS[name]?.keeps ?? [])];
  return kept.some((prefix) => isUnder(prefix, path));
}

/** The desktop tab bar's section ids, with any extras' sections on the end,
 * ahead of Setup. */
export function standaloneSectionIds(extras: readonly string[] = standaloneExtras()): string[] {
  const added = extras.flatMap((name) => STANDALONE_EXTRA_PARTS[name]?.sectionIds ?? []);
  const base = STANDALONE_SECTION_IDS.filter((id) => id !== 'setup');
  return [...base, ...added, 'setup'];
}

/** The two places the desktop app can land. */
export type StandaloneHome = '/terrain/files' | '/observatory';

/**
 * Where to send a navigation the desktop app doesn't hold, or null to let it
 * through.
 *
 * A wide window opens the workspace, which already has the Observatory in its
 * left panel, so the page beside it should be the map. A narrow window shows
 * one page at a time, and the sessions are the one to start on.
 */
export function standaloneRedirect(
  url: string,
  wideWindow: boolean,
  extras: readonly string[] = standaloneExtras(),
): StandaloneHome | null {
  if (standaloneAllows(url, extras)) return null;
  return wideWindow ? '/terrain/files' : '/observatory';
}

/** Should a door to `url` be drawn? Always on the normal site; in the desktop
 * app only when the page behind it exists. */
export function pageIsOffered(url: string): boolean {
  return !isStandalone() || standaloneAllows(url);
}
