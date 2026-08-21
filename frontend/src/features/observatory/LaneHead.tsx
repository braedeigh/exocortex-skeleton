import { useCallback, useState, type ReactNode } from 'react';
import styles from './LaneHead.module.css';

/**
 * LaneHead — the title line every room on the Observatory wears, and the thing
 * that opens and shuts it.
 *
 * WHY IT'S SHARED. The roster is rooms stacked down one page (Personal,
 * Coding, Night crew) and it had grown taller than a phone. Rather than each
 * section inventing its own header and its own chevron, the heading itself IS
 * the control, once, here — so collapsing is the same gesture in every room and
 * the page reads as one object instead of a pile of parts.
 *
 * A SHUT ROOM MUST NOT GO SILENT. That's the whole design risk: if a room
 * is collapsed while a session raises an approval card, she'd never see it,
 * and the queue becomes a graveyard (Terra). So the census — "2 need you", "1
 * running", the resting count — sits on the HEADER, outside the body, and
 * stays visible shut. A room with something waiting on her also keeps the
 * orange, so a closed hot room still reads as hot from across the page. What's
 * deliberately NOT done: forcing a room open because it wants her. Her hand
 * outranks ours; the header goes loud, it doesn't overrule her.
 *
 * Open/shut is remembered per room in localStorage — a layout preference, not
 * live state, so it should survive a reload the way the sort toggle does.
 *
 * THE ROOM'S OWN '+'. A header can also carry a "start one here" button, sat
 * at the far end of the line. The point is that the room is decided by WHERE
 * she tapped rather than by a field she fills in afterwards — the thumb has
 * already answered the question, so the sheet shouldn't ask it again. It's at
 * the opposite end from the title block on purpose: the title IS the collapse
 * control, and an action pressed up against it would get fat-fingered into
 * shutting the room. Optional — a room with nothing to create (Night crew)
 * simply doesn't pass one.
 *
 * Used by SessionLane.tsx (Personal / Coding) and NightCrewLane.tsx.
 *
 * [prompt: "a way to easily create new chats in each section — a + button next
 * to the word 'personal' or 'coding'"]
 */

const OPEN_PREFIX = 'exo-observatory-open:';

/** Remembered open/shut for one room. Default OPEN: the first time she loads
 * this after the change, nothing should have disappeared on her — collapsing
 * is something she chooses, not something the page did while she wasn't
 * looking. */
export function useLaneOpen(key: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(OPEN_PREFIX + key);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {
      // localStorage unavailable — fall through to the default
    }
    return defaultOpen;
  });

  const toggle = useCallback(() => {
    setOpen((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(OPEN_PREFIX + key, next ? '1' : '0');
      } catch {
        // state just won't persist
      }
      return next;
    });
  }, [key]);

  return [open, toggle];
}

export function LaneHead({
  heading,
  open,
  onToggle,
  /** Whether anything in this room is waiting on her. Tints the whole header,
   * so a SHUT room that wants her still says so. */
  wanting = false,
  /** Start something in THIS room. Omit it and no '+' is drawn. */
  onNew,
  /** The counts, in the room's own words ("2 need you", "1 running", "$0.40
   * last night"). Lives on the header rather than in the body precisely so it
   * survives being collapsed. */
  children,
}: {
  heading: string;
  open: boolean;
  onToggle: () => void;
  wanting?: boolean;
  onNew?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={[styles.head, wanting ? styles.headWanting : ''].filter(Boolean).join(' ')}>
      {/* The heading is the button — a separate chevron beside a title is a
          second small target for one action. Full width of the title block,
          40px tall, so it's a thumb's worth of room on the phone. */}
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={onToggle}
        title={open ? `Collapse ${heading}` : `Open ${heading}`}
      >
        <span
          className={[styles.arrow, open ? styles.arrowOpen : ''].filter(Boolean).join(' ')}
          aria-hidden="true"
        >
          &#9654;
        </span>
        <h2 className={styles.heading}>{heading}</h2>
      </button>
      {children}
      {/* Pushed to the far end of the line by its own auto margin, so it lands
          in the same place in every room whether or not the census beside the
          heading has anything to say that tick. */}
      {onNew ? (
        <button
          type="button"
          className={styles.new}
          onClick={onNew}
          title={`New session in ${heading}`}
          aria-label={`New session in ${heading}`}
        >
          +
        </button>
      ) : null}
    </div>
  );
}
