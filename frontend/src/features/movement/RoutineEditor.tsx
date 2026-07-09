import { useEffect, useRef, useState } from 'react';
import { swapAdjacent } from './movementHelpers';
import type { MovementActions } from './useMovementData';
import type { MovementMove, MovementRoutine } from './types';
import styles from './RoutineEditor.module.css';

export interface RoutineEditorProps {
  routine: MovementRoutine;
  actions: MovementActions;
  onDone: () => void;
  /** Fires after the two-step confirm — the page hides the routine and shows the undo toast. */
  onDeleteRoutine: (routine: MovementRoutine) => void;
  /** Fires after the two-step confirm on a move's ×. */
  onDeleteMove: (routineId: string, move: MovementMove) => void;
  onError: (message: string) => void;
}

/**
 * Edit mode for one routine (movement.js `_movementRoutineEditor`): rename
 * the routine, edit/reorder/remove its moves, add a move. Text fields commit
 * on blur/Enter, like the old onchange handlers. Deletes are two-step
 * ("Sure?") instead of the legacy shared modal.
 */
export function RoutineEditor({
  routine,
  actions,
  onDone,
  onDeleteRoutine,
  onDeleteMove,
  onError,
}: RoutineEditorProps) {
  const moves = routine.moves ?? [];

  // Two-step confirm state: 'routine' for the Delete-routine button, or a
  // move id for that move's ×. Resets after 3s, same as the /notes browser.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  function requestConfirm(key: string, run: () => void) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmKey === key) {
      setConfirmKey(null);
      run();
      return;
    }
    setConfirmKey(key);
    confirmTimer.current = setTimeout(() => setConfirmKey(null), 3000);
  }

  function reorder(moveId: string, dir: -1 | 1) {
    const order = swapAdjacent(
      moves.map((m) => m.id),
      moveId,
      dir,
    );
    if (order) actions.reorderMoves(routine.id, order);
  }

  return (
    <div className={styles.editor}>
      <CommitInput
        className={`${styles.input} ${styles.nameInput}`}
        defaultValue={routine.name}
        placeholder="Routine name"
        requireValue
        onCommit={(name) => actions.updateRoutine(routine.id, { name })}
      />
      <CommitInput
        className={`${styles.input} ${styles.noteInput}`}
        defaultValue={routine.note ?? ''}
        placeholder="Optional note (how to approach it)"
        onCommit={(note) => actions.updateRoutine(routine.id, { note })}
      />

      <div className={styles.movesLabel}>Moves</div>
      {moves.length ? (
        moves.map((m, i) => (
          <MoveEditRow
            key={m.id}
            move={m}
            first={i === 0}
            last={i === moves.length - 1}
            confirming={confirmKey === m.id}
            onUpdate={(patch) => actions.updateMove(routine.id, m.id, patch)}
            onEmptyName={() => onError('name cannot be empty')}
            onReorder={(dir) => reorder(m.id, dir)}
            onRemove={() => requestConfirm(m.id, () => onDeleteMove(routine.id, m))}
          />
        ))
      ) : (
        <div className={styles.emptyMoves}>None yet &mdash; add the first below.</div>
      )}

      <AddMoveForm
        onAdd={(payload) => actions.addMove(routine.id, payload)}
        onError={onError}
      />

      <div className={styles.footer}>
        <button type="button" className={styles.doneBtn} onClick={onDone}>
          Done
        </button>
        <button
          type="button"
          className={`${styles.deleteRoutineBtn} ${confirmKey === 'routine' ? styles.deleteRoutineConfirm : ''}`}
          onClick={() => requestConfirm('routine', () => onDeleteRoutine(routine))}
        >
          {confirmKey === 'routine' ? 'Sure? Delete all' : 'Delete routine'}
        </button>
      </div>
    </div>
  );
}

interface MoveEditRowProps {
  move: MovementMove;
  first: boolean;
  last: boolean;
  confirming: boolean;
  onUpdate: (patch: { name?: string; dose?: string; url?: string; note?: string }) => void;
  onEmptyName: () => void;
  onReorder: (dir: -1 | 1) => void;
  onRemove: () => void;
}

