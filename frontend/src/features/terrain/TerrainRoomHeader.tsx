import { useCallback, useState, type ReactNode } from 'react';
import { TerrainRoomsIndex } from './TerrainRoomsIndex';
import styles from './TerrainRoomHeader.module.css';

/**
 * TerrainRoomHeader — the one top bar every Terrain room wears: the room's
 * name and a line under it on the left, the room's own controls and the
 * "← Rooms" button on the right.
 *
 * Terrain is one feature: Files (the heatmap at /terrain/files), the Map, and
 * every room under /terrain. Each is a full page, so each needs the same way
 * in and the same way out. The way in is the hallway
 * (TerrainRoomsIndex.tsx), and this bar's "← Rooms" button opens that same
 * hallway over whichever room you're in: the room blurs, the cards rise, and
 * you pick the next door. Files reaches it from its own toolbar's Rooms
 * button (TerrainPage.tsx) instead of this bar, because the map's chrome
 * floats over the map.
 *
 * The hallway's open/closed is this bar's own state, not a route. That's the
 * same rule TerrainPage follows: the browser's back button never has to step
 * through it.
 *
 * A room passes its own controls (mode switches, filters, a link) as
 * children; they sit just before the Rooms button and wrap under the title
 * on a narrow screen.
 *
 * Prompt that produced it: "I want all the doors in terrain to be like, all
 * one feature."
 */
export function TerrainRoomHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  const [roomsOpen, setRoomsOpen] = useState(false);
  const closeRooms = useCallback(() => setRoomsOpen(false), []);
  return (
    <>
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>{title}</h2>
          {sub ? <p className={styles.sub}>{sub}</p> : null}
        </div>
        <div className={styles.actions}>
          {children}
          <button
            type="button"
            className={styles.rooms}
            aria-label="Back to the Terrain rooms"
            aria-expanded={roomsOpen}
            onClick={() => setRoomsOpen((open) => !open)}
          >
            ← Rooms
          </button>
        </div>
      </header>
      <TerrainRoomsIndex open={roomsOpen} onClose={closeRooms} />
    </>
  );
}
