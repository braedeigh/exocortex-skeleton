import { useNavigate } from '@tanstack/react-router';
import type { NightRun } from './NightCrewLane';
import styles from './NightCrew.module.css';

/**
 * NightCrewDoor — where the Night crew section used to sit on the roster: one
 * tappable row that says what's waiting and goes to /observatory/nightcrew.
 *
 * WHY IT'S A DOOR NOW (her 08-21 call: "i want it inside its own route inside
 * of observatory... you scroll down and can click into it from that location").
 * Night crew was the tallest thing on the roster and the least like it. The
 * roster is a standing-and-scanning surface — walk in, see what's yours, act.
 * Night crew is the opposite: work already finished, read once in the morning,
 * on cards carrying diffs, screenshots, costs, merge buttons and a compose box.
 * A reading surface wearing a scanning surface's clothes, pushing her two
 * actual rooms down the scroll. So it got a page, and this is the way in — left
 * exactly where the section was, because that's where she already scrolls to
 * look for it.
 *
 * A DOOR MUST NOT GO SILENT. Same rule as a collapsed room (LaneHead): if
 * something in there is waiting on a verdict, this row has to say so, or the
 * queue becomes a graveyard and the door is what buried it. So the census rides
 * the door — the ready count, what's teed up for tonight, what last night cost
 * — and the row warms when anything is actually waiting. What it does NOT do is
 * pull her through: it goes loud, it doesn't navigate for her.
 *
 * Deliberately NOT counted by the rail's colour buttons. Those count the
 * sessions the ROOMS draw (roomRoster in sessionFilters.ts); night crew is its
 * own place now and reports itself, here.
 */
export function NightCrewDoor({
  runs,
  queued,
  spendUsd,
}: {
  runs: NightRun[];
  /** How many notes are green-lit and would pass the gate tonight. */
  queued: number;
  spendUsd: number;
}) {
  const navigate = useNavigate();
  const live = runs.filter((r) => !r.dismissed);
  const ready = live.filter((r) => r.status === 'ready').length;

  // The second line, in order of what actually asks something of her: what's
  // finished but unjudged, else what's still being built, else what's queued
  // for tonight, else the plain truth that nothing is pending. One sentence —
  // a door that tried to report everything would be the room it replaced.
  const building = live.length - ready;
  const line =
    ready > 0
      ? `${ready} finished, waiting on your verdict`
      : building > 0
        ? `${building} still being built`
        : queued > 0
          ? `Nothing waiting. ${queued} note${queued === 1 ? '' : 's'} teed up for tonight.`
          : 'Nothing waiting, and nothing green-lit for tonight.';

  return (
    <button
      type="button"
      className={[styles.door, ready > 0 ? styles.doorWanting : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/nightcrew' })}
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>
          Night crew
          {ready > 0 ? <span className={styles.doorReady}>{ready} ready</span> : null}
        </span>
        <span className={styles.doorLine}>{line}</span>
      </span>
      {/* Cost sits at the far end, muted: present so a month can't surprise
          her, quiet so it isn't the first thing she reads at 6 AM. */}
      <span className={styles.doorSpend}>${spendUsd.toFixed(2)}</span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
