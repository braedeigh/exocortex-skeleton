import { useEffect, useRef, useState } from 'react';
import styles from './CopyPanel.module.css';

/**
 * Selectable-text overlay for the terminal — the React port of phone.html's
 * copy overlay (openCopy/doCopy, templates/phone.html:255-337). Solves the
 * "I can't copy out of the terminal" problem: tmux mouse-mode eats drag
 * selections into its own private buffer, so instead we pull the pane's
 * scrollback as plain text (/api/terminal/capture -> tmux capture-pane) into
 * a real <textarea>, where normal selection works and Copy writes straight to
 * the system clipboard.
 */
export function CopyPanel({ session, onClose }: { session: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/terminal/capture?session=${encodeURIComponent(session)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setText(typeof data.text === 'string' ? data.text : '');
      })
      .catch(() => {
        if (!cancelled) setError('Could not read the terminal.');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Select-all once the text lands, so a straight ⌘C/Ctrl+C works with no
  // extra clicks — but the user can still drag to narrow the selection.
  useEffect(() => {
    if (text && areaRef.current) {
      areaRef.current.focus();
      areaRef.current.select();
    }
  }, [text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    const area = areaRef.current;
    // Prefer the user's own selection; fall back to the whole buffer.
    const selected = area && area.selectionStart !== area.selectionEnd
      ? area.value.slice(area.selectionStart, area.selectionEnd)
      : text;
    try {
      await navigator.clipboard.writeText(selected);
    } catch {
      // Older/insecure contexts: fall back to execCommand via the textarea.
      area?.select();
      try {
        document.execCommand('copy');
      } catch {
        return; // leave the panel open so they can copy manually
      }
    }
    onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        <div className={styles.header}>Select text, then Copy — or just hit Copy for everything.</div>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          <textarea ref={areaRef} className={styles.text} readOnly value={text} spellCheck={false} />
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.copyBtn} onClick={copy} disabled={!!error}>
            Copy
          </button>
          <button type="button" className={styles.closeBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
