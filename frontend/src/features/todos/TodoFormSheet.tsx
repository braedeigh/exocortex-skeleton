import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Checkbox, IconButton, Sheet } from '../../ui';
import { AgentNotes } from './AgentNotes';
import { originLine } from './provenance';
import { BlockerPicker } from './BlockerPicker';
import { LADDER_LABELS, fmtAddedDate, fmtTime, isWaiting, waitingReason } from './todoHelpers';
import { emptyDraft, draftFromItem, draftToAddPayload, diffDraftForSave } from './todoDraft';
import type { TodoDraft } from './todoDraft';
import { FRONT_EMOJI } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import type { useTodoActions } from './useTodayData';
import type { TodoItem } from './types';
import styles from './TodoFormSheet.module.css';

/** The subset of useTodoActions the form needs — everything except toggle/
 * reorder/autosort/bulk/snooze (add mode uses the awaitable `addAsync`
 * instead of the fire-and-forget `add`). */
export type TodoFormActions = Pick<
  ReturnType<typeof useTodoActions>,
  | 'addAsync'
  | 'rename'
  | 'details'
  | 'move'
  | 'remove'
  | 'subtaskAdd'
  | 'subtaskToggle'
  | 'subtaskRemove'
  | 'agentNoteRemove'
>;

export interface TodoFormSheetProps {
  mode: 'add' | 'edit';
  open: boolean;
  onClose: () => void;
  /** edit mode only. */
  item?: TodoItem | null;
  /** edit: the item's current section label. add: the section the draft
   * should open preset to. */
  currentSection: string | null;
  /** add mode only — carried over from the launch point (quick-add text,
   * the active focus front, etc). */
  prefill?: { text?: string; dueBy?: string; fronts?: string[] };
  serverDate: string;
  /** id -> item, across every section — for the "do after" blocker label
   * lookup (a blocker to-do can outlive its own section, e.g. once done). */
  todoIndex: Map<string, TodoItem>;
  /** Not-done ladder to-dos, offered as "do after" blockers. */
  candidates: TodoItem[];
  fronts: Front[];
  actions: TodoFormActions;
}

/**
 * The unified full-fat to-do form — one modal for both "+ add" and "edit
 * to-do". Every option the form supports is visible flat (no "more options"
 * progressive disclosure): title, section, notes, sub-tasks (edit only),
 * focus fronts, due, do-after, duration, a Done block (edit only, when the
 * item is already done), and an "Added" meta line (edit only).
 *
 * Nothing commits until Save/Add — the whole form stages into a single
 * `TodoDraft`, and `diffDraftForSave` (edit) / `draftToAddPayload` (add) turn
 * it into the wire shape on submit. The one exception is sub-tasks: they're
 * their own mini CRUD (add/toggle/remove) against their own endpoints, and
 * always render from the live `item` prop rather than the draft, so they
 * stay instant and don't get lost if the rest of the form is abandoned.
 *
 * `place_id` exists on `TodoItem`/`AddTodoPayload` server-side, but is
 * deliberately left off the draft/form — there's no place picker UI yet.
 */
