import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from '@tanstack/react-router';
import { Sheet, TapRow } from '../ui';
import { TAB_META, TAB_ROUTES, VIEW_META, isValidTab, tabForPath, type LegacyTab } from './tabs';
import { useMediaQuery, DESKTOP_QUERY } from './useMediaQuery';
import { useSessionsContext } from './SessionsContext';
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
 * Hidden entirely for public (unauthenticated) visitors, mirroring
 * split.html's `body.public-mode .dash-bar { display: none; }`.
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

// Always-in-More legacy tabs, in the order given in the spec (templates/index.html
// more-menu order differs slightly; this is the order Bradie asked for).
const ALWAYS_MORE_TABS: ReadonlyArray<{ tab: LegacyTab; label: string }> = [
  { tab: 'people', label: 'People' },
  { tab: 'inventory', label: 'Inventory' },
  { tab: 'housing', label: 'Housing' },
  { tab: 'car', label: 'Car Maintenance' },
].filter((entry): entry is { tab: LegacyTab; label: string } => isValidTab(entry.tab));

// Full Flask pages — not SPA routes, so plain <a href> (full page load), not <Link>.
const FULL_PAGE_LINKS: ReadonlyArray<{ key: string; label: string; href: string }> = [
  { key: 'keeper', label: 'Keeper', href: '/keeper' },
  { key: 'personality', label: 'Personality', href: '/personality' },
];

// Journal/Research/Settings moved to row 1 (the dash bar) — Files and the
// /notes browser page (native route, not a dashboard tab) live in the More
// menu instead.
const MORE_VIEWS = VIEW_META.filter((v) => v.key === 'files' || v.key === 'notes');

type ActiveKey = 'today' | LegacyTab | `view:${(typeof VIEW_META)[number]['key']}` | null;

function useActiveKey(pathname: string): ActiveKey {
  return useMemo<ActiveKey>(() => {
    const native = tabForPath(pathname);
    if (native) return native;
    const legacyMatch = /^\/legacy\/([^/]+)$/.exec(pathname);
    if (legacyMatch && isValidTab(legacyMatch[1])) return legacyMatch[1];
    const view = MORE_VIEWS.find((v) => v.to === pathname);
    if (view) return `view:${view.key}`;
    return null;
  }, [pathname]);
}

/** Dashboard routes are every native tab route (plus /legacy/<tab> fallbacks)
 * — the routes that, in the old app, lived inside the dashboard iframe under
 * row 2. */
type DashboardTarget = { to: string };

function parseDashboardTarget(pathname: string): DashboardTarget | null {
  if (tabForPath(pathname)) return { to: pathname };
  const legacyMatch = /^\/legacy\/([^/]+)$/.exec(pathname);
  if (legacyMatch && isValidTab(legacyMatch[1])) return { to: pathname };
  return null;
}

