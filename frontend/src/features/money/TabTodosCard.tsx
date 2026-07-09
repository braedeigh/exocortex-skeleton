import type { TabTodo } from './types';
import styles from './money.module.css';

export interface TabTodosCardProps {
  items: TabTodo[];
  onToggle: (id: string) => void;
}

function fmtDueDate(iso: string): string {
  try {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function isOverdue(iso: string): boolean {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(iso + 'T12:00:00') < today;
  } catch {
    return false;
  }
}

/** "To-dos for this page" strip — to-dos category-tagged 'money'
 * (todos.js renderTabTodos, fed by D.tab_todos). */
export function TabTodosCard({ items, onToggle }: TabTodosCardProps) {
  if (!items.length) return null;

  return (
    <div className={`${styles.cardPlain} ${styles.tabTodoCard}`}>
      <div className={styles.tabTodoTitle}>To-dos for this page</div>
      {items.map((it) => {
        const overdue = it.due_by ? isOverdue(it.due_by) : false;
        return (
          <div className={styles.tabTodoItem} key={it.id || it.text}>
            <button
              type="button"
              className={styles.tabTodoCheck}
              title="Check off"
              aria-label={`Check off ${it.text}`}
              onClick={() => onToggle(it.id || it.text)}
            >
              &#9675;
            </button>
            <span className={styles.tabTodoText}>
              {it.text}
              {it.due_by ? (
                <span
                  className={`${styles.dueChip} ${overdue ? styles.dueChipOverdue : ''}`}
                  title={`Due ${it.due_by}`}
                >
                  {overdue ? 'overdue · ' : 'due '}
                  {fmtDueDate(it.due_by)}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
