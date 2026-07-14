import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TodoRow } from './TodoRow';
import { beginDrag, endDrag, getSectionItemIds, registerSectionDrag, updateDrag } from './dragCoordinator';
import type { Front } from '../fronts/useFronts';
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
  fronts: Front[];
  defaultOpen?: boolean;
  countMode?: 'remaining' | 'total';
  /** Current focus-chip filter theme (see FocusChips) — a *change* here (not
   * the value itself) auto-opens this section when it still has something
   * in it, so filtering a category surfaces its cards instead of leaving
   * them collapsed (dev note 685eb5fa). */
  focusTheme?: string;
  onToggle: (id: string) => void;
  onOpenDetail: (item: TodoItem) => void;
  onSubtaskToggle: (parentId: string, subId: string) => void;
  onReorder: (section: string, ids: string[]) => void;
  onAutosort: (section: string) => void;
  /** Lets a drag started in *this* section land in a different one — see dragCoordinator.ts. */
  onMove: (id: string, toLabel: string) => void;
  /** Header "+ add" — opens the add sheet preset to this section. Omitted for Done. */
  onAddClick?: (label: string) => void;
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
  fronts,
  defaultOpen = false,
  countMode = 'remaining',
  focusTheme,
  onToggle,
  onOpenDetail,
  onSubtaskToggle,
  onReorder,
  onAutosort,
  onMove,
  onAddClick,
}: TodoSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  // "small until edit": drag handles only exist while this is on (the
  // header's edit/done toggle), so a stray touch can't reorder the list.
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const cleanupRef = useRef<(() => void) | null>(null);

  // Auto-open on a filter change (not on mount — the persisted focusTheme
  // shouldn't force every non-empty section open on first load, only an
  // actual tap on a focus chip should).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (focusTheme && itemsRef.current.length > 0) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTheme]);

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
        {/* Sits directly right of the title (dev note 4b6b8e3e) — the count/
            autosort/edit chips are pushed off to the far right by the
            spacer below instead of hugging the title like this does. */}
        {onAddClick ? (
          <span
            className={styles.headerAction}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onAddClick(label);
            }}
          >
            + add
          </span>
        ) : null}
        <span className={styles.spacer} aria-hidden="true" />
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
        {/* Nested-interactive workaround, same as the autosort chip: the
            summary is itself a button, so these are role="button" spans. */}
        <span
          className={`${styles.headerAction} ${editing ? styles.headerActionActive : ''}`}
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setEditing((v) => !v);
            if (!editing) setOpen(true); // entering edit mode on a collapsed card should show its rows
          }}
        >
          {editing ? 'done' : 'edit'}
        </span>
      </button>
      {open ? (
        items.length ? (
          items.map((item) => (
            <TodoRow
              key={item.id}
              item={item}
              serverDate={serverDate}
              fronts={fronts}
              dragOver={overId === item.id && dragId !== item.id}
              dragging={dragId === item.id}
              onToggle={onToggle}
              onOpen={onOpenDetail}
              onSubtaskToggle={onSubtaskToggle}
              onHandlePointerDown={editing ? handlePointerDown : undefined}
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
