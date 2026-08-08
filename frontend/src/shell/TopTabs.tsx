import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from '@tanstack/react-router';
import { Sheet, TapRow } from '../ui';
import { TAB_META, TAB_ROUTES, VIEW_META, isValidTab, tabForPath, type LegacyTab } from './tabs';
import { useMediaQuery, DESKTOP_QUERY } from './useMediaQuery';
import { useSessionsContext } from './SessionsContext';
import { useChatSurfaceObservatory } from './chatSurface';
import styles from './TopTabs.module.css';

/**
 * Top tab strip — two stacked rows, restoring the old app's double tab bar.
 *
 * Row 1 ("dash bar") is a port of split.html's `.dash-bar` (lines 52-82):
 * Chat (mobile only) / Journal / Dashboard / Research switcher plus a
 * Settings gear, always rendered above everything else.
 *
 * Row 2 is the React port of the old dashboard's #tab-selector row + More ▾
 * menu (templates/index.html:24-52): primary tabs always shown, optional
 * tabs shown while they fit and overflowed into More when the pane is narrow
 * (layoutTabs port, static/js/core.js:2615), plus a fixed set of tabs/links
 * that always live in More. In the old app this row lived inside the
 * dashboard iframe, so it only mounts here while a dashboard route (/todos
 * or /legacy/*) is active — Journal/Research/Settings no longer need it
 * since they're reachable from row 1.
 *
 * Public (unauthenticated) visitors get neither row — row 1's views are all
 * auth-only (mirroring split.html's `body.public-mode .dash-bar
 * { display: none; }`). Instead they get the PublicHeader (port of
 * frosted.css's .public-header: site name · About · Sign in) plus row 2
 * restricted to the public tabs, so the pages public_config.py exposes are
 * actually reachable without typing URLs.
 */

const PRIMARY_TABS: ReadonlyArray<{ key: 'today' | LegacyTab; label: string }> = [
  { key: 'today', label: 'To Do' },
  { key: 'map', label: 'Life Map' },
  { key: 'kitchen', label: 'Kitchen' },
];

// Order matches the optional (.tab-opt) tabs in templates/index.html:32-38.
const OPTIONAL_TABS: readonly LegacyTab[] = (
  ['ideas', 'body', 'money', 'meditation', 'media', 'movement', 'ecosystem'] as const
).filter(isValidTab);

// Public visitors get exactly To Do / Life Map / Kitchen (the PRIMARY_TABS,
// always shown) plus Ecosystem here — the owner's explicit call on what the
// public site shows, not just "whatever public_config.py happens to expose."
// Money and Inventory are reachable logged-out too, but stay off the public
// row on purpose.
const PUBLIC_OPTIONAL_TABS: readonly LegacyTab[] = (['ecosystem'] as const).filter(isValidTab);

// Always-in-More legacy tabs, in the order given in the spec (templates/index.html
// more-menu order differs slightly; this is the order the owner asked for).
const ALWAYS_MORE_TABS: ReadonlyArray<{ tab: LegacyTab; label: string }> = [
  { tab: 'people', label: 'People' },
  { tab: 'inventory', label: 'Inventory' },
  { tab: 'travel', label: 'Travel' },
  { tab: 'housing', label: 'Housing' },
  { tab: 'car', label: 'Car Maintenance' },
].filter((entry): entry is { tab: LegacyTab; label: string } => isValidTab(entry.tab));

// Native standalone pages in the More menu (Keeper is covered by the Files
// view below; Personality/Scratchpad/VS Code are SPA routes now).
// This array is purely in-memory (never persisted), so 'bots' was renamed
// to 'observatory' along with the surface (07-24).
// Terrain is NOT in this list any more — it was promoted to row 1 in place of
// Research. The Observatory stays: the two still read as a pair (Terrain is the
// map *of* the Observatory's sessions), but the pair now spans both rows.
const MORE_PAGES: ReadonlyArray<{ key: string; label: string; to: string }> = [
  // Fronts leads the list: it's the only page here about her life rather than
  // about the system, and it's a way IN to the other surfaces (each front
  // hands off to the to-dos filtered to it) rather than a destination.
  { key: 'fronts', label: 'Fronts', to: '/fronts' },
  { key: 'observatory', label: 'Observatory', to: '/observatory' },
  // Atlas is gone from the menu: /atlas is now a bare redirect to the
  // Observatory's archive, which has its own doors from every room.
  { key: 'personality', label: 'Personality', to: '/personality' },
  { key: 'scratchpad', label: 'Scratchpad', to: '/scratchpad' },
  { key: 'vscode', label: 'VS Code', to: '/vscode' },
  // The database's own page — the collection map plus a read-only query
  // console. Sits with the other tool pages rather than in MORE_VIEWS, which
  // is an explicit allowlist of the *content* browsers (files/notes/research).
  { key: 'sql', label: 'SQL', to: '/sql' },
];