function joinClass(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

interface MoreMenuContentProps {
  overflowed: readonly LegacyTab[];
  activeKey: ActiveKey;
  onNavigate: () => void;
}

function MoreMenuContent({ overflowed, activeKey, onNavigate }: MoreMenuContentProps) {
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
      {ALWAYS_MORE_TABS.map(({ tab, label }) => (
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
      {FULL_PAGE_LINKS.map((link) => (
        <a key={link.key} href={link.href} className={styles.menuLink} onClick={onNavigate}>
          {link.label}
        </a>
      ))}
      {MORE_VIEWS.map((view) => (
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
 * Row 2 — the legacy dashboard tab strip (To Do / Life Map / Kitchen / optional
 * tabs / More ▾). Only ever mounted while a dashboard route is active (see
 * TopTabs below), so it's its own component: mounting fresh each time it
 * reappears re-runs the layout()-on-mount effect below, which is what makes
 * the ResizeObserver measurement correct again after being unmounted.
 */
function DashboardTabRow({ pathname }: { pathname: string }) {
  const [overflowed, setOverflowed] = useState<readonly LegacyTab[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

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
    for (const tab of OPTIONAL_TABS) {
      const el = optionalRefs.current[tab];
      if (el) el.style.display = 'inline-flex';
    }
    const newOverflow: LegacyTab[] = [];
    for (let i = OPTIONAL_TABS.length - 1; i >= 0; i--) {
      if (row.scrollWidth <= row.clientWidth) break;
      const tab = OPTIONAL_TABS[i];
      if (tab === activeKey) continue;
      const el = optionalRefs.current[tab];
      if (el) el.style.display = 'none';
      newOverflow.unshift(tab);
    }
    if (row.scrollWidth > row.clientWidth && OPTIONAL_TABS.includes(activeKey as LegacyTab)) {
      const activeTab = activeKey as LegacyTab;
      const el = optionalRefs.current[activeTab];
      if (el) el.style.display = 'none';
      const idx = OPTIONAL_TABS.indexOf(activeTab);
      let at = newOverflow.findIndex((t) => OPTIONAL_TABS.indexOf(t) > idx);
      if (at === -1) at = newOverflow.length;
      newOverflow.splice(at, 0, activeTab);
    }
    // Leave inline styles exactly matching the decision — the committed state
    // re-applies the same answer via the .hidden class, so render and
    // measurement never fight.
    for (const tab of OPTIONAL_TABS) {
      const el = optionalRefs.current[tab];
      if (el) el.style.display = newOverflow.includes(tab) ? 'none' : 'inline-flex';
    }
    setOverflowed((prev) =>
      prev.length === newOverflow.length && prev.every((t, i) => t === newOverflow[i]) ? prev : newOverflow,
    );
  }, [activeKey]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(row);
    return () => ro.disconnect();
  }, [layout]);

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

  const overflowedActive = OPTIONAL_TABS.includes(activeKey as LegacyTab) && overflowed.includes(activeKey as LegacyTab);
  const alwaysMoreMatch = ALWAYS_MORE_TABS.find((t) => t.tab === activeKey);
  const viewMatch = MORE_VIEWS.find((v) => `view:${v.key}` === activeKey);

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
    <div className={styles.strip}>
      <div className={styles.row} ref={rowRef}>
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
        {OPTIONAL_TABS.map((tab) => (
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
            <MoreMenuContent overflowed={overflowed} activeKey={activeKey} onNavigate={closeMore} />
          </div>
        ) : null}
      </div>

      {!isDesktop ? (
        <Sheet open={moreOpen} title="More" onClose={closeMore}>
          <MoreMenuContent overflowed={overflowed} activeKey={activeKey} onNavigate={closeMore} />
        </Sheet>
      ) : null}
    </div>
  );
}

export function TopTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Mobile Chat tab's label (the active tmux session name) + the /chat
  // session picker's toggle — shared with ChatPage via SessionsContext, so
  // switching sessions there updates the label immediately, and tapping the
  // Chat tab while on /chat opens/closes the picker ChatPage renders.
  const sessions = useSessionsContext();
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

  if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') return null;

  return (
    <>
      <div className={styles.dashBar}>
        {!isDesktop ? (
          // Mobile only — desktop already has the terminal permanently docked
          // in the left split pane (SplitLayout), no need for a tab to it.
          // A second tap while already on /chat toggles the session picker
          // row instead (rendered by ChatPage, shared via SessionsContext).
          <button
            type="button"
            className={joinClass(styles.dashBtn, styles.chatBtn, location.pathname === '/chat' && styles.dashBtnActive)}
            aria-expanded={location.pathname === '/chat' ? sessions.pickerOpen : undefined}
            onClick={() => {
              if (location.pathname === '/chat') sessions.togglePicker();
              else void navigate({ to: '/chat' });
            }}
          >
            <span className={styles.chatLabel}>{sessions.active || 'Chat'}</span>
          </button>
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
        <button
          type="button"
          className={joinClass(styles.dashBtn, location.pathname === '/research' && styles.dashBtnActive)}
          onClick={() => void navigate({ to: '/research' })}
        >
          Research
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
