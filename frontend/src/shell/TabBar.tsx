import { useState } from 'react';
import { Link, useNavigate, useLocation } from '@tanstack/react-router';
import { Sheet, TapRow } from '../ui';
import { VALID_TABS, TAB_META, VIEW_META, type LegacyTab } from './tabs';
import styles from './TabBar.module.css';

const PRIMARY_TABS = new Set<LegacyTab>(['today', 'map', 'kitchen']);
const PRIMARY_PATHS = ['/legacy/today', '/todos', '/legacy/map', '/legacy/kitchen'];

/**
 * Bottom tab bar — touch-first, ≥40px targets, fixed under the active route.
 * 5 slots: Today / Todos / Map / Kitchen / More. More opens a Sheet listing
 * every other legacy tab plus Journal/Research/Settings/Files.
 *
 * Hidden entirely for public (unauthenticated) visitors, mirroring
 * split.html's `body.public-mode .tab-bar { display: none; }` — the frosted
 * dashboard tabs a stranger can reach still have their own in-page nav
 * (postMessage 'tab' -> frameBridge), so nothing is stranded.
 */
export function TabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') return null;

  const moreTabs = VALID_TABS.filter((tab) => !PRIMARY_TABS.has(tab));
  const isMoreActive = !PRIMARY_PATHS.includes(location.pathname);
  const closeMore = () => setMoreOpen(false);

  return (
    <>
      <nav className={styles.bar} aria-label="Primary">
        <Link
          to="/legacy/$tab"
          params={{ tab: 'today' }}
          className={styles.tab}
          activeProps={{ className: styles.active }}
        >
          <span className={styles.icon} aria-hidden="true">
            {TAB_META.today.icon}
          </span>
          <span>{TAB_META.today.label}</span>
        </Link>
        <Link to="/todos" className={styles.tab} activeProps={{ className: styles.active }}>
          <span className={styles.icon} aria-hidden="true">
            ✓
          </span>
          <span>Todos</span>
        </Link>
        <Link
          to="/legacy/$tab"
          params={{ tab: 'map' }}
          className={styles.tab}
          activeProps={{ className: styles.active }}
        >
          <span className={styles.icon} aria-hidden="true">
            {TAB_META.map.icon}
          </span>
          <span>{TAB_META.map.label}</span>
        </Link>
        <Link
          to="/legacy/$tab"
          params={{ tab: 'kitchen' }}
          className={styles.tab}
          activeProps={{ className: styles.active }}
        >
          <span className={styles.icon} aria-hidden="true">
            {TAB_META.kitchen.icon}
          </span>
          <span>{TAB_META.kitchen.label}</span>
        </Link>
        <button
          type="button"
          className={[styles.tab, isMoreActive ? styles.active : ''].filter(Boolean).join(' ')}
          onClick={() => setMoreOpen(true)}
        >
          <span className={styles.icon} aria-hidden="true">
            ⋯
          </span>
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} title="More" onClose={closeMore}>
        {moreTabs.map((tab) => {
          const meta = TAB_META[tab];
          return (
            <TapRow
              key={tab}
              trailing={
                <span aria-hidden="true" className={styles.sheetIcon}>
                  {meta.icon}
                </span>
              }
              onClick={() => {
                closeMore();
                void navigate({ to: '/legacy/$tab', params: { tab } });
              }}
            >
              {meta.label}
            </TapRow>
          );
        })}
        {VIEW_META.map((view) => (
          <TapRow
            key={view.key}
            trailing={
              <span aria-hidden="true" className={styles.sheetIcon}>
                {view.icon}
              </span>
            }
            onClick={() => {
              closeMore();
              void navigate({ to: view.to });
            }}
          >
            {view.label}
          </TapRow>
        ))}
      </Sheet>
    </>
  );
}
