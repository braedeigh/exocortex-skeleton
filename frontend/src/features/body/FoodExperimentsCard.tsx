import { useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from './CollapsibleCard';
import { canResolveClear, deriveExperimentState, moveInQueue, testDayNumber } from './experimentHelpers';
import type { FoodTest } from './types';
import styles from './FoodExperimentsCard.module.css';

export interface FoodExperimentsCardProps {
  tests: FoodTest[] | undefined;
  queue: string[];
  serverDate: string;
  onStart: (food: string) => void;
  onResolve: (id: string, outcome: 'cleared' | 'flared', flareNotes: string) => void;
  onExtend: (id: string, days: number) => void;
  onCancel: (id: string) => void;
  onClearBaseline: () => void;
  onLogRetro: (food: string, flareNotes: string) => void;
  onQueueAdd: (food: string) => void;
  onQueueRemove: (food: string) => void;
  onQueueReorder: (order: string[]) => void;
}

/**
 * Food experiments card — port of kitchen.js renderFoodExperiments.
 * Controlled reintroduction: one test at a time, recovery gating between.
 * The old confirm()/prompt() dialogs become two-step Sure? buttons and an
 * inline flare-notes form.
 */
export function FoodExperimentsCard({
  tests,
  queue,
  serverDate,
  onStart,
  onResolve,
  onExtend,
  onCancel,
  onClearBaseline,
  onLogRetro,
  onQueueAdd,
  onQueueRemove,
  onQueueReorder,
}: FoodExperimentsCardProps) {
  const { phase, active, recovering, past } = deriveExperimentState(tests);

  // Two-step confirm for destructive/final actions ('cleared' | 'cancel').
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  function twoStep(actionKey: string, run: () => void) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmAction === actionKey) {
      setConfirmAction(null);
      run();
      return;
    }
    setConfirmAction(actionKey);
    confirmTimer.current = setTimeout(() => setConfirmAction(null), 3000);
  }

  // Inline "mark flared" notes form (replaces the old prompt()).
  const [flaring, setFlaring] = useState(false);
  const [flareNotes, setFlareNotes] = useState('');

  const [queueInput, setQueueInput] = useState('');
  const [retroFood, setRetroFood] = useState('');
  const [retroNotes, setRetroNotes] = useState('');

  function submitQueueAdd() {
    const food = queueInput.trim();
    if (!food) return;
    onQueueAdd(food);
    setQueueInput('');
  }

  function moveQueue(food: string, delta: number) {
    const next = moveInQueue(queue, food, delta);
    if (next) onQueueReorder(next);
  }

  function submitRetro() {
    const food = retroFood.trim();
    if (!food) return;
    onLogRetro(food, retroNotes.trim());
    setRetroFood('');
    setRetroNotes('');
  }

  const nextUp = queue[0];

  return (
    <CollapsibleCard cardKey="foodexp" title="Food experiments">
      <div className={styles.intro}>
        Controlled reintroduction. One test at a time, 3-day rest window between. Auto-tags{' '}
        <b className={styles.safeWord}>safe</b> when cleared, <b className={styles.suspectWord}>suspect</b>{' '}
        when flared.
      </div>

      {active ? (
        <div className={styles.activeBlock}>
          <div className={styles.blockKicker}>Testing</div>
          <div className={styles.activeFood}>{active.food}</div>
          <div className={styles.activeMeta}>
            Day {testDayNumber(active.started_on, serverDate)} of {active.watch_window_days} &middot; started{' '}
            {active.started_on} &middot; clears {active.results_due_on}
          </div>
          {active.notes ? <div className={styles.activeNotes}>{active.notes}</div> : null}
          {flaring ? (
            <div className={styles.flareForm}>
              <input
                type="text"
                className={styles.textInput}
                placeholder="What symptoms / how bad? (optional)"
                value={flareNotes}
                onChange={(e) => setFlareNotes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onResolve(active.id, 'flared', flareNotes.trim());
                    setFlaring(false);
                    setFlareNotes('');
                  }
                  if (e.key === 'Escape') setFlaring(false);
                }}
              />
              <button
                type="button"
                className={styles.flaredBtn}
                onClick={() => {
                  onResolve(active.id, 'flared', flareNotes.trim());
                  setFlaring(false);
                  setFlareNotes('');
                }}
              >
                Log flare
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => setFlaring(false)}>
                Back
              </button>
            </div>
          ) : (
            <div className={styles.btnRow}>
              <button
                type="button"
                className={`${styles.clearedBtn} ${canResolveClear(active, serverDate) ? '' : styles.disabledBtn}`}
                disabled={!canResolveClear(active, serverDate)}
                title={
                  canResolveClear(active, serverDate)
                    ? 'Mark this food cleared (auto-tags it safe)'
                    : `Available on day ${active.watch_window_days}`
                }
                onClick={() =>
                  twoStep(`cleared:${active.id}`, () => onResolve(active.id, 'cleared', ''))
                }
              >
                {confirmAction === `cleared:${active.id}`
                  ? 'Sure? Tags it safe'
                  : '✓ Mark cleared'}
              </button>
              <button type="button" className={styles.flaredBtn} onClick={() => setFlaring(true)}>
                &#9888; Mark flared
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => onExtend(active.id, 2)}>
                +2 days
              </button>
              <button
                type="button"
                className={`${styles.cancelBtn} ${confirmAction === `cancel:${active.id}` ? styles.cancelSure : ''}`}
                onClick={() => twoStep(`cancel:${active.id}`, () => onCancel(active.id))}
              >
                {confirmAction === `cancel:${active.id}` ? 'Sure? No outcome recorded' : 'Cancel test'}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {recovering ? (
        <div className={styles.recoveringBlock}>
          <div className={styles.blockKicker}>Recovering</div>
          <div className={styles.recoveringFood}>Last flare: {recovering.food}</div>
          <div className={styles.activeMeta}>Flared on {recovering.outcome_at || recovering.started_on}.</div>
          {recovering.flare_notes ? (
            <div className={styles.activeNotes}>&ldquo;{recovering.flare_notes}&rdquo;</div>
          ) : null}
          <div className={styles.recoveringHint}>
            No new tests until you&rsquo;re back to baseline. Watch your symptoms; mark below when nose /
            brain / gut feel back to normal.
          </div>
          <button type="button" className={styles.baselineBtn} onClick={onClearBaseline}>
            I&rsquo;m back to baseline &mdash; ready for next experiment
          </button>
        </div>
      ) : null}

      {phase === 'clear' ? (
        <div className={styles.clearBlock}>
          <div className={styles.blockKicker}>Ready</div>
          <div className={styles.clearHeading}>Baseline clear &mdash; ready for next experiment.</div>
          {nextUp ? (
            <div className={styles.nextUpRow}>
              <span className={styles.nextUpLabel}>
                Next up: <b>{nextUp}</b>
              </span>
              <button type="button" className={styles.startBtn} onClick={() => onStart(nextUp)}>
                Start test
              </button>
            </div>
          ) : (
            <div className={styles.emptyQueueNote}>No foods queued yet. Add some below.</div>
          )}
        </div>
      ) : null}

      <details className={styles.subDetails} open={phase !== 'clear'}>
        <summary className={styles.subSummary}>Queue ({queue.length})</summary>
        <div className={styles.subBody}>
          {queue.length ? (
            queue.map((f, i) => (
              <div className={styles.queueRow} key={f}>
                <span className={styles.queueNum}>{i + 1}.</span>
                <span className={styles.queueFood}>{f}</span>
                <button
                  type="button"
                  className={styles.queueMoveBtn}
                  disabled={i === 0}
                  aria-label={`Move ${f} up`}
                  onClick={() => moveQueue(f, -1)}
                >
                  &#9650;
                </button>
                <button
                  type="button"
                  className={styles.queueMoveBtn}
                  disabled={i === queue.length - 1}
                  aria-label={`Move ${f} down`}
                  onClick={() => moveQueue(f, 1)}
                >
                  &#9660;
                </button>
                <button
                  type="button"
                  className={styles.queueRemoveBtn}
                  aria-label={`Remove ${f} from queue`}
                  onClick={() => onQueueRemove(f)}
                >
                  &times;
                </button>
              </div>
            ))
          ) : (
            <div className={styles.emptyQueue}>Queue is empty. Add foods you want to test next.</div>
          )}
          <div className={styles.queueAddRow}>
            <input
              type="text"
              className={styles.textInput}
              placeholder="Food to add to queue…"
              value={queueInput}
              onChange={(e) => setQueueInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitQueueAdd();
              }}
            />
            <button type="button" className={styles.queueAddBtn} onClick={submitQueueAdd}>
              + Add
            </button>
          </div>
        </div>
      </details>

      {past.length ? (
        <details className={styles.subDetails}>
          <summary className={styles.subSummary}>Past experiments ({past.length})</summary>
          <div className={styles.subBody}>
            {past.map((t) => (
              <div className={styles.pastRow} key={t.id}>
                {t.outcome === 'cleared' ? (
                  <span className={styles.pastIconCleared}>&#10003;</span>
                ) : (
                  <span className={styles.pastIconFlared}>&#9888;</span>
                )}
                <span className={styles.pastDates}>
                  {t.started_on} &rarr; {t.outcome_at || '—'}
                </span>
                <span className={styles.pastText}>
                  <b>{t.food}</b> &mdash; {t.outcome}
                  {t.flare_notes ? <span className={styles.pastNote}> — &ldquo;{t.flare_notes}&rdquo;</span> : null}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details className={styles.subDetails}>
        <summary className={styles.retroSummary}>
          Log a flare that happened from regular eating (not a test) &#9662;
        </summary>
        <div className={styles.retroBody}>
          <div className={styles.retroHint}>
            Records a retroactive flared event. Puts you in recovering state until you mark baseline clear.
          </div>
          <input
            type="text"
            className={`${styles.textInput} ${styles.retroInput}`}
            placeholder="What did you eat? (e.g. 'beans + ACV')"
            value={retroFood}
            onChange={(e) => setRetroFood(e.target.value)}
          />
          <input
            type="text"
            className={`${styles.textInput} ${styles.retroInput}`}
            placeholder="Symptoms? (e.g. 'nose congestion, noticeable')"
            value={retroNotes}
            onChange={(e) => setRetroNotes(e.target.value)}
          />
          <button
            type="button"
            className={`${styles.retroBtn} ${active ? styles.disabledBtn : ''}`}
            disabled={!!active}
            onClick={submitRetro}
          >
            Log retroactive flare
          </button>
        </div>
      </details>
    </CollapsibleCard>
  );
}
