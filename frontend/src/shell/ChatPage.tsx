import { PhoneFrames } from './PhoneFrames';
import { useSessionsContext } from './SessionsContext';
import styles from './ChatPage.module.css';

/**
 * Mobile "Chat" view — the phone counterpart to the desktop terminal pane
 * (SplitLayout -> TerminalPane), which only mounts >=769px (see
 * SplitLayout.tsx). PhoneFrames (the /phone equivalent of TerminalFrames)
 * keeps one iframe per visited session mounted. Session switching lives on
 * the /sessions full-page switcher (SessionListPage), reached by tapping the
 * Chat dash-tab while already here (see TopTabs).
 */
export function ChatPage() {
  const sessions = useSessionsContext();

  return (
    <div className={styles.page}>
      <div className={styles.frames}>
        <PhoneFrames sessions={sessions} />
      </div>
    </div>
  );
}
