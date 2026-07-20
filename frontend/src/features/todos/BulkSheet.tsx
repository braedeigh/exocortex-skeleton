import { useEffect, useState } from 'react';
import { Button, Sheet } from '../../ui';
import { FRONT_EMOJI } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import { LADDER_LABELS, TODO_STATUSES } from './todoHelpers';
import type { BulkTodoAction, TodoDetailsPatch } from '../../api/endpoints';
import styles from './BulkSheet.module.css';

export type BulkSheetMode = 'snooze' | 'tag' | 'move';

export interface BulkSheetProps {
  /** Which bulk action the sheet is editing; null = closed. */
  mode: BulkSheetMode | null;
  /** How many to-dos are selected (title only). */
  count: number;
  fronts: Front[];
  onClose: () => void;
  onApply: (action: BulkTodoAction) => void;
}

const SNOOZE_DAYS = [1, 2, 3, 4, 5, 6];
const SNOOZE_WEEKS = [1, 2, 3, 4];

/** Sentinel for the tag selects/chips: "leave this field as it is" — only
 * touched fields make it into the patch (so bulk-tagging a focus doesn't
 * blank everyone's status). '' means "clear the field". */
const UNTOUCHED = null;

const TITLES: Record<BulkSheetMode, string> = {
  snooze: 'Snooze',
  tag: 'Tag',
  move: 'Move',
};

export function BulkSheet({ mode, count, fronts, onClose, onApply }: BulkSheetProps) {
  // Snooze mode's "do after" date.
  const [afterDate, setAfterDate] = useState('');
  // Tag mode: null = untouched, '' = clear, else the key to set. The front
  // select stays deliberately single-choice in bulk: picking one REPLACES
  // every selected item's fronts with just it (fronts: [front]), and
  // "(clear)" sends fronts: []. Per-item multi-tagging lives in TodoFormSheet.
  const [front, setFront] = useState<string | null>(UNTOUCHED);
  const [status, setStatus] = useState<string | null>(UNTOUCHED);

  // Fresh slate every time the sheet opens (or switches mode).
  useEffect(() => {
    setAfterDate('');
    setFront(UNTOUCHED);
    setStatus(UNTOUCHED);
  }, [mode]);

  if (!mode) return null;

  const tagTouched = front !== UNTOUCHED || status !== UNTOUCHED;

  function applyTag() {
    const patch: TodoDetailsPatch = {};
    if (front !== UNTOUCHED) patch.fronts = front === '' ? [] : [front];
    if (status !== UNTOUCHED) patch.status = status;
    onApply({ action: 'details', patch });
  }

  const title = `${TITLES[mode]} ${count} to-do${count === 1 ? '' : 's'}`;

  return (
    <Sheet open={!!mode} title={title} onClose={onClose}>
      {mode === 'snooze' ? (
        <>
          <div className={styles.field}>
            <span className={styles.label}>Snooze for</span>
            <div className={styles.chipRow}>
              {SNOOZE_DAYS.map((d) => (
                <button
                  type="button"
                  key={`d${d}`}
                  className={styles.chip}
                  onClick={() => onApply({ action: 'snooze', days: d })}
                >
                  {d}d
                </button>
              ))}
            </div>
            <div className={styles.chipRow}>
              {SNOOZE_WEEKS.map((w) => (
                <button
                  type="button"
                  key={`w${w}`}
                  className={styles.chip}
                  onClick={() => onApply({ action: 'snooze', days: w * 7 })}
                >
                  {w}w
                </button>
              ))}
            </div>
            <button type="button" className={styles.chip} onClick={() => onApply({ action: 'snooze', days: 0 })}>
              &#8617; Clear snooze
            </button>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="bulk-after-date">
              Do after
            </label>
            <input
              id="bulk-after-date"
              className={styles.input}
              type="date"
              value={afterDate}
              onChange={(e) => setAfterDate(e.target.value)}
            />
            <div className={styles.actions}>
              <Button
                variant="primary"
                fullWidth
                disabled={!afterDate}
                onClick={() => onApply({ action: 'details', patch: { after_date: afterDate } })}
              >
                Apply
              </Button>
            </div>
          </div>
        </>
      ) : null}

      {mode === 'tag' ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="bulk-focus">
              Focus
            </label>
            <select
              id="bulk-focus"
              className={styles.select}
              value={front === UNTOUCHED ? '__untouched__' : front}
              onChange={(e) => setFront(e.target.value === '__untouched__' ? UNTOUCHED : e.target.value)}
            >
              <option value="__untouched__">Leave as is</option>
              <option value="">(clear)</option>
              {fronts.map((f) => (
                <option key={f.id} value={f.id}>
                  {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>Status</span>
            <div className={styles.chipRow}>
              <button
                type="button"
                className={`${styles.chip} ${status === '' ? styles.active : ''}`}
                onClick={() => setStatus((cur) => (cur === '' ? UNTOUCHED : ''))}
              >
                (clear)
              </button>
              {TODO_STATUSES.map((s) => (
                <button
                  type="button"
                  key={s.key}
                  className={`${styles.chip} ${status === s.key ? styles.active : ''}`}
                  onClick={() => setStatus((cur) => (cur === s.key ? UNTOUCHED : s.key))}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.actions}>
            <Button variant="primary" fullWidth disabled={!tagTouched} onClick={applyTag}>
              Apply
            </Button>
          </div>
        </>
      ) : null}

      {mode === 'move' ? (
        <div className={styles.field}>
          <span className={styles.label}>Move to</span>
          {LADDER_LABELS.map((label) => (
            <button
              type="button"
              key={label}
              className={styles.moveBtn}
              onClick={() => onApply({ action: 'move', to_section: label })}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </Sheet>
  );
}
