import { useState } from 'react';
import type { FormEvent } from 'react';
import type { GrowthNote } from './types';
import styles from './GrowthNotes.module.css';

export interface GrowthNotesProps {
  notes: GrowthNote[] | undefined;
  onAdd: (text: string) => void;
  onRemove: (text: string) => void;
  onIncorporate: (text: string) => void;
  onReactivate: (text: string) => void;
}

function daysAgoLabel(added: string): string {
  const days = Math.floor((Date.now() - new Date(`${added}T12:00:00`).getTime()) / 86400000);
  return days <= 0 ? 'today' : `${days}d`;
}

function journeyLabel(added: string, incorporated: string): string {
  const days = Math.floor(
    (new Date(`${incorporated}T12:00:00`).getTime() - new Date(`${added}T12:00:00`).getTime()) / 86400000,
  );
  return days <= 0 ? 'same day' : `${days} day${days !== 1 ? 's' : ''}`;
}

/** "Working On" — a collapsed note of aspirational/desired habits below the
 * daily habit cards, for things she's trying on before they earn a spot in
 * an actual habit section (port of the Growth Notes card in habits.js —
 * see habitCardHTML/renderHabits ~L336). Deliberately closed by default,
 * matching the old page's `<details>` (dev note ef1335a0). */
export function GrowthNotes({ notes, onAdd, onRemove, onIncorporate, onReactivate }: GrowthNotesProps) {
  const [open, setOpen] = useState(false);
  const [incorporatedOpen, setIncorporatedOpen] = useState(false);
  const [draft, setDraft] = useState('');

  if (!notes || !notes.length) return null;

  const active = notes.filter((n) => n.status === 'active');
  const incorporated = notes.filter((n) => n.status === 'incorporated');

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    setDraft('');
  }

  return (
    <div className={styles.card}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title}>Working On</span>
        <span className={styles.count}>{active.length}</span>
      </button>

      {open ? (
        <div className={styles.body}>
          {active.length ? (
            active.map((g) => (
              <div className={styles.row} key={g.text}>
                <span className={styles.text}>{g.text}</span>
                <span className={styles.age}>{daysAgoLabel(g.added)}</span>
                <button
                  type="button"
                  className={styles.incorporateBtn}
                  title="Incorporated — move to done"
                  onClick={() => onIncorporate(g.text)}
                >
                  &#10003;
                </button>
                <button
                  type="button"
                  className={styles.deleteBtn}
                  title="Remove"
                  aria-label={`Remove ${g.text}`}
                  onClick={() => onRemove(g.text)}
                >
                  &times;
                </button>
              </div>
            ))
          ) : (
            <div className={styles.empty}>Nothing on deck</div>
          )}

          <form className={styles.addForm} onSubmit={submit}>
            <input
              className={styles.addInput}
              type="text"
              placeholder="New aspiration…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="New aspiration"
            />
            <button type="submit" className={styles.addBtn}>
              Add
            </button>
          </form>

          {incorporated.length ? (
            <div className={styles.incorporatedWrap}>
              <button
                type="button"
                className={styles.incorporatedSummary}
                onClick={() => setIncorporatedOpen((v) => !v)}
              >
                Incorporated ({incorporated.length})
              </button>
              {incorporatedOpen
                ? incorporated.map((g) => (
                    <div className={styles.incorporatedRow} key={g.text}>
                      <span className={styles.incorporatedText}>{g.text}</span>
                      {g.incorporated ? (
                        <span className={styles.journey}>{journeyLabel(g.added, g.incorporated)}</span>
                      ) : null}
                      <button
                        type="button"
                        className={styles.reactivateBtn}
                        title="Move back to active"
                        onClick={() => onReactivate(g.text)}
                      >
                        &#8634;
                      </button>
                    </div>
                  ))
                : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
