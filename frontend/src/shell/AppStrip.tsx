import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { Sheet, TapRow } from '../ui';
import { appStartHref, leaveApp, type AppDef } from './apps';
import { appSectionIds, appTabs, type AppTabItem } from './appTabs';
import { pathOf, sectionForUrl } from './panels/sections';
import { useMediaQuery, DESKTOP_QUERY } from './useMediaQuery';
import { useMenuFit } from './menuFit';
import styles from './TopTabs.module.css';

/**
 * AppStrip.tsx — the one row of tabs an app wears on a phone, and the bar a
 * page gets when it isn't part of the app it was opened in.
 *
 * AppStrip draws exactly the app's own tabs (apps.json, via appTabs.ts), in
 * order. Tabs placed `bar` always show; `fit` tabs show while there's room
 * and slide into More from the end when there isn't; `more` tabs always live
 * in More, with "All apps" (back to the launcher) at the bottom. The
 * measuring is the same pass the old dashboard row made (TopTabs.tsx
 * DashboardTabRow): show every `fit` tab, then hide from the end until the
 * row fits, never hiding the tab she's on while anything else is left.
 *
 * OutsideAppBar is for a page the app doesn't hold — a link out of a session
 * to a page of another app, say. The page opens as it is, with no app's tabs
 * over it and a way back, never a redirect: a link must not dead-end.
 *
 * Touches: TopTabs.tsx (decides which of these to draw), apps.ts,
 * appTabs.ts, TopTabs.module.css (shares its look).
 */

function joinClass(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function tabKey(item: AppTabItem): string {
  return item.kind === 'section' ? item.section.id : item.id;
}

function tabLabel(item: AppTabItem): string {
  return item.kind === 'section' ? item.section.label : item.label;
}

/** Is this tab the page she's on? A tab with claims lights anywhere in its
 * section (the app's own sections win, see sections.ts `prefer`); a shortcut
 * like the Keeper lights only on its own front page. */
function isActive(item: AppTabItem, href: string, activeSectionId: string | null): boolean {
  if (item.kind !== 'section') return false;
  if (item.section.claims.length > 0) return item.section.id === activeSectionId;
  return href === item.section.home || (activeSectionId === null && pathOf(href) === pathOf(item.section.home));
}

export function AppStrip({ app, href }: { app: AppDef; href: string }) {
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const items = useMemo(() => appTabs(app), [app]);
  const fitItems = useMemo(() => items.filter((item) => item.place === 'fit'), [items]);
  const activeSectionId = sectionForUrl(href, appSectionIds(app))?.id ?? null;
  const activeKey = items.find((item) => isActive(item, href, activeSectionId));

  const [overflowed, setOverflowed] = useState<readonly string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const [moreBtn, setMoreBtn] = useState<HTMLButtonElement | null>(null);
  const fitRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const moreFit = useMenuFit(moreBtn, moreOpen && isDesktop);
  const activeId = activeKey ? tabKey(activeKey) : null;

  // Fit the `fit` tabs to the row: show them all, hide from the end until it
  // fits, skipping the active tab until nothing else is left to hide.
  const layout = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    for (const item of fitItems) {
      const el = fitRefs.current[tabKey(item)];
      if (el) el.style.display = 'inline-flex';
    }
    const hidden: string[] = [];
    const hide = (key: string) => {
      const el = fitRefs.current[key];
      if (el) el.style.display = 'none';
      hidden.push(key);
    };
    for (let i = fitItems.length - 1; i >= 0 && row.scrollWidth > row.clientWidth; i--) {
      const key = tabKey(fitItems[i]);
      if (key !== activeId) hide(key);
    }
    if (row.scrollWidth > row.clientWidth && activeId && fitItems.some((item) => tabKey(item) === activeId)) {
      hide(activeId);
    }
    const ordered = fitItems.map(tabKey).filter((key) => hidden.includes(key));
    setOverflowed((prev) =>
      prev.length === ordered.length && prev.every((key, i) => key === ordered[i]) ? prev : ordered,
    );
  }, [fitItems, activeId]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    layout();
    const observer = new ResizeObserver(() => layout());
    observer.observe(row);
    return () => observer.disconnect();
  }, [layout]);

  // Close the menu when she moves, and on a click outside it or Escape.
  useEffect(() => setMoreOpen(false), [href]);
  useEffect(() => {
    if (!isDesktop || !moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) closeMore();
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && closeMore();
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isDesktop, moreOpen, closeMore]);

  // Go where a tab points: a section's front page inside the app, or out to
  // another app's own address.
  const go = (item: AppTabItem) => {
    closeMore();
    if (item.kind === 'link') window.location.href = item.href;
    else void navigate({ to: item.section.home });
  };

  const inMore = items.filter((item) => item.place === 'more' || overflowed.includes(tabKey(item)));
  const moreActive = activeKey !== undefined && inMore.includes(activeKey);
  const menu = (
    <>
      {inMore.map((item) => (
        <TapRow
          key={tabKey(item)}
          className={activeKey === item ? styles.menuActive : undefined}
          onClick={() => go(item)}
        >
          {tabLabel(item)}
        </TapRow>
      ))}
      <TapRow
        onClick={() => {
          closeMore();
          leaveApp();
          void navigate({ to: '/' });
        }}
      >
        All apps
      </TapRow>
    </>
  );

  return (
    <div className={joinClass(styles.strip, styles.appStrip)}>
      <div className={styles.row} ref={rowRef}>
        {items
          .filter((item) => item.place !== 'more')
          .map((item) => {
            const key = tabKey(item);
            return (
              <button
                key={key}
                type="button"
                ref={
                  item.place === 'fit'
                    ? (el) => {
                        fitRefs.current[key] = el;
                      }
                    : undefined
                }
                className={joinClass(
                  styles.tab,
                  activeKey === item && styles.active,
                  overflowed.includes(key) && styles.hidden,
                )}
                onClick={() => go(item)}
              >
                {tabLabel(item)}
              </button>
            );
          })}
      </div>
      <div className={styles.moreWrap} ref={moreWrapRef}>
        <button
          type="button"
          ref={setMoreBtn}
          className={joinClass(styles.tab, moreActive && styles.active)}
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
        >
          {moreActive && activeKey ? tabLabel(activeKey) : 'More'} &#9662;
        </button>
        {isDesktop && moreOpen ? (
          <div
            className={joinClass(styles.dropdown, moreFit?.flipUp && styles.dropdownUp)}
            role="menu"
            style={moreFit ? { maxHeight: moreFit.maxHeight } : undefined}
          >
            {menu}
          </div>
        ) : null}
      </div>
      {!isDesktop ? (
        <Sheet open={moreOpen} title={app.name} onClose={closeMore}>
          {menu}
        </Sheet>
      ) : null}
    </div>
  );
}

/**
 * The bar over a page the window's app doesn't hold (or over any page in a
 * window with no app): back where she came from, or — with nowhere to go
 * back to — to the app's start, or the launcher.
 */
export function OutsideAppBar({ app }: { app: AppDef | null }) {
  const router = useRouter();
  const navigate = useNavigate();
  const back = () => {
    if (window.history.length > 1) router.history.back();
    else if (app) window.location.href = appStartHref(app);
    else void navigate({ to: '/' });
  };
  return (
    <div className={styles.dashBar}>
      <button type="button" className={styles.dashBtn} onClick={back}>
        ← {app ? `Back to ${app.name}` : 'Back'}
      </button>
      {app ? null : (
        <button type="button" className={styles.dashBtn} onClick={() => void navigate({ to: '/' })}>
          All apps
        </button>
      )}
    </div>
  );
}
