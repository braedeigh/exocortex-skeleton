/**
 * FoodExperimentsCard.tsx — elimination-diet pacing card (one test at a time,
 * queue, retro flare log). Port of kitchen.js renderFoodExperiments +
 * _foodTest* handlers. Rendered on the Body tab in the old app (food_tests /
 * food_test_queue ride the /api/data/body payload) — exported for the
 * Body-tab port to mount with its own data + invalidate.
 */
import { useState } from 'react';
import {
  foodTestCancel,
  foodTestClearBaseline,
  foodTestExtend,
  foodTestLogRetro,
  foodTestOutcome,
  foodTestQueueAdd,
  foodTestQueueRemove,
  foodTestQueueReorder,
  foodTestStart,
} from './api';
import type { FoodTest } from './types';
import styles from './kitchen.module.css';

export interface FoodExperimentsCardProps {
  tests: FoodTest[];
  queue: string[];
  onError: (message: string) => void;
  invalidate: () => void;
}

export function FoodExperimentsCard({ tests, queue, onError, invalidate }: FoodExperimentsCardProps) {
  const [queueInput, setQueueInput] = useState('');
  const [retroFood, setRetroFood] = useState('');
  const [retroNotes, setRetroNotes] = useState('');

  const active = tests.find((t) => !t.outcome);
  const recovering = active
    ? null
    : [...tests].reverse().find((t) => t.outcome === 'flared' && !t.cleared_baseline_on);
  const state = active ? 'testing' : recovering ? 'recovering' : 'clear';
  const past = tests.filter((t) => t.outcome).slice().reverse();

  async function call<T extends { error?: string } | unknown>(fn: () => Promise<T>) {
    try {
      const res = await fn();
      const err = res && typeof res === 'object' && 'error' in res ? (res as { error?: string }).error : undefined;
      if (err) {
        onError(err);
        return false;
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Request failed');
      return false;
    }
    invalidate();
    return true;
  }

  async function resolve(id: string, outcome: 'cleared' | 'flared') {
    let flareNotes = '';
    if (outcome === 'flared') {
      flareNotes = window.prompt('What symptoms / how bad? (optional)') || '';
    } else if (!window.confirm('Mark this test cleared? The food will be tagged safe in your catalog.')) {
      return;
    }
    await call(() => foodTestOutcome(id, outcome, flareNotes));
  }

  async function queueMove(food: string, delta: number) {
    const next = queue.slice();
    const idx = next.findIndex((f) => f.toLowerCase() === food.toLowerCase());
    if (idx === -1) return;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= next.length) return;
    const [moved] = next.splice(idx, 1);
    next.splice(newIdx, 0, moved);
    await call(() => foodTestQueueReorder(next));
  }

  let dayN = 1;
  let canResolveClear = false;
  if (active) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(active.started_on + 'T00:00:00');
    dayN = Math.max(1, Math.floor((today.getTime() - start.getTime()) / 86400000) + 1);
    canResolveClear = dayN >= active.watch_window_days;
  }

  const nextUp = queue[0];

  return (
    <div>
      <div className={styles.muted12} style={{ marginBottom: 12 }}>
        Controlled reintroduction. One test at a time, 3-day rest window between. Auto-tags{' '}
        <b style={{ color: 'var(--green)' }}>safe</b> when cleared, <b style={{ color: 'var(--orange)' }}>suspect</b>{' '}
        when flared.
      </div>

      {active ? (
        <div style={{ border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)', background: 'color-mix(in srgb, var(--accent) 6%, var(--card-bg))', borderRadius: 'var(--radius-xl)', padding: 14, marginBottom: 14 }}>
          <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 4 }}>Testing</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{active.food}</div>
          <div className={styles.muted13} style={{ marginBottom: 10 }}>
            Day {dayN} of {active.watch_window_days} · started {active.started_on} · clears {active.results_due_on}
          </div>
          {active.notes ? (
            <div style={{ fontSize: 13, fontStyle: 'italic', marginBottom: 10 }}>{active.notes}</div>
          ) : null}
          <div className={styles.rowFlex}>
            <button
              type="button"
              disabled={!canResolveClear}
              title={canResolveClear ? 'Mark this food cleared (auto-tags it safe)' : `Available on day ${active.watch_window_days}`}
              style={{
                padding: '6px 14px',
                background: canResolveClear ? 'var(--green)' : 'none',
                color: canResolveClear ? '#fff' : 'var(--text-muted)',
                border: '1px solid var(--green)',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: canResolveClear ? 'pointer' : 'not-allowed',
                opacity: canResolveClear ? 1 : 0.5,
                minHeight: 44,
              }}
              onClick={() => void resolve(active.id, 'cleared')}
            >
              &#10003; Mark cleared
            </button>
            <button
              type="button"
              style={{ padding: '6px 14px', background: 'var(--orange)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44 }}
              onClick={() => void resolve(active.id, 'flared')}
            >
              &#9888; Mark flared
            </button>
            <button type="button" className={styles.smallBtn} onClick={() => void call(() => foodTestExtend(active.id, 2))}>
              +2 days
            </button>
            <button
              type="button"
              className={`${styles.smallBtn}`}
              style={{ color: 'var(--red)', marginLeft: 'auto' }}
              onClick={() => {
                if (window.confirm('Cancel this test entirely? No outcome will be recorded.')) {
                  void call(() => foodTestCancel(active.id));
                }
              }}
            >
              Cancel test
            </button>
          </div>
        </div>
      ) : null}

      {recovering ? (
        <div style={{ border: '1px solid color-mix(in srgb, var(--orange) 35%, transparent)', background: 'color-mix(in srgb, var(--orange) 6%, var(--card-bg))', borderRadius: 'var(--radius-xl)', padding: 14, marginBottom: 14 }}>
          <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 4 }}>Recovering</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Last flare: {recovering.food}</div>
          <div className={styles.muted13} style={{ marginBottom: 8 }}>
            Flared on {recovering.outcome_at || recovering.started_on}.
          </div>
          {recovering.flare_notes ? (
            <div style={{ fontSize: 13, fontStyle: 'italic', marginBottom: 10 }}>&quot;{recovering.flare_notes}&quot;</div>
          ) : null}
          <div className={styles.muted12} style={{ marginBottom: 10 }}>
            No new tests until you&apos;re back to baseline. Watch your symptoms; mark below when nose / brain / gut
            feel back to normal.
          </div>
          <button type="button" className={styles.greenBtn} onClick={() => void call(() => foodTestClearBaseline())}>
            I&apos;m back to baseline — ready for next experiment
          </button>
        </div>
      ) : null}

      {state === 'clear' ? (
        <div style={{ border: '1px solid color-mix(in srgb, var(--green) 35%, transparent)', background: 'color-mix(in srgb, var(--green) 6%, var(--card-bg))', borderRadius: 'var(--radius-xl)', padding: 14, marginBottom: 14 }}>
          <div className={styles.groupLabel} style={{ padding: 0, marginBottom: 4 }}>Ready</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Baseline clear — ready for next experiment.</div>
          {nextUp ? (
            <div className={styles.rowFlex} style={{ gap: 10 }}>
              <span style={{ fontSize: 13 }}>
                Next up: <b>{nextUp}</b>
              </span>
              <button type="button" className={styles.primaryBtn} onClick={() => void call(() => foodTestStart(nextUp))}>
                Start test
              </button>
            </div>
          ) : (
            <div className={styles.muted13}>No foods queued yet. Add some below.</div>
          )}
        </div>
      ) : null}

      <details open={state !== 'clear'} style={{ marginBottom: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '6px 0', color: 'var(--text-muted)', minHeight: 40, display: 'flex', alignItems: 'center' }}>
          Queue ({queue.length})
        </summary>
        <div style={{ paddingTop: 8 }}>
          {queue.length ? (
            queue.map((f, i) => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px', borderBottom: '1px solid var(--border)' }}>
                <span className={styles.muted12} style={{ width: 24, textAlign: 'right' }}>{i + 1}.</span>
                <span style={{ flex: 1, fontSize: 13 }}>{f}</span>
                <button
                  type="button"
                  disabled={i === 0}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: i === 0 ? 'not-allowed' : 'pointer', padding: '8px 10px', opacity: i === 0 ? 0.3 : 1, minWidth: 40, minHeight: 40 }}
                  onClick={() => void queueMove(f, -1)}
                  aria-label={`Move ${f} up`}
                >
                  &#9650;
                </button>
                <button
                  type="button"
                  disabled={i === queue.length - 1}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: i === queue.length - 1 ? 'not-allowed' : 'pointer', padding: '8px 10px', opacity: i === queue.length - 1 ? 0.3 : 1, minWidth: 40, minHeight: 40 }}
                  onClick={() => void queueMove(f, 1)}
                  aria-label={`Move ${f} down`}
                >
                  &#9660;
                </button>
                <button
                  type="button"
                  style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 15, cursor: 'pointer', padding: '8px 10px', minWidth: 40, minHeight: 40 }}
                  onClick={() => void call(() => foodTestQueueRemove(f))}
                  aria-label={`Remove ${f} from queue`}
                >
                  &times;
                </button>
              </div>
            ))
          ) : (
            <div className={styles.muted13} style={{ padding: '6px 0', fontStyle: 'italic' }}>
              Queue is empty. Add foods you want to test next.
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input
              type="text"
              className={styles.textInput}
              style={{ flex: 1, fontSize: 13 }}
              placeholder="Food to add to queue…"
              value={queueInput}
              onChange={(e) => setQueueInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && queueInput.trim()) {
                  void call(() => foodTestQueueAdd(queueInput.trim())).then((ok) => {
                    if (ok) setQueueInput('');
                  });
                }
              }}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => {
                if (!queueInput.trim()) return;
                void call(() => foodTestQueueAdd(queueInput.trim())).then((ok) => {
                  if (ok) setQueueInput('');
                });
              }}
            >
              + Add
            </button>
          </div>
        </div>
      </details>

      {past.length ? (
        <details style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '6px 0', color: 'var(--text-muted)', minHeight: 40, display: 'flex', alignItems: 'center' }}>
            Past experiments ({past.length})
          </summary>
          <div style={{ paddingTop: 8 }}>
            {past.map((t) => (
              <div key={t.id} style={{ padding: '6px 4px', borderBottom: '1px solid var(--border)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                {t.outcome === 'cleared' ? (
                  <span style={{ color: 'var(--green)', fontWeight: 700 }}>&#10003;</span>
                ) : (
                  <span style={{ color: 'var(--orange)', fontWeight: 700 }}>&#9888;</span>
                )}
                <span className={styles.muted12} style={{ minWidth: 90 }}>
                  {t.started_on} → {t.outcome_at || '—'}
                </span>
                <span style={{ flex: 1 }}>
                  <b>{t.food}</b> — {t.outcome}
                  {t.flare_notes ? (
                    <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}> — &quot;{t.flare_notes}&quot;</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details style={{ marginBottom: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', padding: '6px 0', minHeight: 40, display: 'flex', alignItems: 'center' }}>
          Log a flare that happened from regular eating (not a test) ▾
        </summary>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--card-bg)', marginTop: 8 }}>
          <div className={styles.muted12} style={{ marginBottom: 8 }}>
            Records a retroactive flared event. Puts you in recovering state until you mark baseline clear.
          </div>
          <input
            type="text"
            className={styles.textInput}
            style={{ width: '100%', fontSize: 13, marginBottom: 6 }}
            placeholder="What did you eat? (e.g. 'beans + ACV')"
            value={retroFood}
            onChange={(e) => setRetroFood(e.target.value)}
          />
          <input
            type="text"
            className={styles.textInput}
            style={{ width: '100%', fontSize: 13, marginBottom: 8 }}
            placeholder="Symptoms? (e.g. 'nose congestion, noticeable')"
            value={retroNotes}
            onChange={(e) => setRetroNotes(e.target.value)}
          />
          <button
            type="button"
            disabled={!!active}
            style={{
              padding: '7px 14px',
              background: active ? 'none' : 'var(--orange)',
              color: active ? 'var(--text-muted)' : '#fff',
              border: '1px solid var(--orange)',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: active ? 'not-allowed' : 'pointer',
              minHeight: 44,
            }}
            onClick={() => {
              if (!retroFood.trim()) {
                onError('What did you eat?');
                return;
              }
              void call(() => foodTestLogRetro(retroFood.trim(), retroNotes.trim())).then((ok) => {
                if (ok) {
                  setRetroFood('');
                  setRetroNotes('');
                }
              });
            }}
          >
            Log retroactive flare
          </button>
        </div>
      </details>
    </div>
  );
}
