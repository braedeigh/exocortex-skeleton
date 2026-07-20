import { CollapsibleCard } from '../body/CollapsibleCard';
import { fmtTime } from '../todos/todoHelpers';
import { useClearedTodos } from './useJournalData';
import styles from './ClearedTodosCard.module.css';

/**
 * Read-only computed view over the to-dos data — items whose effective
 * completion day (finished_on ?? done_at) is `date`. Nothing is minted here:
 * a correction that re-files a to-do's completion day moves it in/out of
 * this list retroactively, same as the server's /api/todos/cleared query.
 */
export function ClearedTodosCard({ date }: { date: string }) {
  const { data } = useClearedTodos(date);
  const items = data?.items ?? [];

  if (items.length === 0) return null;

  return (
    <CollapsibleCard cardKey="journalCleared" title={`Cleared to-dos — ${items.length}`} defaultOpen>
      <ul className={styles.list}>
        {items.map((it) => (
          <li key={it.id} className={styles.row}>
            <span className={styles.text}>{it.text}</span>
            {it.time ? <span className={styles.timeChip}>{fmtTime(it.time)}</span> : null}
          </li>
        ))}
      </ul>
    </CollapsibleCard>
  );
}
