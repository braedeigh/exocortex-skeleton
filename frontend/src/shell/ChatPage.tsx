import { SessionBar } from './SessionBar';
import { PhoneFrames } from './PhoneFrames';
import { useSessionsContext } from './SessionsContext';
import styles from './ChatPage.module.css';

/**
 * Mobile "Chat" view — the phone counterpart to the desktop terminal pane
 * (SplitLayout -> TerminalPane), which only mounts >=769px (see
 * SplitLayout.tsx). Reuses SessionBar as-is for the session switcher and
 * PhoneFrames (the /phone equivalent of TerminalFrames) for keep-mounted
 * iframes, both driven by the same SessionsContext instance the mobile Chat
 * tab in TopTabs reads its label from — so switching sessions here updates
 * that label immediately, and vice versa.
 */
export function ChatPage() {
  const sessions = useSessionsContext();
  return (
    <div className={styles.page}>
      <SessionBar sessions={sessions} />
      <div className={styles.frames}>
        <PhoneFrames sessions={sessions} />
      </div>
    </div>
  );
}
