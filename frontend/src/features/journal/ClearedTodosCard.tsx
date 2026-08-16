import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CollapsibleCard } from '../body/CollapsibleCard';
import { fmtAddedDate, fmtTime } from '../todos/todoHelpers';
import { TODAY_QUERY_KEY } from '../todos/useTodayData';
import { todoDetails } from '../../api/endpoints';
import type { ClearedTodo, TodoDetailsPatch } from '../../api/endpoints';
import { useClearedTodos } from './useJournalData';
import styles from './ClearedTodosCard.module.css';

/** done_at is 'YYYY-MM-DD' (legacy) or 'YYYY-MM-DDTHH:MM' — render the day,
 * and the minute only when the stamp carries one. */
function fmtMarked(marked: string): string {
  const day = fmtAddedDate(marked.slice(0, 10));
  return marked.length > 10 ? `${day}, ${fmtTime(marked.slice(11, 16))}` : day;
}

interface RowDraft {
  on: string;
  time: string;
  note: string;
}

/**
 * Computed view over the to-dos data — items whose effective completion day
 * (finished_on ?? done_at day) is `date`. Nothing is minted here: a
 * correction that re-files a to-do's completion day moves it in/out of this
 * list retroactively, same as the server's /api/todos/cleared query.
 *
 * Title-line Edit (the FoodSafetyCard pattern — small until edit): rows grow
 * date/time/note inputs that commit as she goes, but the list itself only
 * re-files on Done — nothing vanishes under her fingers mid-edit. The
 * completed-date input seeds from the card's own day: that IS the current
 * effective day, so the form always shows what the system believes.
 */
export function ClearedTodosCard({ date }: { date: string }) {
  const { data } = useClearedTodos(date);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [saveFailed, setSaveFailed] = useState(false);
  const items = data?.items ?? [];

  if (items.length === 0) return null;

  function draftFor(it: ClearedTodo): RowDraft {
    return drafts[it.id] ?? { on: date, time: it.time ?? '', note: it.note ?? '' };
  }

  function commit(id: string, patch: TodoDetailsPatch) {
    todoDetails(id, patch)
      .then(() => setSaveFailed(false))
      .catch(() => setSaveFailed(true));
  }

  function setOn(it: ClearedTodo, on: string) {
    const d = { ...draftFor(it), on };
    setDrafts((m) => ({ ...m, [it.id]: d }));
    // An empty date clears the claim entirely — the item falls back to its
    // marked day (and a time without a date would be ignored server-side).
    if (!on) commit(it.id, { finished_on: '', finished_time: '' });
    else commit(it.id, { finished_on: on, ...(d.time ? { finished_time: d.time } : {}) });
  }

  function setTime(it: ClearedTodo, time: string) {
    const d = { ...draftFor(it), time };
    setDrafts((m) => ({ ...m, [it.id]: d }));
    // A time needs a day to live on — claim the draft's day alongside it.
    if (time) commit(it.id, { finished_on: d.on || date, finished_time: time });
    else commit(it.id, { finished_time: '' });
  }

  function setNote(it: ClearedTodo, note: string) {
    setDrafts((m) => ({ ...m, [it.id]: { ...draftFor(it), note } }));
  }

  function commitNote(it: ClearedTodo) {
    commit(it.id, { finished_note: draftFor(it).note.trim() });
  }

  function toggleEditing() {
    if (editing) {
      // Leaving edit mode is when the list is allowed to re-file: corrected
      // items move to their new day, the todos page picks up the changes.
      setDrafts({});
      setSaveFailed(false);
      queryClient.invalidateQueries({ queryKey: ['journal', 'cleared'] });
      queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY });
    }
    setEditing((v) => !v);
  }

  const editBtn = (
    <button
      type="button"
      className={styles.editBtn}
      data-track="cleared-edit"
      onClick={(e) => {
        // Lives inside <summary> — don't let the tap also collapse the card.
        e.preventDefault();
        e.stopPropagation();
        toggleEditing();
      }}
    >
      {editing ? 'Done' : 'Edit'}
    </button>
  );

  return (
    <CollapsibleCard
      cardKey="journalCleared"
      title={`Cleared to-dos — ${items.length}`}
      defaultOpen
      titleExtra={editBtn}
    >
      <ul className={styles.list}>
        {items.map((it) => {
          const d = draftFor(it);
          return (
            <li key={it.id} className={styles.row}>
              <div className={styles.main}>
                <span className={styles.text}>{it.text}</span>
                {!editing && it.time ? (
                  <span className={styles.timeChip}>{fmtTime(it.time)}</span>
                ) : null}
              </div>
              {!editing && it.note ? <div className={styles.note}>{it.note}</div> : null}
              {!editing && it.receipt_quote ? (
                <div className={styles.receipt}>“{it.receipt_quote}”</div>
              ) : null}
              {editing ? (
                <>
                  <div className={styles.controls}>
                    <input
                      className={styles.input}
                      type="date"
                      value={d.on}
                      onChange={(e) => setOn(it, e.target.value)}
                      aria-label="Completed date"
                    />
                    <input
                      className={styles.input}
                      type="time"
                      value={d.time}
                      onChange={(e) => setTime(it, e.target.value)}
                      aria-label="Completed time"
                    />
                  </div>
                  <input
                    className={`${styles.input} ${styles.noteInput}`}
                    type="text"
                    value={d.note}
                    onChange={(e) => setNote(it, e.target.value)}
                    onBlur={() => commitNote(it)}
                    placeholder="How it went… (optional)"
                    aria-label="Completion note"
                  />
                </>
              ) : null}
              {it.marked ? <div className={styles.marked}>marked {fmtMarked(it.marked)}</div> : null}
            </li>
          );
        })}
      </ul>
      {saveFailed ? <div className={styles.saveError}>A change didn&apos;t save — try it again.</div> : null}
    </CollapsibleCard>
  );
}
