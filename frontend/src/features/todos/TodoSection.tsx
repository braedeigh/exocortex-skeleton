import { useState } from 'react';
import { TodoRow } from './TodoRow';
import type { TodoItem } from './types';
import styles from './TodoSection.module.css';

const COLORS = ['var(--todo-1)', 'var(--todo-2)', 'var(--todo-3)'];

export interface TodoSectionProps {
  label: string;
  colorIndex: number;
  items: TodoItem[];
  manualOrder: boolean;
  serverDate: string;
  defaultOpen?: boolean;
  countMode?: 'remaining' | 'total';
  onToggle: (id: string) => void;
  onOpenDetail: (item: TodoItem) => void;
  onReorder: (section: string, ids: string[]) => void;
  onAutosort: (section: string) => void;
}

export function TodoSection({
  label,
  colorIndex,
  items,
  manualOrder,
  serverDate,
  defaultOpen = false,
  countMode = 'remaining',
  onToggle,
  onOpenDetail,
  onReorder,
  onAutosort,
}: TodoSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const remaining = countMode === 'total' ? items.length : items.filter((it) => !it.done).length;
  const color = COLORS[Math.min(colorIndex, 2)];

  function handleDrop() {
    if (dragId && overId && dragId !== overId) {
      const ids = items.map((it) => it.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(overId);
      if (from !== -1 && to !== -1) {
        ids.splice(from, 1);
        ids.splice(to, 0, dragId);
        onReorder(label, ids);
      }
    }
    setDragId(null);
    setOverId(null);
  }

  return (
    <div className={styles.card} style={{ borderLeftColor: color }}>
      <button type="button" className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.open : ''}`} aria-hidden="true">
          &#9654;
        </span>
        <span className={styles.title} style={{ color }}>
          {label}
        </span>
        <span className={styles.count}>{remaining}</span>
        {manualOrder ? (
          <span
            className={styles.autosort}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onAutosort(label);
            }}
          >
            &#8597; Auto-sort
          </span>
        ) : null}
      </button>
      {open ? (
        items.length ? (
          items.map((item) => (
            <TodoRow
              key={item.id}
              item={item}
              serverDate={serverDate}
              draggable
              dragOver={overId === item.id && dragId !== item.id}
              onToggle={onToggle}
              onOpen={onOpenDetail}
              onDragStart={setDragId}
              onDragOverRow={setOverId}
              onDrop={handleDrop}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            />
          ))
        ) : (
          <div className={styles.empty}>Nothing here</div>
        )
      ) : null}
    </div>
  );
}
