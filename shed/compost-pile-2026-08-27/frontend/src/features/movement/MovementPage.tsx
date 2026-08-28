import { useEffect, useMemo, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { readHideVideos, writeHideVideos } from './movementHelpers';
import { RoutineDetail } from './RoutineDetail';
import { RoutineEditor } from './RoutineEditor';
import { useMovementActions, useMovementData } from './useMovementData';
import type { MovementMove, MovementRoutine } from './types';
import styles from './MovementPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

const UNDO_DELETE_MS = 5000;

/**
 * Movement tab — React port of static/js/movement.js + templates/index.html
 * `#tab-movement`. Workout-style routines of moves; the list menu drills into
 * a routine (recipe-style), each move opens an inline click-to-load YouTube
 * player, Edit grows the controls ("small until edit"), and a persisted
 * "hide videos" focus mode strips the detail view down to reps/timing.
 */
export function MovementPage() {
  const isPublic = isPublicMode();
  const { data, isLoading, isError, error } = useMovementData();
  const { toasts, push, dismiss } = useToasts();
  const actions = useMovementActions(push);

  // Which routine is drilled into, which is in edit mode, and whether the
  // "new routine" form is showing — the old tab kept these window-scoped so
  // they survived the 5s re-render; React state survives polls natively.
  const [viewId, setViewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [hideVideos, setHideVideos] = useState(readHideVideos);

  // Deletes mid "· Undo" toast: hidden from render immediately, but the API
  // call only fires once the toast times out (journal's pattern) — undo just
  // unhides, nothing was ever sent.
  const [pendingDeletes, setPendingDeletes] = useState<ReadonlySet<string>>(() => new Set());
  const deleteTimers = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>>({});

  const routines = useMemo(() => {
    const all = data?.movement?.routines ?? [];
    return all
      .filter((r) => !pendingDeletes.has(`routine:${r.id}`))
      .map((r) => {
        const moves = (r.moves ?? []).filter((m) => !pendingDeletes.has(`move:${r.id}:${m.id}`));
        return moves.length === (r.moves ?? []).length ? r : { ...r, moves };
      });
  }, [data, pendingDeletes]);

  const viewRoutine = viewId ? (routines.find((r) => r.id === viewId) ?? null) : null;

  // If the open routine is gone (e.g. just deleted), fall back to the menu —
  // same as the old renderMovement nulling _movementRoutineView.
  useEffect(() => {
    if (viewId && !isLoading && !viewRoutine) {
      setViewId(null);
      setEditingId(null);
    }
  }, [viewId, viewRoutine, isLoading]);

  // The old tab scrolled the window to the top when drilling in/out; here the
  // page div is the scroll container.
  const pageRef = useRef<HTMLDivElement>(null);
  function scrollTop() {
    if (pageRef.current) pageRef.current.scrollTop = 0;
  }

  function openRoutine(id: string) {
    setViewId(id);
    setEditingId(null);
    scrollTop();
  }

  function closeRoutine() {
    setViewId(null);
    setEditingId(null);
    scrollTop();
  }

  function toggleHideVideos() {
    setHideVideos((cur) => {
      const next = !cur;
      writeHideVideos(next);
      return next;
    });
  }

  function finalizeDelete(key: string) {
    const pending = deleteTimers.current[key];
    if (!pending) return;
    delete deleteTimers.current[key];
    setPendingDeletes((cur) => {
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
    pending.commit();
  }

  function cancelPendingDelete(key: string) {
    const pending = deleteTimers.current[key];
    if (pending) {
      clearTimeout(pending.timer);
      delete deleteTimers.current[key];
    }
    setPendingDeletes((cur) => {
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
  }

  function startPendingDelete(key: string, message: string, commit: () => void) {
    deleteTimers.current[key] = {
      timer: setTimeout(() => finalizeDelete(key), UNDO_DELETE_MS),
      commit,
    };
    setPendingDeletes((cur) => new Set(cur).add(key));
    push(message, {
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => cancelPendingDelete(key),
      duration: UNDO_DELETE_MS,
    });
  }

  // Navigating away entirely — commit any still-pending deletes rather than
  // silently dropping them (the undo window only makes sense while the toast
  // is visible).
  useEffect(() => {
    return () => {
      for (const key of Object.keys(deleteTimers.current)) finalizeDelete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function deleteRoutine(routine: MovementRoutine) {
    setEditingId(null);
    startPendingDelete(`routine:${routine.id}`, `Deleted routine “${routine.name}”`, () =>
      actions.removeRoutine(routine.id),
    );
  }

  function deleteMove(routineId: string, move: MovementMove) {
    startPendingDelete(`move:${routineId}:${move.id}`, `Removed “${move.name}”`, () =>
      actions.removeMove(routineId, move.id),
    );
  }

  function createRoutine(name: string, note: string) {
    actions.addRoutine(name, note);
    setNewOpen(false);
  }

  return (
    <div className={styles.page} ref={pageRef}>
      <div className={styles.sectionTitle}>Movement</div>
      {!viewRoutine ? (
        <div className={styles.subtitle}>
          Stretch and movement routines. Tap a move to open its video. Edit to add moves, paste
          links, or reorder.
        </div>
      ) : null}

      {isLoading ? (
        <div className={styles.empty}>Loading&hellip;</div>
      ) : isError && !data ? (
        // Error state only when there's nothing to show — a failed background
        // poll must not blank a working page while cached data exists.
        <div className={styles.empty}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : viewRoutine ? (
        <RoutineDetail
          routine={viewRoutine}
          editing={editingId === viewRoutine.id}
          hideVideos={hideVideos}
          onBack={closeRoutine}
          onToggleHideVideos={toggleHideVideos}
          onEditOpen={() => setEditingId(viewRoutine.id)}
          editor={
            <RoutineEditor
              routine={viewRoutine}
              actions={actions}
              onDone={() => setEditingId(null)}
              onDeleteRoutine={deleteRoutine}
              onDeleteMove={deleteMove}
              onError={push}
            />
          }
        />
      ) : (
        <>
          {routines.length ? (
            routines.map((r) => <RoutineListCard key={r.id} routine={r} onOpen={() => openRoutine(r.id)} />)
          ) : (
            <div className={styles.emptyBox}>
              No routines yet. Add one below to start collecting movements and their videos.
            </div>
          )}
          {newOpen ? (
            <NewRoutineForm onCreate={createRoutine} onCancel={() => setNewOpen(false)} onError={push} />
          ) : (
            <button type="button" className={styles.newBtn} onClick={() => setNewOpen(true)}>
              + New routine
            </button>
          )}
        </>
      )}

      {!isPublic ? <NotesPill tab="movement" onError={push} /> : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/** List menu card — tappable summary that drills into the routine. */
function RoutineListCard({ routine, onOpen }: { routine: MovementRoutine; onOpen: () => void }) {
  const n = (routine.moves ?? []).length;
  return (
    <div
      className={styles.listCard}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.listCardBody}>
        <div className={styles.listName}>{routine.name}</div>
        <div className={styles.listCount}>
          {n} move{n === 1 ? '' : 's'}
        </div>
        {routine.note ? <div className={styles.listNote}>{routine.note}</div> : null}
      </div>
      <span className={styles.chevron}>&#8250;</span>
    </div>
  );
}

function NewRoutineForm({
  onCreate,
  onCancel,
  onError,
}: {
  onCreate: (name: string, note: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      onError('Give the routine a name first.');
      return;
    }
    onCreate(trimmed, note.trim());
  }

  return (
    <div className={styles.newForm}>
      <input
        type="text"
        className={styles.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Routine name (e.g. Morning mobility)"
        autoFocus
      />
      <input
        type="text"
        className={`${styles.input} ${styles.inputLast}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
      />
      <div className={styles.formBtns}>
        <button type="button" className={styles.createBtn} onClick={create}>
          Create
        </button>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
