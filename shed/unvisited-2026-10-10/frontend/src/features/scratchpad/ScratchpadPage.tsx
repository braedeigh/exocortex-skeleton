import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { getScratchpad, saveScratchpad, sendNotesDumpRef } from './api';
import { canRedo, emptyStacks, pushSnapshot, redo, undo, type UndoStacks } from './undoStack';
import styles from './ScratchpadPage.module.css';

/**
 * Scratchpad — exact-parity port of legacy templates/notes.html (the old
 * /notes page; the React /notes route is the unrelated notes *browser*).
 * One autosaving textarea over /api/notes (notes_dump.md), an in-page
 * undo/redo stack (see undoStack.ts), and "Send to terminal", which pastes a
 * path reference to the dump into the active terminal session.
 *
 * Legacy behaviors kept exactly:
 * - Autosave debounce 800ms; skip if content === last saved.
 * - Undo snapshot = the *previous saved* content, pushed at save time
 *   (autosave granularity, not per-keystroke).
 * - Undo/redo write the restored text to the server immediately and treat it
 *   as saved; the Redo button only appears while the redo stack is non-empty.
 * - Typing clears the transient status; "saved"/"undone"/"redone" show for
 *   2s, "sent to terminal" for 3s; "save failed" persists until next input.
 * - Send-to-terminal saves first, then POSTs the fixed bracket message with
 *   enter:false (pasted, not submitted) and no session (backend targets the
 *   active session).
 *
 * Local-first guarantees added for the SPA (legacy was a never-unmounting
 * iframe): the only fetch is the one on mount — no poll/refetch can ever
 * clobber typing (if she types before that load lands, her keystrokes win);
 * a pending save is flushed on unmount and beforeunload; if the initial load
 * fails, saving stays disabled so a blank editor can't overwrite the dump.
 */

const SAVE_DEBOUNCE_MS = 800;

/** Dirty text stashed at unmount/beforeunload while its flush save is in
 * flight — if that save never lands (network drop, tab killed), the next
 * mount restores it instead of silently losing the draft. */
const DRAFT_KEY = 'scratchpad.pendingDraft';

function stashDraft(content: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, content);
  } catch {
    // localStorage unavailable — the flush save below is still attempted
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

function takeDraft(): string | null {
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    localStorage.removeItem(DRAFT_KEY);
    return draft;
  } catch {
    return null;
  }
}

interface StatusMsg {
  label: string;
  ok: boolean;
  /** Survives the typing-clears-status rule (load failure only). */
  sticky?: boolean;
}

