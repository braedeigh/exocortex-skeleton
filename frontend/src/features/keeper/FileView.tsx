import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import { renderKeeperPreview } from './keeperMarkdown';
import type { WikilinkResolver } from './keeperMarkdown';
import { splitPath } from './tree';
import styles from './FileView.module.css';

export interface FileViewProps {
  path: string;
  /** Keyed by path at the call site, so this only "changes" via the 4s poll
   * while the editor isn't dirty. */
  initialContent: string;
  resolveWikilink: WikilinkResolver;
  save: (content: string) => Promise<unknown>;
  onOpenFile: (path: string) => void;
  onAskDelete: () => void;
  /** Textarea focus — the parent pauses the live poll while true. */
  onFocusChange: (focused: boolean) => void;
  /** Shared save-status line at the bottom of the pane (legacy #status). */
  setStatus: Dispatch<SetStateAction<string>>;
}

const AUTOSAVE_DELAY_MS = 1500;

/**
 * The content pane for one open file: path label, Read/Edit toggle, delete
 * button, markdown preview with clickable wikilinks + frontmatter chips, and
 * a debounced-autosave editor. Poll refreshes land through `initialContent`
 * and are only applied while the editor is clean — a dirty edit is never
 * overwritten (same guard as journal's BlobEditor).
 */
export function FileView({
  path,
  initialContent,
  resolveWikilink,
  save,
  onOpenFile,
  onAskDelete,
  onFocusChange,
  setStatus,
}: FileViewProps) {
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [value, setValue] = useState(initialContent);
  const lastSavedRef = useRef(initialContent);
  const valueRef = useRef(value);
  valueRef.current = value;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep the latest callbacks in refs so the unmount/beforeunload flush effect
  // can run with [] deps — re-running it on every render would flush a dirty
  // editor mid-typing and defeat the debounce.
  const saveRef = useRef(save);
  saveRef.current = save;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  const setStatusRef = useRef(setStatus);
  setStatusRef.current = setStatus;

  // Poll refresh landed new content while the editor was clean — pick it up.
  useEffect(() => {
    if (value === lastSavedRef.current && initialContent !== lastSavedRef.current) {
      setValue(initialContent);
      lastSavedRef.current = initialContent;
    }
  }, [initialContent, value]);

  // Entering edit mode focuses the textarea (legacy setMode('edit')).
  useEffect(() => {
    if (mode === 'edit') taRef.current?.focus();
  }, [mode]);

  async function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = valueRef.current;
    if (current === lastSavedRef.current) return;
    try {
      await saveRef.current(current);
      lastSavedRef.current = current;
      setStatusRef.current('Saved');
      setTimeout(() => setStatusRef.current((s) => (s === 'Saved' ? '' : s)), 2000);
    } catch {
      setStatusRef.current('Save failed');
    }
  }

  function onChange(next: string) {
    setValue(next);
    setStatus('Unsaved…');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void flush();
    }, AUTOSAVE_DELAY_MS);
  }

  // Never lose an edit: flush on tab close and on unmount (switching files,
  // navigating away). Skips cleanly when nothing is dirty.
  useEffect(() => {
    function onBeforeUnload() {
      if (valueRef.current !== lastSavedRef.current) void saveRef.current(valueRef.current);
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (valueRef.current !== lastSavedRef.current) void saveRef.current(valueRef.current);
      onFocusChangeRef.current(false); // unmounting while focused must not leave the poll paused
    };
  }, []);

  const previewHtml = useMemo(() => renderKeeperPreview(value, resolveWikilink), [value, resolveWikilink]);

  // Click a wikilink to jump to that memory file (dead links carry no
  // data-target, so they fall through — same as the legacy delegate).
  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.wikilink');
    const target = link?.dataset.target;
    if (target) onOpenFile(target);
  }

  const { dir, base } = splitPath(path);

  return (
    <div className={styles.wrap}>
      <div className={styles.paneHead}>
        <span className={styles.filepath} title={path}>
          {dir ? <span className={styles.dir}>{dir}</span> : null}
          {base}
        </span>
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
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={onAskDelete}
          title="Delete this file"
          aria-label="Delete file"
        >
          &#128465;
        </button>
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
      ) : (
        <div className={styles.preview} onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: previewHtml }} />
      )}
    </div>
  );
}