// Journal/Settings sit in row 1 (the dash bar); Files and the /notes browser
// page live in the More menu. Research joined them there when Terrain took its
// slot in row 1 — it kept its route and its active-state handling, it's just
// one tap further away now.
const MORE_VIEWS = VIEW_META.filter(
  (v) => v.key === 'files' || v.key === 'notes' || v.key === 'research',
);

type ActiveKey = 'today' | LegacyTab | `view:${(typeof VIEW_META)[number]['key']}` | null;

function useActiveKey(pathname: string): ActiveKey {
  return useMemo<ActiveKey>(() => {
    const native = tabForPath(pathname);
    if (native) return native;
    const view = MORE_VIEWS.find((v) => v.to === pathname);
    if (view) return `view:${view.key}`;
    return null;
  }, [pathname]);
}

/** Dashboard routes are the native tab routes — the routes that, in the old
 * app, lived inside the dashboard iframe under row 2. */
type DashboardTarget = { to: string };

function parseDashboardTarget(pathname: string): DashboardTarget | null {
  if (tabForPath(pathname)) return { to: pathname };
  return null;
}

function joinClass(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

interface MoreMenuContentProps {
  overflowed: readonly LegacyTab[];
  activeKey: ActiveKey;
  onNavigate: () => void;
  /** false for public visitors: only overflowed tabs, none of the authed-only statics. */
  includeStatic: boolean;
  /** Mobile + chat-surface=bots: the Chat tab no longer opens the terminal,
   * so the terminal gets a More entry instead of vanishing. */
  showTerminal?: boolean;
}

function MoreMenuContent({ overflowed, activeKey, onNavigate, includeStatic, showTerminal }: MoreMenuContentProps) {
  const navigate = useNavigate();
  return (
    <>
      {overflowed.map((tab) => (
        <TapRow
          key={tab}
          className={activeKey === tab ? styles.menuActive : undefined}
          onClick={() => {
            onNavigate();
            void navigate({ to: TAB_ROUTES[tab] });
          }}
        >
          {TAB_META[tab].label}
        </TapRow>
      ))}
      {(includeStatic ? ALWAYS_MORE_TABS : []).map(({ tab, label }) => (
        <TapRow
          key={tab}
          className={activeKey === tab ? styles.menuActive : undefined}
          onClick={() => {
            onNavigate();
            void navigate({ to: TAB_ROUTES[tab] });
          }}
        >
          {label}
        </TapRow>
      ))}
      {(includeStatic ? MORE_PAGES : []).map((page) => (
        <TapRow
          key={page.key}
          onClick={() => {
            onNavigate();
            void navigate({ to: page.to });
          }}
        >
          {page.label}
        </TapRow>
      ))}
      {showTerminal ? (
        <TapRow
          key="terminal"
          onClick={() => {
            onNavigate();
            void navigate({ to: '/chat' });
          }}
        >
          Terminal
        </TapRow>
      ) : null}
      {(includeStatic ? MORE_VIEWS : []).map((view) => (
        <TapRow
          key={view.key}
          className={activeKey === `view:${view.key}` ? styles.menuActive : undefined}
          onClick={() => {
            onNavigate();
            void navigate({ to: view.to });
          }}
        >
          {view.label}
        </TapRow>
      ))}
    </>
  );
}

/**
 * Public-mode header — React port of the old frosted.css `.public-header`
 * (site identity left; About + Sign in right). Themed with the normal page
 * palette, unlike the pinned-indigo tab rows: in the old app too, this bar
 * lived in the dashboard page and day/night-swapped with it.
 */
function PublicHeader() {
  const meta = typeof window !== 'undefined' ? window.APP_META : undefined;
  // The owner's name is the part visitors actually need to read; the
  // " · {name} v{version}" tail is secondary attribution. Rendering them as
  // one ellipsizing string truncated the owner's own name away on phones
  // (390px cut "Rowan Vale · Exoc…" mid-word) — so when there's an owner, it's
  // the primary text and the tail lives in its own de-emphasized span that
  // CSS drops on narrow screens instead. With no owner, {name} v{version} *is*
  // the primary text and is never hidden.
  return (
    <div className={styles.publicHeader}>
      <div className={styles.publicName}>
        {meta?.owner ? (
          <>
            {meta.owner}
            <span className={styles.publicNameDetail}>
              {' · '}
              {meta?.name ?? 'Exocortex'}
              {meta?.version ? ` v${meta.version}` : ''}
            </span>
          </>
        ) : (
          <>
            {meta?.name ?? 'Exocortex'}
            {meta?.version ? ` v${meta.version}` : ''}
          </>
        )}
      </div>
      <div className={styles.publicLinks}>
        <Link to="/about" className={styles.publicLink}>
          About
        </Link>
        <a href="/login" className={joinClass(styles.publicLink, styles.signInBtn)}>
          Sign in
        </a>
      </div>
    </div>
  );
}

/**
 * Row 2 — the legacy dashboard tab strip (To Do / Life Map / Kitchen / optional
 * tabs / More ▾). Only ever mounted while a dashboard route is active (see
 * TopTabs below), so it's its own component: mounting fresh each time it
 * reappears re-runs the layout()-on-mount effect below, which is what makes
 * the ResizeObserver measurement correct again after being unmounted.
 */
function DashboardTabRow({ pathname, isPublic = false }: { pathname: string; isPublic?: boolean }) {
  const optionalTabs = isPublic ? PUBLIC_OPTIONAL_TABS : OPTIONAL_TABS;
  const [overflowed, setOverflowed] = useState<readonly LegacyTab[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const chatBots = useChatSurfaceObservatory();
  const showTerminal = !isPublic && !isDesktop && chatBots;

  const rowRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const optionalRefs = useRef<Partial<Record<LegacyTab, HTMLAnchorElement | null>>>({});

  const activeKey = useActiveKey(pathname);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  // Port of layoutTabs (static/js/core.js:2615) — measure with all optional
  // tabs visible, then hide from the end (skipping the active tab until
  // nothing else is left to hide) until the row fits its container. Uses
  // scratch inline styles purely to remeasure synchronously; the persisted
  // "is this tab hidden" answer is the `overflowed` state below, which drives
  // the actual `.hidden` class on render.
  const layout = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // Explicit inline value (not '') so previously-overflowed tabs, still
    // carrying the .hidden class from the last committed state, actually
    // reappear for this measurement pass.
    for (const tab of optionalTabs) {
      const el = optionalRefs.current[tab];
      if (el) el.style.display = 'inline-flex';
    }
    const newOverflow: LegacyTab[] = [];
    for (let i = optionalTabs.length - 1; i >= 0; i--) {
      if (row.scrollWidth <= row.clientWidth) break;
      const tab = optionalTabs[i];
      if (tab === activeKey) continue;
      const el = optionalRefs.current[tab];
      if (el) el.style.display = 'none';
      newOverflow.unshift(tab);
    }
    if (row.scrollWidth > row.clientWidth && optionalTabs.includes(activeKey as LegacyTab)) {
      const activeTab = activeKey as LegacyTab;
      const el = optionalRefs.current[activeTab];
      if (el) el.style.display = 'none';
      const idx = optionalTabs.indexOf(activeTab);
      let at = newOverflow.findIndex((t) => optionalTabs.indexOf(t) > idx);
      if (at === -1) at = newOverflow.length;
      newOverflow.splice(at, 0, activeTab);
    }
    // Leave inline styles exactly matching the decision — the committed state
    // re-applies the same answer via the .hidden class, so render and
    // measurement never fight.
    for (const tab of optionalTabs) {
      const el = optionalRefs.current[tab];
      if (el) el.style.display = newOverflow.includes(tab) ? 'none' : 'inline-flex';
    }
    setOverflowed((prev) =>
      prev.length === newOverflow.length && prev.every((t, i) => t === newOverflow[i]) ? prev : newOverflow,
    );
  }, [activeKey, optionalTabs]);

  useEffect(() => {
    // Public mode never hides tabs into a More menu (the row scrolls
    // instead — see the .publicScroll effect below and the `!isPublic ||
    // overflowed.length > 0` check on the More button), so the overflow
    // measurement this effect exists for would just be wasted work: skip it
    // entirely and leave `overflowed` at its initial `[]` forever.
    if (isPublic) return;
    const row = rowRef.current;
    if (!row) return;
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(row);
    return () => ro.disconnect();
  }, [layout, isPublic]);

  // Public mode: keep the active tab in view as the row scrolls horizontally
  // instead of measuring overflow. Computed manually (not
  // el.scrollIntoView()) so it only ever adjusts this row's scrollLeft —
  // scrollIntoView can also scroll the whole page vertically to bring the
  // element into the viewport, which isn't wanted here since the row is
  // already on-screen.
  useEffect(() => {
    if (!isPublic) return;
    const row = rowRef.current;
    if (!row) return;
    const el = row.querySelector('.' + styles.active) as HTMLElement | null;
    if (!el) return;
    row.scrollLeft = el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2;
  }, [isPublic, activeKey]);

  // Close the menu on navigation (covers back/forward while it's open).
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // Desktop dropdown: click-outside + Escape to close (Sheet handles its own).
  useEffect(() => {
    if (!isDesktop || !moreOpen) return;
    function onDocClick(e: MouseEvent) {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) {
        closeMore();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMore();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isDesktop, moreOpen, closeMore]);

  const overflowedActive = optionalTabs.includes(activeKey as LegacyTab) && overflowed.includes(activeKey as LegacyTab);
  const alwaysMoreMatch = isPublic ? undefined : ALWAYS_MORE_TABS.find((t) => t.tab === activeKey);
  const viewMatch = isPublic ? undefined : MORE_VIEWS.find((v) => `view:${v.key}` === activeKey);

  let moreLabel = 'More';
  let moreActive = false;
  if (overflowedActive) {
    moreLabel = TAB_META[activeKey as LegacyTab].label;
    moreActive = true;
  } else if (alwaysMoreMatch) {
    moreLabel = alwaysMoreMatch.label;
    moreActive = true;
  } else if (viewMatch) {
    moreLabel = viewMatch.label;
    moreActive = true;
  }

  return (
    <div className={joinClass(styles.strip, isPublic && styles.publicStrip)}>
      <div className={joinClass(styles.row, isPublic && styles.publicScroll)} ref={rowRef}>
        <Link to="/todos" className={joinClass(styles.tab, activeKey === 'today' && styles.active)}>
          {PRIMARY_TABS[0].label}
        </Link>
        <Link to={TAB_ROUTES.map} className={joinClass(styles.tab, activeKey === 'map' && styles.active)}>
          {PRIMARY_TABS[1].label}
        </Link>
        <Link
          to={TAB_ROUTES.kitchen}
          className={joinClass(styles.tab, activeKey === 'kitchen' && styles.active)}
        >
          {PRIMARY_TABS[2].label}
        </Link>
        {optionalTabs.map((tab) => (
          <Link
            key={tab}
            to={TAB_ROUTES[tab]}
            ref={(el) => {
              optionalRefs.current[tab] = el;
            }}
            className={joinClass(styles.tab, activeKey === tab && styles.active, overflowed.includes(tab) && styles.hidden)}
          >
            {TAB_META[tab].label}
          </Link>
        ))}
      </div>

      {/* Public visitors' More holds only overflowed tabs — hide it while
          everything fits, since there'd be nothing inside. */}
      {!isPublic || overflowed.length > 0 ? (
        <div className={styles.moreWrap} ref={moreWrapRef}>
          <button
            type="button"
            className={joinClass(styles.tab, moreActive && styles.active)}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
          >
            {moreLabel} &#9662;
          </button>
          {isDesktop && moreOpen ? (
            <div className={styles.dropdown} role="menu">
              <MoreMenuContent
                overflowed={overflowed}
                activeKey={activeKey}
                onNavigate={closeMore}
                includeStatic={!isPublic}
                showTerminal={showTerminal}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Public mode never renders the mobile Sheet: it has no More button to
          open it (see the `!isPublic || overflowed.length > 0` guard above,
          which is always false here since overflowed never populates), so
          the Sheet could never actually open. */}
      {!isPublic && !isDesktop ? (
        <Sheet open={moreOpen} title="More" onClose={closeMore}>
          <MoreMenuContent
            overflowed={overflowed}
            activeKey={activeKey}
            onNavigate={closeMore}
            includeStatic={!isPublic}
            showTerminal={showTerminal}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

export function TopTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Mobile Chat tab's label (the active tmux session name) — shared with
  // /chat and /sessions via SessionsContext, so switching sessions on the
  // session page updates the label immediately.
  const sessions = useSessionsContext();
  // Settings can point the Chat tab at the Keeper bot instead of the tmux
  // terminal ("wanting it to replace the terminal") — see chatSurface.ts.
  const chatBots = useChatSurfaceObservatory();
  // Last dashboard route visited, so clicking Dashboard from Journal/Research
  // returns you where you left off instead of always resetting to /todos.
  const lastDashboardTarget = useRef<DashboardTarget>({ to: '/todos' });

  const dashboardTarget = parseDashboardTarget(location.pathname);
  const dashboardActive = dashboardTarget !== null;

  useEffect(() => {
    if (dashboardTarget) lastDashboardTarget.current = dashboardTarget;
    // Deliberately keyed on pathname, not the freshly-allocated dashboardTarget
    // object, so this doesn't re-run (harmlessly, but pointlessly) every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') {
    return (
      <>
        <PublicHeader />
        {dashboardActive ? <DashboardTabRow pathname={location.pathname} isPublic /> : null}
      </>
    );
  }

  return (
    <>
      <div className={styles.dashBar}>
        {!isDesktop ? (
          // Mobile only — desktop already has the terminal permanently docked
          // in the left split pane (SplitLayout), no need for a tab to it.
          // A second tap while already on /chat opens the full-page session
          // switcher (/sessions, SessionListPage); from there — or anywhere
          // else — the tab goes (back) to the active terminal.
          chatBots ? (
            // Chat tab → the Observatory roster in general (her 07-27 ask),
            // not straight into the Keeper conversation. The Keeper sits pinned
            // at the top of the roster, one tap away.
            <button
              type="button"
              className={joinClass(
                styles.dashBtn,
                styles.chatBtn,
                location.pathname.startsWith('/observatory') && styles.dashBtnActive,
              )}
              onClick={() => void navigate({ to: '/observatory' })}
            >
              <span className={styles.chatLabel}>Chat</span>
            </button>
          ) : (
            <button
              type="button"
              className={joinClass(
                styles.dashBtn,
                styles.chatBtn,
                (location.pathname === '/chat' || location.pathname === '/sessions') && styles.dashBtnActive,
              )}
              onClick={() => {
                if (location.pathname === '/chat') void navigate({ to: '/sessions' });
                else void navigate({ to: '/chat' });
              }}
            >
              <span className={styles.chatLabel}>
                {sessions.titles[sessions.active] || sessions.active || 'Chat'}
              </span>
            </button>
          )
        ) : null}
        <button
          type="button"
          className={joinClass(styles.dashBtn, location.pathname === '/journal' && styles.dashBtnActive)}
          onClick={() => void navigate({ to: '/journal' })}
        >
          Journal
        </button>
        <button
          type="button"
          className={joinClass(styles.dashBtn, dashboardActive && styles.dashBtnActive)}
          onClick={() => {
            if (dashboardActive) return;
            void navigate(lastDashboardTarget.current);
          }}
        >
          Dashboard
        </button>
        {/* Terrain holds this slot instead of Research (her call — it's the
            surface she actually works from now). Research kept its route and
            moved into the More menu. startsWith, not equality: the terrain is
            several full pages sharing the /terrain prefix (/terrain/map, where
            /terrain lands, plus the rooms /terrain/usage and /terrain/sql),
            and the tab stays lit in every one of them. */}
        <button
          type="button"
          className={joinClass(
            styles.dashBtn,
            location.pathname.startsWith('/terrain') && styles.dashBtnActive,
          )}
          onClick={() => void navigate({ to: '/terrain' })}
        >
          Terrain
        </button>
        <button
          type="button"
          className={joinClass(
            styles.dashBtn,
            styles.gearBtn,
            location.pathname === '/settings' && styles.dashBtnActive,
          )}
          onClick={() => void navigate({ to: '/settings' })}
          title="Settings"
          aria-label="Settings"
        >
          &#9881;&#65038;
        </button>
      </div>

      {dashboardActive ? <DashboardTabRow pathname={location.pathname} /> : null}
    </>
  );
}
