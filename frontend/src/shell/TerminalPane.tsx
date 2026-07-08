import { useRef, useState } from 'react';
import { SessionBar } from './SessionBar';
import { CopyPanel } from './CopyPanel';
import { TermNotesPanel } from './TermNotesPanel';
import { SchedulePanel } from './SchedulePanel';
import { UploadWidget } from './UploadWidget';
import { TerminalFrames } from './TerminalFrames';
import type { SessionState } from './useSessions';
import styles from './TerminalPane.module.css';

type FloatingPanel = 'notes' | 'schedule' | null;

/**
 * Left pane of the desktop split — the React port of split.html's
 * `.pane-terminal` (templates/split.html:506-554), including the widgets
 * that weren't ported yet: terminal notes, scheduled prompts, and upload
 * (drag-and-drop + picker). It's the session bar over the live ttyd
 * terminal (one persistent iframe per visited session — see TerminalFrames),
 * plus a floating toolbar: Copy (selectable-text overlay), Upload, Schedule,
 * and Notes.
 */
export function TerminalPane({ sessions }: { sessions: SessionState }) {
  const [copyOpen, setCopyOpen] = useState(false);
  const [panel, setPanel] = useState<FloatingPanel>(null);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  const { active } = sessions;

  const togglePanel = (name: Exclude<FloatingPanel, null>) => {
    setPanel((p) => (p === name ? null : name));
  };

  return (
    <div className={styles.pane}>
      <SessionBar sessions={sessions} />
      <div className={styles.body}>
        <TerminalFrames sessions={sessions} />

        <button
          type="button"
          className={styles.copyBtn}
          title="Copy text from the terminal"
          aria-label="Copy text from the terminal"
          onClick={() => setCopyOpen(true)}
        >
          Copy
        </button>

        <div className={styles.toolbar}>
          <UploadWidget session={active} triggerClassName={styles.toolBtn} />
          <button
            ref={schedBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Schedule a prompt"
            aria-label="Schedule a prompt"
            onClick={() => togglePanel('schedule')}
          >
            &#9200;
          </button>
          <button
            ref={notesBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Terminal notes"
            aria-label="Terminal notes"
            onClick={() => togglePanel('notes')}
          >
            &#128221;
          </button>
        </div>

        <SchedulePanel
          open={panel === 'schedule'}
          onClose={() => setPanel(null)}
          triggerRef={schedBtnRef}
          sessionNames={sessions.sessions}
        />
        <TermNotesPanel open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />

        {copyOpen && <CopyPanel session={active} onClose={() => setCopyOpen(false)} />}
      </div>
    </div>
  );
}
