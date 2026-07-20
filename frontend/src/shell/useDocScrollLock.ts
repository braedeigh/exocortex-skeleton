import { useEffect } from 'react';

/**
 * Document scroll lock (dev note 9e7ee56f: "clicked 'done' on one of the
 * to-dos [and] a huge empty block of the page came up from the bottom").
 *
 * Nothing in the app ever scrolls the document on purpose — body is
 * overflow:hidden (index.css) and every pane scrolls internally — yet iOS
 * Safari/PWA still scrolls the *document itself* in some situations (keeping
 * a focused input visible above the software keyboard is the known one), and
 * can leave the page stuck at that offset, showing the tail of the layout as
 * a big blank block risen from the bottom. A first fix (2026-07-09) snapped
 * the scroll back on focusout of text inputs; the bug kept reproducing on
 * plain checkbox taps, so whatever scrolls the document isn't only the
 * keyboard path.
 *
 * Rather than chase the mechanism again, enforce the invariant itself: any
 * document-level scroll gets snapped back to 0 the moment it happens. The
 * one legitimate stray offset — iOS holding a focused text field visible
 * above the keyboard — is exempted while such an element has focus, and
 * corrected as soon as the keyboard goes away (visualViewport resize /
 * focusout). Inner-pane scrolling is untouched: scroll events don't bubble,
 * so the window listener only ever sees document scrolls.
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image',
]);

/** True while an element that summons the software keyboard has focus. */
function keyboardMayHoldViewport(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  return false;
}

function snapBack() {
  const el = document.scrollingElement || document.documentElement;
  if (window.scrollY !== 0 || el.scrollTop !== 0) window.scrollTo(0, 0);
}

export function useDocScrollLock() {
  useEffect(() => {
    const onScroll = () => {
      if (!keyboardMayHoldViewport()) snapBack();
    };

    // Keyboard dismissed (or any visual-viewport change) — if no text entry
    // holds focus anymore, whatever offset the keyboard left is stray.
    const onViewportChange = () => {
      if (!keyboardMayHoldViewport()) snapBack();
    };

    // Focus left a text field but iOS kept it as activeElement-less scroll:
    // give the keyboard-dismiss viewport change a beat to land, then correct.
    const onFocusOut = () => {
      setTimeout(() => {
        if (!keyboardMayHoldViewport()) snapBack();
      }, 350);
    };

    window.addEventListener('scroll', onScroll);
    window.visualViewport?.addEventListener('resize', onViewportChange);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
}
