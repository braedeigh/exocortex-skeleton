import { useEffect } from 'react';
import { PhoneFrames } from './PhoneFrames';
import { ChatSessionPicker } from './ChatSessionPicker';
import { useSessionsContext } from './SessionsContext';
import styles from './ChatPage.module.css';

/**
 * Mobile "Chat" view — the phone counterpart to the desktop terminal pane
 * (SplitLayout -> TerminalPane), which only mounts >=769px (see
 * SplitLayout.tsx). PhoneFrames (the /phone equivalent of TerminalFrames)
 * keeps one iframe per visited session mounted, and the session picker
 * (ChatSessionPicker) is collapsed by default so the terminal gets full
 * height — it opens/closes by tapping the Chat dash-tab while already on
 * /chat (see TopTabs), via the pickerOpen state both components share
 * through SessionsContext.
 */
export function ChatPage() {
  const sessions = useSessionsContext();
  const { pickerOpen, closePicker } = sessions;

  // "Picker closed on arrival": its open state never survives leaving /chat.
  useEffect(() => closePicker, [closePicker]);

  // Tapping into the terminal moves focus into the /phone iframe, which
  // fires window 'blur' — treat that as "done picking" and fold the row away.
  useEffect(() => {
    if (!pickerOpen) return;
    window.addEventListener('blur', closePicker);
    return () => window.removeEventListener('blur', closePicker);
  }, [pickerOpen, closePicker]);

  return (
    <div className={styles.page}>
      {pickerOpen ? <ChatSessionPicker sessions={sessions} /> : null}
      <div className={styles.frames}>
        <PhoneFrames sessions={sessions} />
      </div>
    </div>
  );
}
