import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../ui';
import { ApiError } from '../../api/client';
import { removeStreak, unretireStreak } from '../../api/endpoints';
import type { Streak } from '../habits/types';
import { StreakNotes } from '../todos/StreakNotes';
import { useStreakNotes, TODAY_QUERY_KEY } from '../todos/useTodayData';
import { MAP_QUERY_KEY } from './useMapData';
import styles from './RetiredCountersCard.module.css';

export interface RetiredCountersCardProps {
  counters: Streak[];
  onError: (message: string) => void;
}

/** "2026-02-22" -> "Feb 22" — string math only (house convention). */
function shortDate(date: string | null | undefined): string {
  if (!date) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = months[parseInt(date.slice(5, 7), 10) - 1];
  const d = parseInt(date.slice(8, 10), 10);
  return m && !Number.isNaN(d) ? `${m} ${d}, ${date.slice(0, 4)}` : date;
}

function RetiredRow({ counter, onError }: { counter: Streak; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<'unretire' | 'remove' | null>(null);
  const queryClient = useQueryClient();
  // Notes fetch is lazy — the query only mounts once the row is expanded.
  const noteLog = useStreakNotes(open ? counter.slug : null, onError);

  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: MAP_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY });
  };
  const fail = (e: unknown, fallback: string) => onError(e instanceof ApiError ? e.message : fallback);

  const unretire = useMutation({
    mutationFn: () => unretireStreak(counter.id),
    onSettled: settle,
    onError: (e) => fail(e, 'Could not resume the day count'),
  });
  const remove = useMutation({
    mutationFn: () => removeStreak(counter.id),
    onSettled: settle,
    onError: (e) => fail(e, 'Could not remove the day count'),
  });

  return (
    <li className={styles.row}>
      <button type="button" className={styles.rowHead} onClick={() => setOpen((o) => !o)}>
        <span className={styles.days}>Day {counter.days}</span>
        <span className={styles.label}>{counter.label}</span>
        <span className={styles.dates}>
          {shortDate(counter.since)} → {shortDate(counter.retired_on)}
        </span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
          &#9654;
        </span>
      </button>

      {open ? (
        <div className={styles.detail}>
          {counter.retired_note ? <div className={styles.retireNote}>“{counter.retired_note}”</div> : null}
          {counter.notes ? <div className={styles.description}>{counter.notes}</div> : null}

          <StreakNotes
            tag={counter.tag}
            notes={noteLog.notes}
            loading={noteLog.loading}
            onAppend={noteLog.append}
            appending={noteLog.appending}
            onEdit={noteLog.edit}
            onRemove={noteLog.remove}
            readOnly
          />

          <div className={styles.rowActions}>
            {confirming === 'unretire' ? (
              <>
                <span className={styles.confirmText}>Resume this count?</span>
                <Button variant="secondary" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => unretire.mutate()}>
                  Resume
                </Button>
              </>
            ) : confirming === 'remove' ? (
              <>
                <span className={styles.confirmTextDanger}>Remove for good?</span>
                <Button variant="secondary" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => remove.mutate()}>
                  Remove
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setConfirming('unretire')}>
                  Un-retire
                </Button>
                <Button variant="ghost" onClick={() => setConfirming('remove')}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Retired day counters — where a counter's story lives after it leaves the
 * Today tab. Each row keeps the frozen final count, its dates, the
 * retirement note (the same line woven into that day's journal), the
 * description, and the read-only note-cell history. Un-retire sends it back
 * to Today; remove is the true delete, confirmed.
 */
export function RetiredCountersCard({ counters, onError }: RetiredCountersCardProps) {
  if (!counters.length) {
    return <div className={styles.empty}>Nothing retired yet — when a day count ends, it rests here.</div>;
  }
  return (
    <ul className={styles.list}>
      {counters.map((c) => (
        <RetiredRow key={c.id} counter={c} onError={onError} />
      ))}
    </ul>
  );
}
