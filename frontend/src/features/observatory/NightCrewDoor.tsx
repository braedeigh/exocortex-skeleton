import { useNavigate } from '@tanstack/react-router';
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
 * A PLAIN DOOR, NO CENSUS (her 09-23 call: "i don't want to load the night
 * crew unless i click on it"). It used to carry a count of what was waiting,
 * which meant fetching /api/nightcrew — a ~1.5s call — every time the roster
 * mounted, i.e. every time she came back to it. Now it's only a way in; the
 * night state loads on NightCrewPage, once she walks through.
 *
 * Deliberately NOT counted by the rail's colour buttons. Those count the
 * sessions the ROOMS draw (roomRoster in sessionFilters.ts); night crew is its
 * own place now, reached through here.
 */
export function NightCrewDoor() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={styles.door}
      onClick={() => void navigate({ to: '/observatory/nightcrew' })}
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>Night crew</span>
        <span className={styles.doorLine}>Open to see last night's runs.</span>
      </span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
