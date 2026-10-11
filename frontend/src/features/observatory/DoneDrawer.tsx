/**
 * DoneDrawer.tsx — the little shut spot at the foot of a room that holds its
 * done sessions until they close themselves.
 *
 * A session is done when it ran scripts/session_done.py (`done_at`) or handed
 * its work on to a continuation (`retired`). It then counts down two hours
 * before closing. Those cards used to stand as full cards in the room's done
 * band; now SessionLane lifts them in here (roomOrder.foldsIntoDone says who).
 * A card moves in the moment it's marked done and back out when her message
 * clears `done_at`. Nothing is copied: it's the same card, only drawn in a
 * different place.
 *
 * QUIET, LIKE SAVED FOR LATER (SavedLane.tsx): shut by default, open/shut
 * remembered per room (LaneHead.useLaneOpen), and no orange on the line. The
 * one thing it still says out loud is a closing report she hasn't read: a small
 * orange dot and "1 unread", the same dot an unread card wears, so a final
 * report can't slip past her behind the fold.
 *
 * Opened, it holds the ordinary cards, so Keep open and the countdown work as
 * they always do.
 *
 * Touches: SessionLane.tsx (fills it), roomOrder.ts (foldsIntoDone,
 * unreadDone), LaneHead.tsx (useLaneOpen), SessionLane.module.css.
 *
 * [prompt: "automatically minimize all "done" sessions into a little
 * collapsible spot that haven't quite closed yet at the bottom"]
 */
import type { ReactNode } from 'react';
import { useLaneOpen } from './LaneHead';
import styles from './SessionLane.module.css';

export function DoneDrawer({
  laneKey,
  count,
  unread,
  children,
}: {
  /** The room it sits in, so each room remembers its own drawer. */
  laneKey: string;
  /** How many done cards are inside. */
  count: number;
  /** How many of them have a final output she hasn't opened. */
  unread: number;
  /** The done cards themselves, drawn by the room as usual. */
  children: ReactNode;
}) {
  const [open, toggle] = useLaneOpen(`${laneKey}:done`, false);
  return (
    <div className={styles.doneDrawer}>
      <button type="button" className={styles.doneToggle} aria-expanded={open} onClick={toggle}>
        <span
          className={[styles.filesArrow, open ? styles.filesArrowOpen : ''].filter(Boolean).join(' ')}
          aria-hidden="true"
        >
          &#9654;
        </span>
        <span>Done · {count}</span>
        {unread > 0 ? (
          <span className={styles.doneUnread}>
            <span className={styles.doneUnreadDot} aria-hidden="true" />
            {unread} unread
          </span>
        ) : null}
      </button>
      {open ? <div className={styles.rows}>{children}</div> : null}
    </div>
  );
}
