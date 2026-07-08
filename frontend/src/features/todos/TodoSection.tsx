import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TodoRow } from './TodoRow';
import type { TodoItem } from './types';
import styles from './TodoSection.module.css';

const COLORS = ['var(--todo-1)', 'var(--todo-2)', 'var(--todo-3)'];
const DRAG_THRESHOLD_PX = 6;

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

interface DragState {
  pointerId: number;
  id: string;
  startY: number;
  active: boolean;
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

  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const overIdRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const remaining = countMode === 'total' ? items.length : items.filter((it) => !it.done).length;
  const color = COLORS[Math.min(colorIndex, 2)];

  function rowIdAt(clientY: number): string | null {
    let lastId: string | null = null;
    for (const it of itemsRef.current) {
      const el = rowEls.current.get(it.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return it.id;
      lastId = it.id;
    }
    return lastId;
  }

  function endDrag(commit: boolean) {
    cleanupRef.current?.();
    cleanupRef.current = null;
    const drag = dragRef.current;
    const target = overIdRef.current;
    dragRef.current = null;
    overIdRef.current = null;
    setDragId(null);
    setOverId(null);
    if (!commit || !drag || !drag.active || !target || target === drag.id) return;
    const ids = itemsRef.current.map((it) => it.id);
    const from = ids.indexOf(drag.id);
    const to = ids.indexOf(target);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, drag.id);
    onReorder(label, ids);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>, id: string) {
    if (dragRef.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported — window listeners below still track the pointer
    }
    dragRef.current = { pointerId: e.pointerId, id, startY: e.clientY, active: false };

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        setDragId(drag.id);
      }
      const over = rowIdAt(ev.clientY);
      overIdRef.current = over;
      setOverId(over);
    };
    const onUp = (ev: PointerEvent) => {
      if (dragRef.current && ev.pointerId !== dragRef.current.pointerId) return;
      endDrag(true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (dragRef.current && ev.pointerId !== dragRef.current.pointerId) return;
      endDrag(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
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
              dragOver={overId === item.id && dragId !== item.id}
              dragging={dragId === item.id}
              onToggle={onToggle}
              onOpen={onOpenDetail}
              onHandlePointerDown={handlePointerDown}
              rowRef={(el) => {
                if (el) rowEls.current.set(item.id, el);
                else rowEls.current.delete(item.id);
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
