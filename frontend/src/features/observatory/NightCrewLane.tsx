import { useState } from 'react';
import { LaneHead, useLaneOpen } from './LaneHead';
import styles from './NightCrew.module.css';

/**
 * NightCrewLane — the Observatory's last room, and the only place last
 * night's work is answered.
 *
 * WHY IT'S ITS OWN ROOM. The session lanes are defined by whether she's
 * watching: Personal and Coding just act because she's there; Orchestra stops
 * to ask before anything irreversible. The night crew can do neither — she's
 * asleep,
 * so it can't ask, and an agent that can't ask must be structurally unable to
 * do the thing worth asking about. Every attempt happens in a throwaway
 * worktree on its own branch: nothing merges, nothing restarts the service,
 * nothing touches the live checkout. The permission model IS the room.
 *
 * FINISHED-AND-WAITING, not live (Sunflower). The other lanes are quiet until
 * active; this one inverts it — nothing here is ever running, everything is
 * done and holding for a verdict. So the only hierarchy is ready vs couldn't,
 * and `ready` floats to the top because it's the one card that asks her for
 * something.
 *
 * THE SCREENSHOT LEADS, THE DIFF FOLDS AWAY (Sunflower's call, confirmed with
 * her). She reads her own app, not diffs — a before/after answers "is this
 * right?" in about a second, where a diff asks a question she isn't the best
 * person in the room to answer. The diff stays one tap behind a summary line
 * for when she does want it. Deference: the interface recedes so the content —
 * her actual app — does the talking.
 *
 * Reads GET /api/nightcrew (routes/nightcrew.py). Merge is the only control
 * that reaches her real branch, so it confirms first and the server refuses
 * anything it isn't sure about (dirty tree, conflict, non-ready run) — a
 * merge failure lands back on the card in plain words rather than as a git
 * dump she'd have to decode.
 */

export interface NightRun {
  id: string;
  note_id: string;
  tab: string;
  note_text: string;
  status: 'ready' | 'failed' | 'parked' | 'merged';
  branch?: string;
  diff_stat?: string;
  test_tail?: string;
  shot_before?: string;
  shot_after?: string;
  cost_usd?: number;
  finished?: string;
  /** Why a failed/parked run stopped. Kept forever even after the branch is
   * swept, so the next worker on this note reads what beat the last one. */
  reason?: string;
  dismissed?: boolean;
}

/* The card's whole visual vocabulary in one table, the way SessionLane does it
   — adding a status is a row here and a rule in the stylesheet, never another
   branch buried in the markup. */
const STATUS: Record<NightRun['status'], { cls: string; dot: string; label: string }> = {
  ready: { cls: 'cardReady', dot: 'dotReady', label: 'ready for you' },
  failed: { cls: 'cardFailed', dot: 'dotFailed', label: "couldn't" },
  parked: { cls: 'cardParked', dot: 'dotParked', label: 'parked' },
  merged: { cls: 'cardMerged', dot: 'dotMerged', label: 'merged' },
};

