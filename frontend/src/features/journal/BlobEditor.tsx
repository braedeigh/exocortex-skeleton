import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityMatcher } from './entityHighlight';
import { highlightEntities } from './entityHighlight';
import { mdToHtml } from './markdown';
import { insertAtCursor, timestampMarker } from './timestampInsert';
import styles from './BlobEditor.module.css';

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

export interface BlobEditorProps {
  /** Initial content for this day — component is keyed by date at the call site, so this only ever "changes" via poll refresh while not dirty. */
  initialContent: string;
  matcher: EntityMatcher;
  save: (content: string) => Promise<unknown>;
  onFocusChange: (focused: boolean) => void;
  /** Mount straight into edit mode (the "Start today's page" seeder lands here ready to type). Default 'read'. */
  initialMode?: 'read' | 'edit';
}

const AUTOSAVE_DELAY_MS = 1500;

/** Markdown-blob mode (pre-cutover days): read/edit toggle over the whole-day file, debounced autosave. */
export function BlobEditor({ initialContent, matcher, save, onFocusChange, initialMode = 'read' }: BlobEditorProps) {
  const [mode, setMode] = useState<'read' | 'edit'>(initialMode);
  const [value, setValue] = useState(initialContent);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const lastSavedRef = useRef(initialContent);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Seeder mount ("Start today's page"): land in the editor, cursor at the
  // end, ready to type — same as legacy startToday(). The focus event also
  // fires onFocusChange(true) via the textarea's own handler.
  useEffect(() => {
    if (initialMode !== 'edit') return;
    const el = taRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll refresh landed new content while the day wasn't dirty — pick it up.
  useEffect(() => {
    if (value === lastSavedRef.current && initialContent !== lastSavedRef.current) {
      setValue(initialContent);
      lastSavedRef.current = initialContent;
    }
  }, [initialContent, value]);

  async function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = valueRef.current;
    if (current === lastSavedRef.current) return;
    setStatus('saving');
    try {
      await save(current);
      lastSavedRef.current = current;
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch {
      setStatus('error');
    }
  }

  function onChange(next: string) {
    setValue(next);
    setStatus('unsaved');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void flush();
    }, AUTOSAVE_DELAY_MS);
  }

  /** Insert "*[8:46 AM]*" at the cursor — same marker stream.py writes at a
   * time-gap boundary, so a hand-typed entry blends with a real capture. */
  function addTimestamp() {
    const el = taRef.current;
    if (!el) return;
    insertAtCursor(el, valueRef.current, `\n${timestampMarker()}\n`, onChange);
  }

  useEffect(() => {
    function onBeforeUnload() {
      if (valueRef.current !== lastSavedRef.current) void save(valueRef.current);
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (valueRef.current !== lastSavedRef.current) void save(valueRef.current);
    };
  }, [save]);

  const previewHtml = useMemo(() => {
    if (!value.trim()) return null;
    return highlightEntities(mdToHtml(value), matcher);
  }, [value, matcher]);

  const statusLabel: Record<SaveStatus, string> = {
    idle: '',
    unsaved: 'Unsaved…',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Save failed',
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.toggle}>
          <button type="button" className={`${styles.toggleBtn} ${mode === 'read' ? styles.active : ''}`} onClick={() => setMode('read')}>
            Read
          </button>
          <button type="button" className={`${styles.toggleBtn} ${mode === 'edit' ? styles.active : ''}`} onClick={() => setMode('edit')}>
            Edit
          </button>
        </div>
        {mode === 'edit' ? (
          <button type="button" className={styles.timestampBtn} onClick={addTimestamp}>
            + Timestamp
          </button>
        ) : null}
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={taRef}
          className={styles.textarea}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => {
            onFocusChange(false);
            void flush();
          }}
        />
      ) : previewHtml ? (
        <div className={styles.preview} dangerouslySetInnerHTML={{ __html: previewHtml }} />
      ) : (
        <p className={styles.empty}>No entry for this day.</p>
      )}

      <div className={styles.status}>{statusLabel[status]}</div>
    </div>
  );
}