export function TodoFormSheet({
  mode,
  open,
  onClose,
  item,
  currentSection,
  prefill,
  serverDate,
  todoIndex,
  candidates,
  fronts,
  actions,
}: TodoFormSheetProps) {
  const [draft, setDraft] = useState<TodoDraft>(() => emptyDraft(currentSection ?? 'Now', prefill));
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [newSubtask, setNewSubtask] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  // Re-init keyed on the open-transition + item id + mode — deliberately NOT
  // on the `item` object reference, `currentSection`, or `prefill`: a
  // sub-task commit or the 5s poll hands back a new `item`/`currentSection`
  // reference for the same logical to-do, and re-running this would clobber
  // whatever the user has staged but not yet saved.
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit') {
      if (item) setDraft(draftFromItem(item, currentSection ?? ''));
    } else {
      setDraft(emptyDraft(currentSection ?? 'Now', prefill));
    }
    setConfirmingRemove(false);
    setNewSubtask('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, item?.id]);

  useEffect(() => {
    if (open && mode === 'add') titleRef.current?.focus();
  }, [open, mode]);

  if (!open || (mode === 'edit' && !item)) return null;

  function patch(fn: (d: TodoDraft) => TodoDraft) {
    setDraft(fn);
  }

  async function handleAdd() {
    const trimmed = draft.text.trim();
    if (!trimmed) {
      titleRef.current?.focus();
      return;
    }
    const payload = draftToAddPayload(draft);
    try {
      await actions.addAsync(payload);
    } catch {
      // The mutation's own onError already rolled back and toasted — keep
      // the modal open so the draft isn't lost.
      return;
    }
    onClose();
  }

  function handleSave() {
    if (!item) return;
    const diff = diffDraftForSave(draft, item, currentSection ?? '');
    if (diff.newText !== undefined) actions.rename(item.id, diff.newText);
    if (Object.keys(diff.patch).length > 0) actions.details(item.id, diff.patch);
    if (diff.moveTo !== undefined) actions.move(item.id, diff.moveTo);
    onClose();
  }

  function handleDelete() {
    if (!item) return;
    actions.remove(item.id);
    onClose();
  }

  const title = mode === 'add' ? `Add to ${draft.section}` : 'Edit to-do';

  const footer =
    mode === 'add' ? (
      <div className={styles.footerRow}>
        <div className={styles.footerSpacer} />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleAdd} data-track="todo-form-add">
          Add
        </Button>
      </div>
    ) : confirmingRemove ? (
      <div className={styles.footerRow}>
        <span className={styles.confirmText}>Delete this to-do?</span>
        <Button variant="secondary" onClick={() => setConfirmingRemove(false)}>
          Keep
        </Button>
        <Button variant="danger" onClick={handleDelete} data-track="todo-form-delete">
          Delete
        </Button>
      </div>
    ) : (
      <div className={styles.footerRow}>
        <Button variant="danger" onClick={() => setConfirmingRemove(true)}>
          Delete
        </Button>
        <div className={styles.footerSpacer} />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} data-track="todo-form-save">
          Save
        </Button>
      </div>
    );

  return (
    <Sheet open={open} title={title} onClose={onClose} footer={footer}>
      {/* 1. Title */}
      <div className={styles.field}>
        <input
          ref={titleRef}
          className={`${styles.input} ${styles.titleInput}`}
          value={draft.text}
          onChange={(e) => patch((d) => ({ ...d, text: e.target.value }))}
          placeholder="What needs doing?"
          aria-label="Title"
        />
      </div>

      {/* 2. Section */}
      <div className={styles.field}>
        <span className={styles.label}>Section</span>
        <div className={styles.chips}>
          {LADDER_LABELS.map((label) => (
            <button
              type="button"
              key={label}
              className={`${styles.chip} ${draft.section === label ? styles.active : ''}`}
              onClick={() => patch((d) => ({ ...d, section: label }))}
              data-track="todo-form-section"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 3. Notes */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="tf-notes">
          Description
        </label>
        <textarea
          id="tf-notes"
          className={styles.textarea}
          value={draft.notes}
          onChange={(e) => patch((d) => ({ ...d, notes: e.target.value }))}
          placeholder="Any details…"
        />
      </div>

      {/* 3b. From agents (edit only) — notes an agent left, each with its
          author, minute, and citation links; dismiss-only, never editable.
          Kept visibly apart from the Description above: hers vs theirs. */}
      {mode === 'edit' && item?.agent_notes?.length ? (
        <div className={styles.field}>
          <span className={styles.label}>From agents</span>
          <AgentNotes notes={item.agent_notes} onDismiss={(n) => actions.agentNoteRemove(item.id, n.by, n.at)} />
        </div>
      ) : null}

      {/* 4. Sub-tasks (edit only — they commit instantly against the item's
          id, so an unsaved add has nothing to attach them to) — always reads
          the live item prop, never the draft. */}
      {mode === 'edit' && item ? (
        <div className={styles.field}>
          <span className={styles.label}>Sub-tasks</span>
          {item.subtasks?.length ? (
            <div className={styles.subtaskList}>
              {item.subtasks.map((sub) => (
                <div key={sub.id} className={styles.subtaskRow}>
                  <Checkbox
                    checked={sub.done}
                    onChange={() => actions.subtaskToggle(item.id, sub.id)}
                    aria-label={sub.done ? `Mark ${sub.text} not done` : `Mark ${sub.text} done`}
                    data-track="todo-subtask-toggle"
                  />
                  <span className={`${styles.subtaskText} ${sub.done ? styles.subtaskDone : ''}`}>
                    {sub.text}
                  </span>
                  <IconButton
                    danger
                    aria-label={`Remove sub-task ${sub.text}`}
                    onClick={() => actions.subtaskRemove(item.id, sub.id)}
                    data-track="todo-subtask-remove"
                  >
                    &times;
                  </IconButton>
                </div>
              ))}
            </div>
          ) : null}
          <form
            className={styles.subtaskAddRow}
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = newSubtask.trim();
              if (!trimmed) return;
              actions.subtaskAdd(item.id, trimmed);
              setNewSubtask('');
            }}
          >
            <input
              className={styles.input}
              type="text"
              value={newSubtask}
              onChange={(e) => setNewSubtask(e.target.value)}
              placeholder="Add a sub-task…"
              aria-label="New sub-task"
            />
            <Button type="submit" variant="secondary" data-track="todo-subtask-add">
              Add
            </Button>
          </form>
        </div>
      ) : null}

      {/* 5. Focus — staged multi-select, unlike the old per-item editor's instant commit. */}
      <div className={styles.field}>
        <span className={styles.label}>Focus</span>
        <div className={styles.chips}>
          {fronts.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`${styles.chip} ${draft.fronts.includes(f.id) ? styles.active : ''}`}
              data-track="todo-form-front"
              onClick={() =>
                patch((d) => ({
                  ...d,
                  fronts: d.fronts.includes(f.id) ? d.fronts.filter((x) => x !== f.id) : [...d.fronts, f.id],
                }))
              }
            >
              {FRONT_EMOJI[f.id] || '🏷️'} {f.name}
            </button>
          ))}
        </div>
      </div>

      {/* 6. Due */}
      <div className={styles.field}>
        <span className={styles.label}>Due</span>
        <div className={styles.row2}>
          <input
            className={styles.input}
            type="date"
            value={draft.dueBy}
            onChange={(e) => patch((d) => ({ ...d, dueBy: e.target.value }))}
            aria-label="Due date"
          />
          <input
            className={styles.input}
            type="time"
            value={draft.dueTime}
            onChange={(e) => patch((d) => ({ ...d, dueTime: e.target.value }))}
            aria-label="Due time"
          />
        </div>
        {draft.dueBy ? (
          <button
            type="button"
            className={styles.chip}
            onClick={() => patch((d) => ({ ...d, dueBy: '', dueTime: '' }))}
          >
            &#8617; Remove date
          </button>
        ) : null}
      </div>

      {/* 7. Do after */}
      <div className={styles.field}>
        <span className={styles.label}>Do after</span>
        <input
          className={styles.input}
          type="date"
          value={draft.afterDate}
          onChange={(e) => patch((d) => ({ ...d, afterDate: e.target.value }))}
          aria-label="Do after date"
        />
        {draft.afterDate ? (
          <button type="button" className={styles.chip} onClick={() => patch((d) => ({ ...d, afterDate: '' }))}>
            &#8617; Remove date
          </button>
        ) : null}
        <label className={styles.label} htmlFor="tf-after-todo">
          After another to-do
        </label>
        <BlockerPicker
          inputId="tf-after-todo"
          candidates={candidates.filter((c) => c.id !== item?.id)}
          value={draft.afterId}
          selectedLabel={draft.afterId ? todoIndex.get(draft.afterId)?.text : undefined}
          onChange={(id) => patch((d) => ({ ...d, afterId: id }))}
        />
        {item && isWaiting(item, serverDate, todoIndex) ? (
          <span className={styles.meta}>Waiting {waitingReason(item, todoIndex)}</span>
        ) : null}
      </div>

      {/* 8. Duration */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="tf-duration">
          Duration (minutes)
        </label>
        <div className={styles.chips}>
          {[15, 30, 60].map((m) => (
            <button
              type="button"
              key={m}
              className={`${styles.chip} ${draft.durationMin === String(m) ? styles.active : ''}`}
              onClick={() => patch((d) => ({ ...d, durationMin: String(m) }))}
            >
              {m}m
            </button>
          ))}
          <input
            id="tf-duration"
            className={styles.input}
            style={{ width: 90 }}
            type="number"
            min={0}
            step={5}
            value={draft.durationMin}
            onChange={(e) => patch((d) => ({ ...d, durationMin: e.target.value }))}
            placeholder="min"
          />
        </div>
      </div>

      {/* 9. Done — edit only, and only once the item is actually done. Lets
          her assign the "actually done" moment (finished_on/finished_time),
          distinct from done_at (the auto date-only stamp of when she marked
          it done). A time without a date is legal in the draft — the
          Cleared view ignores finished_time unless finished_on is set. */}
      {mode === 'edit' && item?.done ? (
        <div className={styles.field}>
          <span className={styles.label}>Done</span>
          {item.done_at ? (
            <span className={styles.meta}>
              Marked done {fmtAddedDate(item.done_at.slice(0, 10))}
              {item.done_at.length > 10 ? `, ${fmtTime(item.done_at.slice(11, 16))}` : ''}
            </span>
          ) : null}
          <div className={styles.row2}>
            <input
              className={styles.input}
              type="date"
              value={draft.finishedOn}
              onChange={(e) => patch((d) => ({ ...d, finishedOn: e.target.value }))}
              aria-label="Actually done date"
            />
            <input
              className={styles.input}
              type="time"
              value={draft.finishedTime}
              onChange={(e) => patch((d) => ({ ...d, finishedTime: e.target.value }))}
              aria-label="Actually done time"
            />
          </div>
          {draft.finishedOn ? (
            <button
              type="button"
              className={styles.chip}
              onClick={() => patch((d) => ({ ...d, finishedOn: '', finishedTime: '' }))}
            >
              &#8617; Remove date
            </button>
          ) : null}
          <input
            className={styles.input}
            type="text"
            value={draft.finishedNote}
            onChange={(e) => patch((d) => ({ ...d, finishedNote: e.target.value }))}
            placeholder="How it went… (optional)"
            aria-label="Completion note"
          />
        </div>
      ) : null}

      {/* 10. Added meta (edit only) — who and when (provenance.originLine);
          an agent-made item links to the conversation it came out of. */}
      {mode === 'edit' && item && (item.created || item.origin) ? (
        <div className={styles.meta}>
          {originLine(item.origin, item.created, fmtAddedDate)}
          {item.origin?.conv ? (
            <>
              {' · '}
              <Link to="/observatory/$botId" params={{ botId: item.origin.conv }} className={styles.metaLink}>
                open conversation ↗
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
