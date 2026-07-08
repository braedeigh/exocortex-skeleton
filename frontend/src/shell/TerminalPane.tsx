import { useState } from 'react';
import { SessionBar } from './SessionBar';
import { CopyPanel } from './CopyPanel';
import type { SessionState } from './useSessions';
import styles from './TerminalPane.module.css';

/**
 * Left pane of the desktop split — the React port of split.html's
 * `.pane-terminal` (templates/split.html:506-554), minus the widgets still to
 * be ported (upload / notes / scheduled prompts). It's the session bar over
 * the live ttyd terminal iframe, plus a Copy button that opens the selectable
 * capture overlay.
 *
 * The terminal itself stays an iframe on purpose: `/terminal/` is ttyd
 * (xterm.js streaming the real tmux session) — that's the one layer nobody
 * reimplements. `?arg=<session>` is the tmux target ttyd's connect script
 * attaches to; changing `active` reloads the iframe onto the new session.
 */
export function TerminalPane({ sessions }: { sessions: SessionState }) {
  const [copyOpen, setCopyOpen] = useState(false);
  const { active } = sessions;

  return (
    <div className={styles.pane}>
      <SessionBar sessions={sessions} />
      <div className={styles.body}>
        <iframe
          key={active}
          title={`Terminal — ${active}`}
          className={styles.frame}
          src={`/terminal/?arg=${encodeURIComponent(active)}`}
          scrolling="no"
        />
        <button
          type="button"
          className={styles.copyBtn}
          title="Copy text from the terminal"
          aria-label="Copy text from the terminal"
          onClick={() => setCopyOpen(true)}
        >
          Copy
        </button>
        {copyOpen && <CopyPanel session={active} onClose={() => setCopyOpen(false)} />}
      </div>
    </div>
  );
}
