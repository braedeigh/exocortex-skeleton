import { useEffect, useState } from 'react';

/**
 * Tracks which of `keys` have survived at least one animation frame since
 * being mounted.
 *
 * Works around the "terminal pane can get stuck empty... loads fine if i
 * click another tab and then navigate back" dev note: a same-origin iframe
 * that's `display: block` from the instant it's inserted can paint blank on
 * WebKit/Chromium and never recover on its own — the fix that clicking
 * another (top-level) tab and back stumbles into is that navigating changes
 * a flex sibling's content, forcing a layout pass that happens to carry the
 * iframe's box through an off->on-equivalent repaint. TerminalFrames/
 * FrameHost/PhoneFrames all keep every visited iframe permanently mounted
 * and only toggle CSS `display` on it (see their header comments), so we can
 * force that same off->on cycle deliberately for every iframe the instant it
 * mounts, instead of leaning on the user finding the workaround by accident:
 * a newly-added key renders `display: none` for one frame, then flips to
 * whatever its real visibility should be.
 */
export function useSettledFrames(keys: readonly string[]): Set<string> {
  const [settled, setSettled] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const fresh = keys.filter((k) => !settled.has(k));
    if (fresh.length === 0) return;
    const id = requestAnimationFrame(() => {
      setSettled((prev) => {
        const next = new Set(prev);
        for (const k of fresh) next.add(k);
        return next;
      });
    });
    return () => cancelAnimationFrame(id);
  }, [keys, settled]);

  return settled;
}
