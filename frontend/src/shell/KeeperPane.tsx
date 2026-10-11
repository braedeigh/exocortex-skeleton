import { ObservatoryPage } from '../features/observatory/ObservatoryPage';
import { RosterPage } from '../features/observatory/RosterPage';
import { useSessionMountKey } from '../features/observatory/sessionMountKey';
import styles from './KeeperPane.module.css';

/**
 * The observatory docked in the desktop split's left pane — the desktop half
 * of what the mobile Chat tab does when Settings points it at the reading
 * room (chatSurface.ts). The WHOLE room, not just the Keeper: `roster` picks
 * between the Sessions list and the open conversation, so every session she
 * has is reachable from the left pane without giving up the right one.
 *
 * This component doesn't decide where the pane is — it renders where the pane
 * IS. Both `roster` and `conv` arrive as props from the location stack in
 * paneHistory.ts, and every way in here (a roster card, a session the room
 * itself opens on a first send or a rollover) reports back out through the one
 * `onOpenConversation`. That's why opening from the roster and opening from
 * inside the room are the same call now: the location carries both facts, so
 * "show this conversation" always means the same thing wherever it came from.
 *
 * Keying the room on the id means each conversation remounts clean — exactly
 * what the routed page gets from its own `key` — except the session a blank
 * compose just created, which the page adopts and keeps streaming into
 * (sessionMountKey.ts).
 *
 * The room stays mounted while she's in the roster (a reply may be streaming
 * into it); the roster is mounted only while shown, since it polls and
 * refreshes on mount anyway.
 */
export function KeeperPane({
  roster,
  conv,
  onOpenConversation,
  onRoomTitle,
}: {
  roster: boolean;
  /** undefined = the opening conversation is still resolving (paneHistory.ts);
   * null = no sessions yet, so compose fresh. */
  conv: string | null | undefined;
  onOpenConversation: (id: string) => void;
  /** Passed straight through to the room so the pane switcher's tab can wear
   * the open session's title (see SplitLayout). */
  onRoomTitle?: (title: string | null) => void;
}) {
  const mount = useSessionMountKey(conv ?? undefined);
  return (
    <>
      <div className={roster ? styles.hidden : styles.slot}>
        {conv === undefined ? (
          <div className={styles.loading} />
        ) : (
          <ObservatoryPage
            key={mount.key}
            botId="keeper"
            convId={conv ?? undefined}
            onOpenConversation={onOpenConversation}
            onSessionCreated={mount.adopt}
            onTitleChange={onRoomTitle}
          />
        )}
      </div>
      {roster ? (
        <div className={`${styles.slot} ${styles.rosterSlot}`}>
          <RosterPage onOpenConversation={onOpenConversation} />
        </div>
      ) : null}
    </>
  );
}
