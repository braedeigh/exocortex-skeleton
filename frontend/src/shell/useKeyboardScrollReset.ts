import { useEffect } from 'react';

/**
 * iOS keyboard-dismiss scroll reset (dev note 9e7ee56f: "clicked 'done' on
 * one of the to-dos [and] a huge empty block of the page came up from the
 * bottom").
 *
 * Even with body{overflow:hidden} (index.css), iOS Safari/PWA scrolls the
 * *document itself* to keep a focused input visible above the software
 * keyboard — and when the keyboard dismisses (e.g. a tap on a to-do checkbox
 * while the AddBar field or a date picker had focus), it can leave the page
 * stuck at that offset. Since nothing in the app ever scrolls the document
 * on purpose (each pane scrolls internally), the tail of the layout shows as
 * a big blank block risen from the bottom. An investigation ruled out every
 * app-logic cause (no Sheet/toast/spacer is triggered by the toggle path),
 * leaving this browser-native mechanism as the best-supported culprit.
 *
 * Fix: whenever focus leaves a text-entry element, snap any stray document
 * scroll back to 0. A no-op on desktop and whenever the document is already
 * at 0, so it's safe to run globally.
 */
export function useKeyboardScrollReset() {
  useEffect(() => {
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      const isEntry = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
      if (!isEntry) return;
      // Two rAFs: let the keyboard-dismiss viewport change land first, then
      // correct whatever offset it left behind.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.scrollingElement || document.documentElement;
          if (window.scrollY !== 0 || el.scrollTop !== 0) window.scrollTo(0, 0);
        });
      });
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, []);
}
