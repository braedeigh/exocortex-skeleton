import { useRef, useState } from 'react';
import { SessionBar } from './SessionBar';
import { CopyPanel } from './CopyPanel';
import { TermNotesPanel } from './TermNotesPanel';
import { TerminalFrames } from './TerminalFrames';
import { scrollTerminal } from '../features/phone/phoneApi';
import type { SessionState } from './useSessions';
import styles from './TerminalPane.module.css';

type FloatingPanel = 'notes' | null;

/**
 * Left pane of the desktop split — the session bar over the live ttyd
 * terminal (one persistent iframe per visited session — see TerminalFrames),
 * plus a small floating toolbar: jump to top/bottom, Copy (selectable-text
 * overlay), and Notes.
 *
 * This is a PLAIN SHELL surface, not a Claude one. The conversation with
 * Claude moved to the Observatory, so the two widgets here that only made
 * sense while a Claude prompt was on the other end are gone: the paperclip
 * (uploaded a photo and typed its path into the prompt) and the stopwatch
 * (scheduled a *prompt* to be typed into a session at a set time). Both
 * still live on the Observatory page, which is where that work happens now;
 * only this pane dropped them. What's left is a terminal: attach, type,
 * scroll, copy.
 *
 * Prompt that shaped it: "replace the terminal tab with a pure terminal —
 * it's falling out of use as a Claude surface, I want a shell I can run
 * sudo commands from instead of SSHing in."
 */
export function TerminalPane({ sessions }: { sessions: SessionState }) {
  const [copyOpen, setCopyOpen] = useState(false);
  const [panel, setPanel] = useState<FloatingPanel>(null);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const { active } = sessions;

  const togglePanel = (name: Exclude<FloatingPanel, null>) => {
    setPanel((p) => (p === name ? null : name));
  };

  return (
    <div className={styles.pane}>
      <SessionBar sessions={sessions} />
      <div className={styles.body}>
        <TerminalFrames sessions={sessions} />

        {/* Jump / Copy / Notes fused into one segmented pill
            top-right — one shared container background/border/radius, thin
            dividers between the segments (see .topRight/.segBtn). ▲▲/▼▼ are
            the desktop port of the mobile corner jump buttons (dev note
            647ff100 — "re add the button to go all the way to the top"). */}
        <div className={styles.topRight}>
          <button
            type="button"
            className={styles.segBtn}
            title="Jump to top of scrollback"
            aria-label="Jump to top of scrollback"
            onClick={() => void scrollTerminal(active, 'up', 'end').catch(() => {})}
          >
            &#9650;&#9650;
          </button>
          <button
            type="button"
            className={styles.segBtn}
            title="Jump to bottom"
            aria-label="Jump to bottom of scrollback"
            onClick={() => void scrollTerminal(active, 'down', 'end').catch(() => {})}
          >
            &#9660;&#9660;
          </button>
          <button
            type="button"
            className={styles.segBtn}
            title="Copy text from the terminal"
            aria-label="Copy"
            onClick={() => setCopyOpen(true)}
          >
            &#128203;
          </button>
          <button
            ref={notesBtnRef}
            type="button"
            className={styles.segBtn}
            title="Terminal notes"
            aria-label="Terminal notes"
            onClick={() => togglePanel('notes')}
          >
            &#128221;
          </button>
        </div>

        <TermNotesPanel open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />

        {copyOpen && <CopyPanel session={active} onClose={() => setCopyOpen(false)} />}
      </div>
    </div>
  );
}
