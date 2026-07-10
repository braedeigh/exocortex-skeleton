import { useEffect, useMemo, useRef, useState } from 'react';
import type { PersonalitySection } from './personalityDoc';
import { renderSectionHtml } from './personalityDoc';
import styles from './SectionDetail.module.css';

type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

export interface SectionDetailProps {
  /** The open section — the component is keyed by section index at the call
   * site, so this only "changes" when our own save re-normalizes the doc. */
  section: PersonalitySection;
  /** Splice this block over the section and save the whole doc. Rejects on failure. */
  save: (newBlock: string) => Promise<void>;
  /** Return to the section list. Any pending edit is flushed first. */
  onBack: () => void;
}

const AUTOSAVE_DELAY_MS = 1500;

/**
 * One section opened full-view: Read/Edit toggle over the section's raw block
 * (summary comment + heading + body) with debounced autosave — the detail
 * half of templates/personality.html, on the journal BlobEditor pattern.
 * Unlike the legacy page, the read preview renders the *current* editor value
 * (not the last-saved parse), so toggling Read mid-debounce never shows stale
 * text; dirty edits are never overwritten by a doc update.
 */
export function SectionDetail({ section, save, onBack }: SectionDetailProps) {
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [value, setValue] = useState(section.block);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const lastSavedRef = useRef(section.block);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // The doc changed while this section isn't dirty (a save re-normalized the
  // parse) — adopt the fresh block. Dirty edits always win.
  useEffect(() => {
    if (value === lastSavedRef.current && section.block !== lastSavedRef.current) {
      setValue(section.block);
      lastSavedRef.current = section.block;
    }
  }, [section.block, value]);

  // Entering edit mode focuses the editor, same as the legacy setSectionMode.
  useEffect(() => {
    if (mode === 'edit') taRef.current?.focus();
  }, [mode]);

  /** Returns false when the save failed (status shows the sticky "Save error"). */
  async function flush(): Promise<boolean> {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = valueRef.current;
    if (current === lastSavedRef.current) return true;
    setStatus('saving');
    try {
      await save(current);
      lastSavedRef.current = current;
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
      return true;
    } catch {
      setStatus('error');
      return false;
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

  // Leaving the page (or unmounting the route) with a pending edit saves it,
  // like the legacy beforeunload + closeSection handlers.
  useEffect(() => {
    // Swallow rejections here — the component is unmounting (or the tab is
    // closing), so there's no status line left to show a failure on. The
    // in-app back path goes through handleBack below, which does block.
    function onBeforeUnload() {
      if (valueRef.current !== lastSavedRef.current) save(valueRef.current).catch(() => {});
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (valueRef.current !== lastSavedRef.current) save(valueRef.current).catch(() => {});
    };
  }, [save]);

  async function handleBack() {
    // A failed save keeps her on the section — leaving would unmount the
    // editor and silently drop the unsaved block ("Save error" stays up).
    if (await flush()) onBack();
  }

  const previewHtml = useMemo(() => renderSectionHtml(value), [value]);

  const statusLabel: Record<SaveStatus, string> = {
    idle: '',
    unsaved: 'Unsaved…',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Save error',
  };

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={() => void handleBack()}>
          &larr; sections
        </button>
        <div className={styles.modeToggle}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'read' ? styles.active : ''}`}
            onClick={() => setMode('read')}
          >
            Read
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'edit' ? styles.active : ''}`}
            onClick={() => setMode('edit')}
          >
            Edit
          </button>
        </div>
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={taRef}
          className={styles.editor}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => void flush()}
        />
      ) : previewHtml ? (
        <div className={styles.preview} dangerouslySetInnerHTML={{ __html: previewHtml }} />
      ) : (
        <div className={styles.preview}>
          <p className={styles.emptyMsg}>Empty.</p>
        </div>
      )}

      <div className={styles.status}>{statusLabel[status]}</div>
    </div>
  );
}
