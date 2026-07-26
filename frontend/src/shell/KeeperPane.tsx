import { useCallback, useEffect, useState } from 'react';
import { ReadingRoomPage } from '../features/readingRoom/ReadingRoomPage';
import { getSessions } from '../features/readingRoom/api';
import styles from './KeeperPane.module.css';

/**
 * The Keeper docked in the desktop split's left pane — the desktop half of
 * what the mobile Chat tab does when Settings points it at the reading room
 * (chatSurface.ts). Same page, same conversation, no phone required.
 *
 * Which conversation: the same rule as the Chat tab's `?conv=latest` (see
 * reading-room_.$botId.tsx's LatestConvResolver) — the pinned Keeper session
 * if there is one, else the newest, else a fresh compose. Resolved here
 * rather than by that route resolver because the pane has no URL of its own
 * to resolve *into*; it holds the id in state and hands it to the page.
 *
 * That state is also where the page's two would-be navigations land
 * (onOpenConversation): the session a blank compose creates on first send,
 * and the fresh Keeper a "Roll over" wakes. Keying the page on the id means
 * a rollover remounts it clean — exactly what the routed page gets from its
 * own `key`.
 */
export function KeeperPane() {
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

  const openConversation = useCallback((id: string) => setConv(id), []);

  if (conv === undefined) return <div className={styles.loading} />;

  return (
    <ReadingRoomPage
      key={conv ?? 'new'}
      botId="keeper"
      convId={conv ?? undefined}
      onOpenConversation={openConversation}
    />
  );
}