function MoveEditRow({ move, first, last, confirming, onUpdate, onEmptyName, onReorder, onRemove }: MoveEditRowProps) {
  return (
    <div className={styles.moveRow}>
      <div className={styles.moveTop}>
        <div className={styles.arrows}>
          {!first ? (
            <button type="button" className={styles.arrowBtn} title="Move up" onClick={() => onReorder(-1)}>
              &#9650;
            </button>
          ) : (
            <span className={styles.arrowSpacer} />
          )}
          {!last ? (
            <button type="button" className={styles.arrowBtn} title="Move down" onClick={() => onReorder(1)}>
              &#9660;
            </button>
          ) : (
            <span className={styles.arrowSpacer} />
          )}
        </div>
        <CommitInput
          className={`${styles.input} ${styles.moveNameInput}`}
          defaultValue={move.name}
          placeholder="Move name"
          requireValue
          onEmptyValue={onEmptyName}
          onCommit={(name) => onUpdate({ name })}
        />
        <button
          type="button"
          className={`${styles.removeBtn} ${confirming ? styles.removeConfirm : ''}`}
          title="Remove move"
          aria-label={confirming ? `Confirm remove ${move.name}` : `Remove ${move.name}`}
          onClick={onRemove}
        >
          {confirming ? 'Sure?' : <>&times;</>}
        </button>
      </div>
      <CommitInput
        className={`${styles.input} ${styles.fieldInput}`}
        defaultValue={move.dose ?? ''}
        placeholder="Reps / hold (e.g. 20&ndash;30s &middot; 1&ndash;2&times;/side)"
        onCommit={(dose) => onUpdate({ dose })}
      />
      <CommitInput
        className={`${styles.input} ${styles.fieldInput}`}
        defaultValue={move.url ?? ''}
        placeholder="Video URL (paste a YouTube link &mdash; leave blank if none)"
        onCommit={(url) => onUpdate({ url })}
      />
      <CommitInput
        className={`${styles.input} ${styles.fieldInputLast}`}
        defaultValue={move.note ?? ''}
        placeholder="Optional cue (e.g. nose toward armpit)"
        onCommit={(note) => onUpdate({ note })}
      />
    </div>
  );
}

function AddMoveForm({
  onAdd,
  onError,
}: {
  onAdd: (payload: { name: string; dose: string; url: string; note: string }) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [dose, setDose] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');

  function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      onError('Name the move first.');
      return;
    }
    onAdd({ name: trimmed, dose: dose.trim(), url: url.trim(), note: note.trim() });
    setName('');
    setDose('');
    setUrl('');
    setNote('');
  }

  return (
    <div className={styles.addBox}>
      <input
        type="text"
        className={`${styles.input} ${styles.fieldInput}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New move name"
      />
      <input
        type="text"
        className={`${styles.input} ${styles.fieldInput}`}
        value={dose}
        onChange={(e) => setDose(e.target.value)}
        placeholder="Reps / hold (optional)"
      />
      <input
        type="text"
        className={`${styles.input} ${styles.fieldInput}`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Video URL (optional)"
      />
      <div className={styles.addRow}>
        <input
          type="text"
          className={`${styles.input} ${styles.addNoteInput}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Cue (optional)"
        />
        <button type="button" className={styles.addBtn} onClick={add}>
          Add move
        </button>
      </div>
    </div>
  );
}

interface CommitInputProps {
  defaultValue: string;
  placeholder?: string;
  className?: string;
  /** Reject an empty commit: restore the previous value instead of saving. */
  requireValue?: boolean;
  /** Called when an empty commit is rejected (e.g. to toast the server's wording). */
  onEmptyValue?: () => void;
  onCommit: (value: string) => void;
}

/**
 * Uncontrolled text input that commits on blur (Enter blurs), mirroring the
 * legacy onchange handlers — and, unlike the legacy 5s innerHTML re-render,
 * typing in progress is never clobbered by a poll.
 */
function CommitInput({ defaultValue, placeholder, className, requireValue, onEmptyValue, onCommit }: CommitInputProps) {
  const last = useRef(defaultValue);

  function commit(el: HTMLInputElement) {
    const value = el.value.trim();
    if (value === last.current) return;
    if (!value && requireValue) {
      el.value = last.current;
      onEmptyValue?.();
      return;
    }
    last.current = value;
    onCommit(value);
  }

  return (
    <input
      type="text"
      className={className}
      defaultValue={defaultValue}
      placeholder={placeholder}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}
