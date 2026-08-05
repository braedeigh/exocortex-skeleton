import { useEffect, useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { getCollections } from '../sqlab/api';
import { formatDwell, rankPlaces, type UsageRecord } from './usageRanking';
import styles from './TerrainRoomsIndex.module.css';

/**
 * TerrainRoomsIndex — the hallway of the terrain: tap the Rooms door on the
 * map and the map blurs under you while a few opaque cards rise, one per room,
 * each wearing a small drawing of what's inside. Tap a card and you GO there —
 * every room is a full page of its own (/terrain/usage, /terrain/sql), so
 * choosing one is a real departure, not a panel opening.
 *
 * It's a moment, not a place: open/closed is local state on TerrainPage, never
 * a route, so the browser's back button doesn't have to wade through it. The
 * blur is doing honest work — the map saying "I'm still here, you're choosing
 * where to go" — and the cards are fully opaque against it because they're the
 * subject now.
 *
 * Adding a room = one entry in ROOMS (name, line, address, motif). The motifs
 * are tiny inline SVGs in each room's own visual language, drawn in the
 * theme's current ink so they ride the sky palette like everything else.
 *
 * Each card also carries one LIVE fact — "16 places · 4h this week", "12
 * tables · 9 collections" — fetched when the hallway opens, because a door
 * that states what's behind it right now describes the room better than any
 * static line. Facts that fail to load simply don't appear; the hallway never
 * blocks on them.
 *
 * Prompt that produced it: "I'm imagining like a blurred background with the
 * current terrain map and a few opaque cards with some visuals on them
 * describing what's inside each one. I'll be building more features out too."
 */

/** Ranked bars — the attention room's own chart, in miniature. */
function AttentionMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="4" width="52" height="6" rx="3" opacity="0.9" />
        <rect x="0" y="17" width="34" height="6" rx="3" opacity="0.55" />
        <rect x="0" y="30" width="20" height="6" rx="3" opacity="0.3" />
      </g>
    </svg>
  );
}

/** A table of cells — rows and columns, the database's shape. */
function DataMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="0" width="64" height="8" rx="2" opacity="0.9" />
        {[13, 24, 35].map((y) => (
          <g key={y} opacity={0.4}>
            <rect x="0" y={y} width="18" height="6" rx="2" />
            <rect x="23" y={y} width="18" height="6" rx="2" />
            <rect x="46" y={y} width="18" height="6" rx="2" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const ROOMS: ReadonlyArray<{
  key: string;
  to: string;
  name: string;
  line: string;
  motif: () => ReactElement;
}> = [
  {
    key: 'usage',
    to: '/terrain/usage',
    name: 'Attention',
    line: 'The same system, ranked by where your time actually goes.',
    motif: AttentionMotif,
  },
  {
    key: 'sql',
    to: '/terrain/sql',
    name: 'Data',
    line: 'The database — its shape, and a way to ask it things.',
    motif: DataMotif,
  },
];

export function TerrainRoomsIndex({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // The live fact under each card, keyed by room. Fetched fresh every time the
  // hallway opens (both payloads are small), but never cleared — so reopening
  // shows the last-known numbers instantly and quietly updates them.
  const [facts, setFacts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/usage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((record: UsageRecord) => {
        if (!alive) return;
        const places = rankPlaces(record, 7);
        const total = places.reduce((sum, p) => sum + p.seconds, 0);
        if (places.length > 0) {
          setFacts((f) => ({
            ...f,
            usage: `${places.length} places · ${formatDwell(total)} this week`,
          }));
        }
      })
      .catch(() => {});
    getCollections()
      .then(({ blobs, typed }) => {
        if (!alive) return;
        setFacts((f) => ({
          ...f,
          sql: `${typed.length} ${typed.length === 1 ? 'table' : 'tables'} · ${blobs.length} ${
            blobs.length === 1 ? 'collection' : 'collections'
          }`,
        }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  return (
    // Tapping the blur — anywhere that isn't a card — steps back to the map.
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <nav className={styles.cards} aria-label="Rooms" onClick={(e) => e.stopPropagation()}>
        {ROOMS.map((room, i) => {
          const Motif = room.motif;
          return (
            <Link
              key={room.key}
              to={room.to}
              className={styles.card}
              style={{ '--card-index': i } as React.CSSProperties}
            >
              <span className={styles.motif}>
                <Motif />
              </span>
              <span className={styles.name}>{room.name}</span>
              <span className={styles.line}>{room.line}</span>
              {/* Reserved height even while empty, so a fact arriving never
                  makes the card jump under her finger. */}
              <span className={styles.fact}>{facts[room.key] ?? ''}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