export function ScratchpadPage() {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [redoVisible, setRedoVisible] = useState(false);

  const valueRef = useRef(value);
  valueRef.current = value;
  const lastSavedRef = useRef('');
  const loadedRef = useRef(false);
  const stacksRef = useRef<UndoStacks>(emptyStacks);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  function showStatus(msg: StatusMsg, clearAfterMs?: number) {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatus(msg);
    if (clearAfterMs) {
      statusTimerRef.current = setTimeout(() => setStatus(null), clearAfterMs);
    }
  }

  // Load once on mount — the only server read, so nothing can later clobber
  // in-progress typing (legacy loadNotes()).
  useEffect(() => {
    // A previous visit's unmount flush may not have landed — restore its
    // stashed draft (it reads as unsaved, so the post-load flush persists it).
    const draft = takeDraft();
    if (draft) {
      setValue(draft);
      showStatus({ label: 'restored unsaved draft', ok: false });
    }
    const ac = new AbortController();
    getScratchpad(ac.signal)
      .then((data) => {
        loadedRef.current = true;
        const content = data.content || '';
        // Local-first: adopt server content only if she hasn't typed yet.
        if (valueRef.current === lastSavedRef.current) {
          setValue(content);
          lastSavedRef.current = content;
        } else {
          // Her text (typed before the load landed, or a restored draft) wins
          // — and is dirty, so persist it now rather than waiting for the next
          // keystroke (a debounced save that fired pre-load was skipped).
          void flushSave();
        }
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        // Saving is disabled until a load succeeds — put a restored draft back
        // in the stash so the not-saving session can't be the one that loses it.
        if (valueRef.current !== lastSavedRef.current) stashDraft(valueRef.current);
        showStatus({ label: 'load failed — not saving', ok: false, sticky: true });
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Legacy focused the textarea whenever the tab became active (postMessage
  // tabActive / window === top); the native-route equivalent is mount.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // SPA safety net (legacy iframe never unmounted): flush a pending save when
  // navigating away or closing the tab — never lose the last 800ms of typing.
  useEffect(() => {
    // No status line survives an unmount, so a failed flush can't be surfaced
    // — instead the dirty text is stashed synchronously first and only cleared
    // once the save confirms, so the draft is never lost either way.
    function flushOnLeave() {
      if (loadedRef.current && valueRef.current !== lastSavedRef.current) {
        const pending = valueRef.current;
        stashDraft(pending);
        saveScratchpad(pending)
          .then(() => clearDraft())
          .catch(() => {});
      }
    }
    window.addEventListener('beforeunload', flushOnLeave);
    return () => {
      window.removeEventListener('beforeunload', flushOnLeave);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      flushOnLeave();
    };
  }, []);

  async function flushSave(): Promise<void> {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!loadedRef.current) return; // load failed/pending: don't overwrite the dump
    const content = valueRef.current;
    if (content === lastSavedRef.current) return;
    // Snapshot the previous saved content before the POST, like legacy
    // saveNotes() (pushSnapshot dedupes, so a failed save retried with the
    // same lastSaved doesn't double-push).
    stacksRef.current = pushSnapshot(stacksRef.current, lastSavedRef.current);
    setRedoVisible(canRedo(stacksRef.current));
    try {
      await saveScratchpad(content);
      lastSavedRef.current = content;
      // A stash from an earlier leave attempt is now stale — never let it
      // resurrect over what just saved.
      clearDraft();
      showStatus({ label: 'saved', ok: true }, 2000);
    } catch {
      showStatus({ label: 'save failed', ok: false });
    }
  }

  function onChange(next: string) {
    setValue(next);
    // Legacy input handler blanks the status; keep the load-failure warning.
    setStatus((s) => (s?.sticky ? s : null));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Restore from a stack: show it, mark it saved, persist it (legacy fired the POST without awaiting). */
  function applyRestore(result: { stacks: UndoStacks; value: string }, label: 'undone' | 'redone') {
    stacksRef.current = result.stacks;
    setRedoVisible(canRedo(result.stacks));
    setValue(result.value);
    const prevSaved = lastSavedRef.current;
    lastSavedRef.current = result.value;
    saveScratchpad(result.value)
      .then(() => clearDraft())
      .catch(() => {
        // Mark the restored text dirty again so the next flush (typing,
        // unmount) retries it, instead of it silently never reaching the server.
        if (lastSavedRef.current === result.value) lastSavedRef.current = prevSaved;
        showStatus({ label: 'save failed', ok: false });
      });
    showStatus({ label, ok: true }, 2000);
  }

  function handleUndo() {
    const result = undo(stacksRef.current, valueRef.current);
    if (!result) return;
    applyRestore(result, 'undone');
  }

  function handleRedo() {
    const result = redo(stacksRef.current, valueRef.current);
    if (!result) return;
    applyRestore(result, 'redone');
  }

  async function handleSend() {
    if (!valueRef.current.trim()) return;
    await flushSave(); // save first, like legacy sendToTerminal()
    try {
      await sendNotesDumpRef();
      showStatus({ label: 'sent to terminal', ok: true }, 3000);
    } catch {
      showStatus({ label: 'send failed', ok: false }, 3000);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.statusRow}>
        <span className={styles.title}>Notes</span>
        <span className={status?.ok ? styles.statusOk : styles.statusText} aria-live="polite">
          {status?.label ?? ''}
        </span>
      </div>
      <textarea
        ref={taRef}
        className={styles.textarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Dump anything here — thoughts, links, transcripts, to-dos. It auto-saves. Hit 'Send to terminal' when you want Claude to process it."
      />
      <div className={styles.actions}>
        {/* Legacy layout: undo/redo share the left half; send owns the right. */}
        <div className={styles.undoGroup}>
          <Button variant="secondary" className={styles.actionBtn} onClick={handleUndo}>
            Undo
          </Button>
          {redoVisible ? (
            <Button variant="secondary" className={styles.actionBtn} onClick={handleRedo}>
              Redo
            </Button>
          ) : null}
        </div>
        <Button variant="primary" className={styles.actionBtn} onClick={() => void handleSend()}>
          Send to terminal
        </Button>
      </div>
    </div>
  );
}
