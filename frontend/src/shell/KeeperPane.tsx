import { useCallback, useEffect, useState } from 'react';
import { ObservatoryPage } from '../features/observatory/ObservatoryPage';
import { RosterPage } from '../features/observatory/RosterPage';
import { getSessions } from '../features/observatory/api';
import styles from './KeeperPane.module.css';

/**
 * The observatory docked in the desktop split's left pane — the desktop half
 * of what the mobile Chat tab does when Settings points it at the reading
 * room (chatSurface.ts). The WHOLE room, not just the Keeper: `roster` picks
 * between the Sessions list and the open conversation, driven by the pane
 * switcher in SplitLayout, so every session she has is reachable from the
 * left pane without giving up the right one.
 *
 * Which conversation it opens on: the same rule as the Chat tab's
 * `?conv=latest` (see observatory_.$botId.tsx's LatestConvResolver) — the
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
 *
 * `pushedConv` is the fourth way in: a page in the right half of the split
 * naming a conversation for this pane (the terrain map's agents — see
 * paneConversation.ts). It arrives as a prop rather than being read here so
 * SplitLayout can flip to the room and the middle tab in the same beat, and
 * so it still lands if the pane hadn't been mounted yet when it was pushed.
 */
export function KeeperPane({
  roster,
  onOpenRoom,
  onRoomTitle,
  pushedConv,
}: {
  roster: boolean;
  onOpenRoom: () => void;
  /** Passed straight through to the room so the pane switcher's tab can wear
   * the open session's title (see SplitLayout). */
  onRoomTitle?: (title: string | null) => void;
  /** A conversation named from outside the pane; null when nothing's been
   * pushed and the default resolution below should stand. */
  pushedConv?: string | null;
}) {
  // undefined = still resolving; null = resolved to "no sessions, start fresh".
  const [conv, setConv] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getSessions()
      .then(({ sessions }) => {
        if (cancelled) return;
        // Only ever FILLS IN a default — if something already chose a
        // conversation while this was in flight, that choice wins.
        setConv((cur) =>
          cur === undefined ? (sessions.find((s) => s.pinned)?.id ?? sessions[0]?.id ?? null) : cur,
        );
      })
      .catch(() => {
        // Roster unreachable — a fresh compose still works, and its first
        // send creates the session.
        if (!cancelled) setConv((cur) => (cur === undefined ? null : cur));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A push from the right half wins over whatever's open, including on this
  // pane's very first mount (the flag flip that reveals it and the push land
  // together, so the effect runs with the id already in hand).
  useEffect(() => {
    if (pushedConv) setConv(pushedConv);
  }, [pushedConv]);

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
          <ObservatoryPage
            key={conv ?? 'new'}
            botId="keeper"
            convId={conv ?? undefined}
            onOpenConversation={openConversation}
            onTitleChange={onRoomTitle}
          />
        )}
      </div>
      {roster ? (
        <div className={`${styles.slot} ${styles.rosterSlot}`}>
          <RosterPage onOpenConversation={openFromRoster} />
        </div>
      ) : null}
    </>
  );
}
