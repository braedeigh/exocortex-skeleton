import { useCallback, useEffect, useState } from 'react';
import { ReadingRoomPage } from '../features/readingRoom/ReadingRoomPage';
import { RosterPage } from '../features/readingRoom/RosterPage';
import { getSessions } from '../features/readingRoom/api';
import styles from './KeeperPane.module.css';

/**
 * The reading room docked in the desktop split's left pane — the desktop half
 * of what the mobile Chat tab does when Settings points it at the reading
 * room (chatSurface.ts). The WHOLE room, not just the Keeper: `roster` picks
 * between the Sessions list and the open conversation, driven by the pane
 * switcher in SplitLayout, so every session she has is reachable from the
 * left pane without giving up the right one.
 *
 * Which conversation it opens on: the same rule as the Chat tab's
 * `?conv=latest` (see reading-room_.$botId.tsx's LatestConvResolver) — the
 * pinned Keeper session if there is one, else the newest, else a fresh
 * compose. Resolved here rather than by that route resolver because the pane
 * has no URL of its own to resolve *into*; it holds the id in state.
 *
 * That state is where every "open this conversation" in the room lands
 * (onOpenConversation): a roster card, the session a blank compose creates on
 * first send, and the fresh Keeper a "Roll over" wakes. Keying the room on
 * the id means each of those remounts it clean — exactly what the routed page
 * gets from its own `key`.
 *
 * The room stays mounted while she's in the roster (a reply may be streaming
 * into it); the roster is mounted only while shown, since it polls and
 * refreshes on mount anyway.
 */
export function KeeperPane({ roster, onOpenRoom }: { roster: boolean; onOpenRoom: () => void }) {
  // undefined = still resolving; null = resolved to "no sessions, start fresh".
  const [conv, setConv] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then(({ sessions }) => {
        if (cancelled) return;
        setConv(sessions.find((s) => s.pinned)?.id ?? sessions[0]?.id ?? null);
      })
      .catch(() => {
        // Roster unreachable — a fresh compose still works, and its first
        // send creates the session.
        if (!cancelled) setConv(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // From the room itself (created session, rollover): swap the conversation,
  // stay where she is. From a roster card: swap it AND come back to the room.
  const openConversation = useCallback((id: string) => setConv(id), []);
  const openFromRoster = useCallback(
    (id: string) => {
      setConv(id);
      onOpenRoom();
    },
    [onOpenRoom],
  );

  return (
    <>
      <div className={roster ? styles.hidden : styles.slot}>
        {conv === undefined ? (
          <div className={styles.loading} />
        ) : (
          <ReadingRoomPage
            key={conv ?? 'new'}
            botId="keeper"
            convId={conv ?? undefined}
            onOpenConversation={openConversation}
          />
        )}
      </div>
      {roster ? (
        <div className={styles.slot}>
          <RosterPage onOpenConversation={openFromRoster} />
        </div>
      ) : null}
    </>
  );
}
