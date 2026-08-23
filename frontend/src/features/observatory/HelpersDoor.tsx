import { useNavigate } from '@tanstack/react-router';
import type { HelpersState } from './api';
import styles from './NightCrew.module.css';

/**
 * HelpersDoor — the row at the bottom of the roster that goes to
 * /observatory/helpers: the small Claude jobs a button fires (🧭 Triage, a
 * recipe or receipt parse, a person impression) and everything they've run
 * before.
 *
 * WHY A DOOR (her 08-22 call: "built into the observatory as a section at the
 * bottom so I can see what has run in the past, like the night crew room that
 * I have to click to open"). These sessions aren't hers to scan — she pressed
 * a button somewhere else and a job ran. Listing them in the rooms buried her
 * own conversations under receipts. So they live behind a door, same shape and
 * same spot as the Night crew's, where the "System agents — coming later" note
 * used to sit.
 *
 * SAME RULE AS THE NIGHT CREW DOOR: it must not go silent. If a job is running
 * or the last one failed, the row says so and warms; it never navigates for
 * her. Borrows NightCrew.module.css's door styles outright so the two doors
 * read as one idiom.
 */
export function HelpersDoor({ state }: { state: HelpersState | null }) {
  const navigate = useNavigate();
  const runs = state?.runs ?? [];
  const running = state?.running ?? 0;
  const failed = state?.failed ?? 0;
  const latest = runs[0];

  // One sentence, in order of what asks something of her: a job still going,
  // else a failure she hasn't seen, else the last thing that ran.
  const line =
    running > 0
      ? `${running} running now`
      : failed > 0
        ? `${failed} failed — worth a look`
        : latest
          ? `Last: ${latest.label}${latest.title ? ` · ${latest.title}` : ''}`
          : 'Nothing has run yet. Triage, recipe and receipt parses land here.';

  const wanting = running > 0 || failed > 0;

  return (
    <button
      type="button"
      className={[styles.door, wanting ? styles.doorWanting : ''].filter(Boolean).join(' ')}
      onClick={() => void navigate({ to: '/observatory/helpers' })}
      data-track="observatory-helpers-door"
    >
      <span className={styles.doorMain}>
        <span className={styles.doorTitle}>
          Helpers
          {failed > 0 ? <span className={styles.doorReady}>{failed} failed</span> : null}
        </span>
        <span className={styles.doorLine}>{line}</span>
      </span>
      <span className={styles.doorSpend}>{runs.length} run{runs.length === 1 ? '' : 's'}</span>
      <span className={styles.doorArrow} aria-hidden="true">
        &rarr;
      </span>
    </button>
  );
}