function Card({
  run,
  onDismiss,
  onMerge,
}: {
  run: NightRun;
  onDismiss: (id: string) => void;
  onMerge: (id: string) => Promise<string | null>;
}) {
  const [showDiff, setShowDiff] = useState(false);
  // Merging writes to her real branch, so it confirms first — the same
  // two-tap shape the rest of the app uses for anything destructive.
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const s = STATUS[run.status];
  const hasShots = Boolean(run.shot_before && run.shot_after);

  function merge() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    setMerging(true);
    onMerge(run.id)
      .then(setMergeError)
      .finally(() => setMerging(false));
  }

  return (
    <article className={`${styles.card} ${styles[s.cls]}`}>
      <header className={styles.cardHead}>
        <span className={`${styles.dot} ${styles[s.dot]}`} aria-hidden />
        <span className={styles.status}>{s.label}</span>
        <span className={styles.tab}>{run.tab}</span>
      </header>

      {/* Her own words are the title — she recognises the note before she
          recognises anything we'd write about it. */}
      <p className={styles.noteText}>{run.note_text}</p>

      {hasShots && (
        <div className={styles.shots}>
          <figure className={styles.shot}>
            <img src={run.shot_before} alt="before" loading="lazy" />
            <figcaption>before</figcaption>
          </figure>
          <figure className={styles.shot}>
            <img src={run.shot_after} alt="after" loading="lazy" />
            <figcaption>after</figcaption>
          </figure>
        </div>
      )}

      {/* A failed or parked run owes her one plain sentence about what beat it.
          Anything less and the card is a shrug she has to go investigate. */}
      {run.reason && <p className={styles.reason}>{run.reason}</p>}

      {run.diff_stat && (
        <>
          <button
            type="button"
            className={styles.diffToggle}
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            <span className={styles.chevron} data-open={showDiff || undefined}>›</span>
            {run.diff_stat}
          </button>
          {showDiff && (
            <pre className={styles.tail}>{run.test_tail || 'no test output recorded'}</pre>
          )}
        </>
      )}

      {/* A merge that couldn't happen has to say why in her words, not git's —
          "you have uncommitted changes" is actionable, a conflict dump is not. */}
      {mergeError && <p className={styles.mergeError}>{mergeError}</p>}

      <footer className={styles.actions}>
        {run.status === 'ready' && (
          <button
            type="button"
            className={confirming ? styles.mergeConfirm : styles.merge}
            disabled={merging}
            onClick={merge}
          >
            {merging ? 'Merging…' : confirming ? 'Merge for real?' : 'Merge'}
          </button>
        )}
        {run.status === 'merged' && <span className={styles.merged}>merged</span>}
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => onDismiss(run.id)}
        >
          {run.status === 'ready' ? 'Discard' : 'Clear'}
        </button>
        {run.cost_usd != null && (
          <span className={styles.cost}>${run.cost_usd.toFixed(2)}</span>
        )}
      </footer>
    </article>
  );
}

export function NightCrewLane({
  runs,
  queued,
  spendUsd,
  onDismiss,
  onMerge,
}: {
  runs: NightRun[];
  /** How many notes are green-lit and would pass the gate tonight. */
  queued: number;
  spendUsd: number;
  onDismiss: (id: string) => void;
  /** Resolves to an error message to show on the card, or null on success. */
  onMerge: (id: string) => Promise<string | null>;
}) {
  const live = runs.filter((r) => !r.dismissed);
  const ready = live.filter((r) => r.status === 'ready').length;
  const [open, toggleOpen] = useLaneOpen('nightcrew');

  // Collapses like every other room on the page (LaneHead.tsx), and for the
  // same reason its siblings do: the census rides the HEADER, so a shut Night
  // crew still says how many attempts are waiting on a verdict and what last
  // night cost. Nothing that wants her is behind the fold.
  const head = (
    <LaneHead heading="Night crew" open={open} onToggle={toggleOpen} wanting={ready > 0}>
      {/* Only ever one number in the heading, and it's the one that asks
          something of her. Cost sits muted on the right — present so it can
          never surprise her at the end of a month, quiet so it isn't the
          first thing she reads at 6 AM. */}
      {ready > 0 && <span className={styles.readyCount}>{ready} ready</span>}
      <span className={styles.spend}>${spendUsd.toFixed(2)} last night</span>
    </LaneHead>
  );

  if (!open) {
    return <section className={styles.lane}>{head}</section>;
  }

  return (
    <section className={styles.lane}>
      {head}
      <p className={styles.blurb}>
        Work done while you slept. It fixes one green-lit note per branch in a
        throwaway worktree, runs the tests, and stops — nothing merges without
        you.
      </p>

      {live.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden />
          {queued > 0
            ? `Nothing to review. ${queued} note${queued === 1 ? '' : 's'} teed up for tonight.`
            : 'Nothing to review, and nothing green-lit for tonight.'}
        </div>
      ) : (
        <div className={styles.rows}>
          {live.map((run) => (
            <Card key={run.id} run={run} onDismiss={onDismiss} onMerge={onMerge} />
          ))}
        </div>
      )}
    </section>
  );
}
