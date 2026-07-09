import { getActiveSnapshot, getFrameWindows } from './frameStore';
import styles from './ScrollTopStrip.module.css';

/**
 * A slim, otherwise-invisible tap target pinned to the very top of the
 * viewport ("I want it such that when you click the top of the page like
 * tap the top on PWA it scrolls up to the top of the page like in other
 * apps. Like the top corner"). In an installed iOS PWA there's no browser
 * chrome, so the native "tap the status bar to scroll to top" gesture never
 * fires — this recreates it app-wide, in the shell, rather than per-page.
 *
 * Sits inside TopTabs' own safe-area padding band (dashBar has
 * `padding-top: env(safe-area-inset-top)` and nothing interactive lives
 * there), so it doesn't cover any real button even at a generous height on
 * notched phones.
 */
export function ScrollTopStrip() {
  const scrollActiveToTop = () => {
    // A legacy tab/journal/research/etc. is showing inside a same-origin
    // FrameHost iframe — its own document scrolls (see static/css/style.css;
    // it doesn't have index.css's body{overflow:hidden}), so scroll that.
    const activeKey = getActiveSnapshot();
    if (activeKey) {
      const win = getFrameWindows().get(activeKey);
      if (win) {
        try {
          win.scrollTo({ top: 0, behavior: 'smooth' });
        } catch {
          // cross-origin or torn-down frame — nothing we can do
        }
      }
      return;
    }
    // Native route (e.g. /todos): the page itself never scrolls
    // (index.css), each route owns its own overflow-y:auto container —
    // smooth-scroll whichever descendant of the content host is actually
    // scrolled, so this doesn't need every page to opt in individually.
    const host = document.getElementById('content-host');
    if (!host) return;
    const candidates: Element[] = [host, ...host.querySelectorAll('*')];
    for (const el of candidates) {
      if (el instanceof HTMLElement && el.scrollTop > 0) {
        el.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  };

  return (
    <button
      type="button"
      className={styles.strip}
      aria-label="Scroll to top"
      onClick={scrollActiveToTop}
    />
  );
}
