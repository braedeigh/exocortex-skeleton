/**
 * FocusChips.tsx — the fronts filter: one chip per front, plus "All" and
 * "Other" (the untagged). The chips are TOGGLES, not a radio group — tapping
 * adds a front to the selection TodosPage holds, tapping again removes it, and
 * several can be on at once, which matches the data (a to-do carries a fronts
 * LIST, so it can be connection AND health). Several selected shows the union
 * of their items. Emptying the selection is "All", and the All chip clears it
 * in one tap.
 *
 * Every to-do surface on the page reads that selection through
 * todoHelpers.focusMatchAny — so this one row governs Up now, Tomorrow, the
 * four ladder sections, Not now, Snoozed and Waiting all at once. Per-chip
 * counts come from todoHelpers.computeFocusCounts; a front with nothing live
 * gets no chip unless it's already selected.
 *
 * Because it filters the WHOLE page it lives at the top of the page and sticks
 * there while scrolling — it used to sit inside the To Do column, below every
 * surface it was filtering, which made a page-wide control read as a column
 * widget and meant scrolling to the bottom to change what the top showed.
 *
 * Two details earn their code. The strip scrolls sideways (a dozen-plus fronts
 * never fit a phone) and fades at whichever edge still has chips past it —
 * against a hard cut at the screen edge a full row just reads as a complete
 * row, with nothing to say it continues. And the active chip is scrolled into
 * view once on mount, since the filter persists between visits and an
 * off-screen selection otherwise looks like no selection at all.
 *
 * Prompts: "on my dashboard, the fronts are scrollable to filter the entire
 * page's to-dos including the up now page to just that front." / "if you click
 * more than one, more than one shows up, and if you unselect them all, it goes
 * back to all."
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FRONT_EMOJI } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import type { FocusCounts } from './todoHelpers';
import styles from './FocusChips.module.css';

export interface FocusChipsProps {
  counts: FocusCounts;
  /** The selected front ids ('__none__' allowed). Empty = All. */
  selected: string[];
  fronts: Front[];
  /** Flip one front on or off. */
  onToggle: (front: string) => void;
  /** Back to All. */
  onClear: () => void;
}

export function FocusChips({ counts, selected, fronts, onToggle, onClear }: FocusChipsProps) {
  const isOn = (front: string) => selected.includes(front);
  const noneOn = selected.length === 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // Which ends still have chips beyond them. A 1px slack keeps sub-pixel
  // scroll positions from flickering the fade on and off at rest.
  function measure() {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
  }

  // Centre the restored chip by setting scrollLeft directly. scrollIntoView
  // would do it in one line but also scrolls the PAGE vertically to reach a
  // sticky element, landing the view below the greeting on every visit.
  useLayoutEffect(() => {
    const track = trackRef.current;
    const chip = activeRef.current;
    if (track && chip) {
      track.scrollLeft = chip.offsetLeft - (track.clientWidth - chip.offsetWidth) / 2;
    }
    measure();
    // Once, on mount — later taps scroll the strip themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chips come and go as counts move, and the pane is resizable on desktop —
  // either can change whether there's anything left to scroll to.
  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      measure();
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fronts, counts, selected]);

  const trackClass = [
    styles.track,
    edges.start ? styles.fadeStart : '',
    edges.end ? styles.fadeEnd : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.bar}>
      <div className={trackClass} ref={trackRef} onScroll={measure}>
        {/* "All" isn't a front, it's the empty selection — so it reads as on
            only when nothing else is, and tapping it clears rather than
            toggles. It also steps back while a selection is live, so the row
            has one obvious "you are filtering" signal instead of two. */}
        <button
          type="button"
          aria-pressed={noneOn}
          ref={noneOn ? activeRef : undefined}
          className={`${styles.chip} ${noneOn ? styles.active : styles.dimmed}`}
          onClick={onClear}
          data-track="todo-focus-chip"
        >
          All
          <span className={styles.count}>{counts.total}</span>
        </button>
        {fronts.map((f) => {
          const c = counts.byFront[f.id] || 0;
          const on = isOn(f.id);
          if (!c && !on) return null;
          return (
            <button
              type="button"
              key={f.id}
              aria-pressed={on}
              // Anchor the mount scroll on the FIRST selected chip, so a
              // restored multi-front selection lands somewhere sensible.
              ref={on && f.id === selected[0] ? activeRef : undefined}
              className={`${styles.chip} ${on ? styles.active : ''}`}
              onClick={() => onToggle(f.id)}
              data-track="todo-focus-chip"
            >
              {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
              <span className={styles.count}>{c}</span>
            </button>
          );
        })}
        {(counts.none > 0 || isOn('__none__')) && (
          <button
            type="button"
            aria-pressed={isOn('__none__')}
            ref={selected[0] === '__none__' ? activeRef : undefined}
            className={`${styles.chip} ${isOn('__none__') ? styles.active : ''}`}
            onClick={() => onToggle('__none__')}
            data-track="todo-focus-chip"
          >
            🏷️ Other
            <span className={styles.count}>{counts.none}</span>
          </button>
        )}
      </div>
    </div>
  );
}
