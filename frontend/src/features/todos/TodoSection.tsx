import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TodoRow } from './TodoRow';
import { beginDrag, endDrag, getSectionItemIds, registerSectionDrag, updateDrag } from './dragCoordinator';
import type { TodoItem } from './types';
import styles from './TodoSection.module.css';

const COLORS = ['var(--todo-1)', 'var(--todo-2)', 'var(--todo-later-accent, var(--todo-3))'];
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
  /** Lets a drag started in *this* section land in a different one — see dragCoordinator.ts. */
  onMove: (id: string, toLabel: string) => void;
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
  onMove,
}: TodoSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const cleanupRef = useRef<(() => void) | null>(null);

  // Register once — the getters below always read the latest refs, so other
  // sections can query this one's rows/items mid-drag without re-registering
  // on every render.
  useEffect(() => {
    const unregister = registerSectionDrag({
      label,
      getItems: () => itemsRef.current,
      getContainerEl: () => containerRef.current,
      getRowEls: () => rowEls.current,
      setOverId,
      setHovered,
    });
    return unregister;
  }, [label]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const remaining = countMode === 'total' ? items.length : items.filter((it) => !it.done).length;
  const color = COLORS[Math.min(colorIndex, 2)];

  function finishDrag(commit: boolean) {
    cleanupRef.current?.();
    cleanupRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    const result = endDrag();
    if (!commit || !drag || !drag.active || !result || !result.overLabel) return;
    const { id, originLabel, overLabel, overId: dropId } = result;
    if (overLabel === originLabel && (dropId === id || !dropId)) return;

    const targetIds = getSectionItemIds(overLabel).filter((tid) => tid !== id);
    let insertAt = targetIds.length;
    if (dropId && dropId !== id) {
      const idx = targetIds.indexOf(dropId);
      if (idx !== -1) insertAt = idx;
    }
    targetIds.splice(insertAt, 0, id);

    if (overLabel !== originLabel) onMove(id, overLabel);
    onReorder(overLabel, targetIds);
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

    const onMovePointer = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        setDragId(drag.id);
        beginDrag(drag.id, label);
      }
      updateDrag(ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      if (dragRef.current && ev.pointerId !== dragRef.current.pointerId) return;
      finishDrag(true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (dragRef.current && ev.pointerId !== dragRef.current.pointerId) return;
      finishDrag(false);
    };

    window.addEventListener('pointermove', onMovePointer);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', onMovePointer);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }

  return (
    <div
      ref={containerRef}
      className={`${styles.card} ${hovered ? styles.dropTarget : ''}`}
      style={{ borderLeftColor: color }}
    >
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
