import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { sendUploadRefToTerminal, uploadTerminalFile } from './shellApi';
import styles from './UploadWidget.module.css';

/**
 * Upload trigger + drag-and-drop zone for the terminal pane — React port of
 * split.html's #uploadBtn / #fileInput / #dropCatcher (templates/split.html:
 * 604-613, 926-1013). "Make it possible to upload to the terminal by
 * dragging and dropping anywhere over the whole terminal" — scoped to this
 * pane (not the whole page) by rendering the catcher inside TerminalPane's
 * relatively-positioned body, so a drop over the dashboard pane is unaffected.
 *
 * The trick (same as split.html): `dragenter` on an iframe never bubbles, but
 * the browser fires it on the top-level document the instant a file drag
 * enters the window from outside — so we listen there just to flip the
 * catcher visible, then hand dragover/drop off to the catcher element itself.
 */
export function UploadWidget({ session, triggerClassName }: { session: string; triggerClassName?: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const catcherRef = useRef<HTMLDivElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, ms = 2500) => {
    clearTimeout(toastTimer.current ?? undefined);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };

  const upload = async (file: File) => {
    if (!file) return;
    showToast('Uploading…', 10000);
    try {
      const data = await uploadTerminalFile(file);
      if (data.path) {
        await sendUploadRefToTerminal(data.path, session);
        showToast('Uploaded — path pasted into terminal', 3000);
      } else {
        showToast('Upload error: no path returned', 4000);
      }
    } catch (e) {
      showToast(`Upload failed: ${e instanceof Error ? e.message : 'unknown error'}`, 4000);
    }
  };

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setDragActive(true);
    };
    document.addEventListener('dragenter', onDragEnter);
    return () => document.removeEventListener('dragenter', onDragEnter);
  }, []);

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // Only hide when actually leaving the catcher itself, not entering a child.
    if (e.target === catcherRef.current) setDragActive(false);
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void upload(file);
  };

  return (
    <>
      <button
        type="button"
        className={triggerClassName}
        title="Upload file"
        aria-label="Upload file"
        onClick={() => fileInputRef.current?.click()}
      >
        &#128206;
      </button>
      <input
        ref={fileInputRef}
        type="file"
        className={styles.fileInput}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
      <div
        ref={catcherRef}
        className={[styles.dropCatcher, dragActive ? styles.active : ''].filter(Boolean).join(' ')}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className={styles.dropLabel}>Drop file to upload</div>
      </div>
      {toast && <div className={[styles.toast, styles.visible].join(' ')}>{toast}</div>}
    </>
  );
}
