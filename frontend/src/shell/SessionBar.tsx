import type { SessionState } from './useSessions';
import styles from './SessionBar.module.css';

/**
 * Terminal session tabs — React port of split.html's desktop session bar
 * (renderDesktopTabs, templates/split.html:664-699). One tab per tmux
 * session, click to attach, `+` to create, `×` to close custom (non-default)
 * sessions. Default sessions (chat/dev/other) can't be closed.
 */
export function SessionBar({ sessions }: { sessions: SessionState }) {
  const { sessions: list, active, setActive, addSession, removeSession, isCustom } = sessions;

  const onAdd = () => {
    const name = window.prompt('Session name:');
    if (!name) return;
    addSession(name).catch((e) => window.alert(e.message));
  };

  const onClose = (name: string) => {
    if (!window.confirm(`Close "${name}" session? This kills the tmux session.`)) return;
    removeSession(name).catch((e) => window.alert(e.message));
  };

  return (
    <div className={styles.bar} role="tablist" aria-label="Terminal sessions">
      {list.map((s) => (
        <div key={s} className={[styles.tab, s === active ? styles.active : ''].filter(Boolean).join(' ')}>
          <button
            type="button"
            role="tab"
            aria-selected={s === active}
            className={styles.tabLabel}
            onClick={() => setActive(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
          {isCustom(s) && (
            <button
              type="button"
              className={styles.closeX}
              aria-label={`Close ${s} session`}
              title="Close session"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button type="button" className={styles.addBtn} title="New session" aria-label="New session" onClick={onAdd}>
        +
      </button>
    </div>
  );
}
