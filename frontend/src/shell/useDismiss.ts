import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Dismiss-on-outside-interaction for floating panels (terminal notes,
 * scheduled prompts). Two dev notes drove the exact shape of this:
 *
 * - "when i click out of the bounds of this I want it to go away" — close on
 *   any interaction outside the panel (and its trigger button).
 * - "whenever i click the x or edit it closes the popup... make it such that
 *   it persists for these edits" — a naive `click` listener breaks this: by
 *   the time the bubbled `click` fires, an edit/delete button's own onClick
 *   may already have re-rendered the list (React removes/replaces the row),
 *   so `e.target` can end up detached from the tree and `panel.contains()`
 *   wrongly reports "outside". Checking containment at `pointerdown` — before
 *   any click-triggered state change happens — sidesteps that race entirely.
 *
 * Also closes on window blur, matching the old split.html panels: clicks
 * inside the ttyd iframe never bubble to this document, so a blur is the only
 * signal that the user clicked into the terminal.
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ...refs: Array<RefObject<HTMLElement | null>>
) {
  // Refs (panel/trigger element refs) are stable across renders, but the
  // `refs` *array* itself is a fresh literal every render (rest params), so
  // it can't go in the effect's dependency array without re-subscribing on
  // every render this is open. Stash the latest via a ref instead — read
  // fresh each event, no dependency needed.
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const inside = refsRef.current.some((r) => r.current && r.current.contains(target));
      if (!inside) onClose();
    };
    const onBlur = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);
}
