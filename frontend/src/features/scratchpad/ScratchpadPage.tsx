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
    const ac = new AbortController();
    getScratchpad(ac.signal)
      .then((data) => {
        loadedRef.current = true;
        const content = data.content || '';
        // Local-first: adopt server content only if she hasn't typed yet.
        if (valueRef.current === lastSavedRef.current) {
          setValue(content);
          lastSavedRef.current = content;
        }
      })
      .catch(() => {
        if (ac.signal.aborted) return;
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
    function onBeforeUnload() {
      if (loadedRef.current && valueRef.current !== lastSavedRef.current) {
        void saveScratchpad(valueRef.current);
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (loadedRef.current && valueRef.current !== lastSavedRef.current) {
        void saveScratchpad(valueRef.current);
      }
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
    lastSavedRef.current = result.value;
    saveScratchpad(result.value).catch(() => showStatus({ label: 'save failed', ok: false }));
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
