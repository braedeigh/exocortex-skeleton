import { useEffect, useState, type ReactElement } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { getCollections } from './sqlab/api';
import { compact, monthLabel, type GrowthData } from './growthMath';
import { formatDwell, rankPlaces, type UsageRecord } from './usageRanking';
import styles from './TerrainRoomsIndex.module.css';

/**
 * TerrainRoomsIndex — the hallway of the terrain, and the one list of every
 * room in it. Terrain is one feature: Files (the heatmap), the Map, and every
 * page under /terrain. Tap the Rooms door — on Files' toolbar, or the
 * "← Rooms" button every other room's top bar carries (TerrainRoomHeader.tsx)
 * — and the page blurs under you while opaque cards rise, one per room, each
 * wearing a small drawing of what's inside. Tap a card and you GO there:
 * every room is a full page of its own, so choosing one is a real departure,
 * not a panel opening. The card for the room you're already in is marked
 * "you're here".
 *
 * It's a moment, not a place: open/closed is local state on whichever page
 * opened it, never a route, so the browser's back button doesn't have to
 * wade through it. The blur is doing honest work — the page saying "I'm
 * still here, you're choosing where to go" — and the cards are fully opaque
 * against it because they're the subject now.
 *
 * Adding a room = one entry in ROOMS (name, line, address, motif). A room
 * that isn't in ROOMS can only be reached by a link from somewhere else,
 * which is how Wiring, Runs and Activity went missing before 2026-10-02. The motifs
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

/** A slash with its bars — the skills room: commands ranked, one gone cold. */
function SkillsMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <path
        d="M14 36 L24 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        opacity="0.9"
      />
      <g fill="currentColor">
        <rect x="30" y="5" width="30" height="6" rx="3" opacity="0.9" />
        <rect x="30" y="17" width="18" height="6" rx="3" opacity="0.5" />
        <rect x="30" y="29" width="7" height="6" rx="3" opacity="0.22" />
      </g>
    </svg>
  );
}

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

/** A rising curve with its end-dot — the growth room's charts, in miniature. */
function GrowthMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 36 L18 31 L34 23 L50 13 L60 7" strokeWidth="3" opacity="0.9" />
        <path d="M2 37 L22 35 L42 31 L60 27" strokeWidth="3" opacity="0.4" />
      </g>
      <circle cx="60" cy="7" r="4" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

/** Code lines mid-arrival — the newest brightest, a caret still writing. */
function FlowMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="2" width="38" height="5" rx="2.5" opacity="0.9" />
        <rect x="41" y="2" width="6" height="5" rx="1" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.15;0.9" dur="1.6s" repeatCount="indefinite" />
        </rect>
        <rect x="0" y="13" width="52" height="5" rx="2.5" opacity="0.55" />
        <rect x="0" y="24" width="26" height="5" rx="2.5" opacity="0.35" />
        <rect x="0" y="35" width="44" height="5" rx="2.5" opacity="0.2" />
      </g>
    </svg>
  );
}

/** One big pane and a stack of small ones — the desk's own layout, with the
 * hero's newest-edit line lit. */
function WorkshopMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="1" y="1" width="36" height="38" rx="3" opacity="0.9" />
        <rect x="43" y="1" width="20" height="10" rx="2" opacity="0.55" />
        <rect x="43" y="15" width="20" height="10" rx="2" opacity="0.35" />
        <rect x="43" y="29" width="20" height="10" rx="2" opacity="0.2" />
      </g>
      <g fill="currentColor">
        <rect x="6" y="8" width="22" height="3" rx="1.5" opacity="0.4" />
        <rect x="6" y="15" width="26" height="3" rx="1.5" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.8s" repeatCount="indefinite" />
        </rect>
        <rect x="6" y="22" width="18" height="3" rx="1.5" opacity="0.4" />
        <rect x="6" y="29" width="24" height="3" rx="1.5" opacity="0.4" />
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

/** Two banks with ribbons of flow between them — the creek's own drawing:
 * code files on the left, collections on the right, write-weighted current. */
function CreekMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="4" width="14" height="5" rx="2" opacity="0.9" />
        <rect x="0" y="17" width="14" height="5" rx="2" opacity="0.55" />
        <rect x="0" y="30" width="14" height="5" rx="2" opacity="0.35" />
        <rect x="50" y="8" width="14" height="5" rx="2" opacity="0.9" />
        <rect x="50" y="26" width="14" height="5" rx="2" opacity="0.45" />
      </g>
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M16 6 C 33 6, 33 10, 48 10" strokeWidth="3" opacity="0.7" />
        <path d="M16 19 C 33 19, 33 11, 48 11" strokeWidth="2" opacity="0.45" />
        <path d="M16 32 C 33 32, 33 28, 48 28" strokeWidth="1.5" opacity="0.3" />
      </g>
    </svg>
  );
}

/** Dots at their hours with one thread's line bouncing through them — the
 * pond's own drawing, in miniature. */
function PondMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <polyline
        points="6,26 20,12 34,30 48,16 58,22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
      <g fill="currentColor">
        {[[6, 26], [20, 12], [34, 30], [48, 16], [58, 22]].map(([cx, cy]) => (
          <circle key={`${cx}`} cx={cx} cy={cy} r="3" />
        ))}
        <g opacity="0.3">
          {[[13, 33], [27, 20], [41, 8], [41, 24], [55, 33]].map(([cx, cy]) => (
            <circle key={`q${cx}-${cy}`} cx={cx} cy={cy} r="2" />
          ))}
        </g>
      </g>
    </svg>
  );
}

/** A few small maps side by side — the builds room: other folders, each
 * its own little terrain. */
function BuildsMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="1" y="3" width="18" height="34" rx="3" opacity="0.9" />
        <rect x="23" y="3" width="18" height="34" rx="3" opacity="0.55" />
        <rect x="45" y="3" width="18" height="34" rx="3" opacity="0.3" />
      </g>
      <g fill="currentColor">
        {[[7, 12], [13, 20], [8, 28]].map(([cx, cy]) => (
          <circle key={`a${cy}`} cx={cx} cy={cy} r="2.5" opacity="0.9" />
        ))}
        {[[29, 14], [35, 26]].map(([cx, cy]) => (
          <circle key={`b${cy}`} cx={cx} cy={cy} r="2.5" opacity="0.55" />
        ))}
        <circle cx="54" cy="20" r="2.5" opacity="0.3" />
      </g>
    </svg>
  );
}

/** Dots in a loose tree, the newest one lit — Files, the heatmap itself. */
function FilesMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35">
        <path d="M32 20 L14 10 M32 20 L16 32 M32 20 L50 9 M32 20 L52 30 M50 9 L60 16" />
      </g>
      <g fill="currentColor">
        <circle cx="32" cy="20" r="3.5" opacity="0.55" />
        <circle cx="14" cy="10" r="3" opacity="0.3" />
        <circle cx="16" cy="32" r="3" opacity="0.3" />
        <circle cx="52" cy="30" r="3" opacity="0.55" />
        <circle cx="60" cy="16" r="2.5" opacity="0.3" />
        <circle cx="50" cy="9" r="4.5" opacity="0.95">
          <animate attributeName="opacity" values="0.95;0.4;0.95" dur="2.4s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

/** Ribbons in on the left, one file in the middle, ribbons out on the right
 * — the wiring room's own drawing. */
function WiringMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="5" width="10" height="5" rx="2" opacity="0.45" />
        <rect x="0" y="30" width="10" height="5" rx="2" opacity="0.45" />
        <rect x="24" y="13" width="16" height="14" rx="3" opacity="0.9" />
        <rect x="54" y="4" width="10" height="5" rx="2" opacity="0.45" />
        <rect x="54" y="18" width="10" height="5" rx="2" opacity="0.45" />
        <rect x="54" y="31" width="10" height="5" rx="2" opacity="0.45" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.6">
        <path d="M11 7 C 18 7, 18 18, 23 18" />
        <path d="M11 32 C 18 32, 18 22, 23 22" />
        <path d="M41 18 C 47 18, 47 6, 53 6" />
        <path d="M41 20 L53 20" />
        <path d="M41 22 C 47 22, 47 33, 53 33" />
      </g>
    </svg>
  );
}

/** Fire, write, read later: a runner, a mailbox, and the reader downstream. */
function RunsMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="7" cy="20" r="6" opacity="0.9" />
        <rect x="26" y="13" width="14" height="14" rx="2" opacity="0.55" />
        <circle cx="57" cy="20" r="6" opacity="0.3" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14 20 L24 20" opacity="0.8" />
        <path d="M42 20 L50 20" strokeDasharray="2 4" opacity="0.5" />
      </g>
    </svg>
  );
}

/** A column of steps, each with its mark — one ticked, one failed, one still
 * running — the activity log in miniature. */
function ActivityMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="4" cy="6" r="3" opacity="0.9" />
        <rect x="12" y="3.5" width="40" height="5" rx="2.5" opacity="0.55" />
        <circle cx="4" cy="20" r="3" opacity="0.9" />
        <rect x="12" y="17.5" width="28" height="5" rx="2.5" opacity="0.55" />
        <circle cx="4" cy="34" r="3" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.4s" repeatCount="indefinite" />
        </circle>
        <rect x="12" y="31.5" width="48" height="5" rx="2.5" opacity="0.3" />
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
    key: 'files',
    to: '/terrain/files',
    name: 'Files',
    line: 'Every file in both repos, glowing where the work has been.',
    motif: FilesMotif,
  },
  {
    key: 'usage',
    to: '/terrain/usage',
    name: 'Attention',
    line: 'The same system, ranked by where your time actually goes.',
    motif: AttentionMotif,
  },
  {
    key: 'commands',
    to: '/terrain/commands',
    name: 'Skills',
    line: 'Every / command you’ve run — and the ones you haven’t.',
    motif: SkillsMotif,
  },
  {
    key: 'pond',
    to: '/terrain/pond',
    name: 'Pond',
    line: 'The journal by day and hour, with your threads running through it.',
    motif: PondMotif,
  },
  {
    key: 'flow',
    to: '/terrain/flow',
    name: 'Flow',
    line: 'Code as it’s being written, agent by agent, as it lands.',
    motif: FlowMotif,
  },
  {
    key: 'workshop',
    to: '/terrain/workshop',
    name: 'Workshop',
    line: 'An agent’s desk — every file it’s writing, open at once.',
    motif: WorkshopMotif,
  },
  {
    key: 'activity',
    to: '/terrain/activity',
    name: 'Activity',
    line: 'One session’s every tool call, with its output, live.',
    motif: ActivityMotif,
  },
  {
    key: 'growth',
    to: '/terrain/growth',
    name: 'Growth',
    line: 'The codebase and the vault along time, accumulating.',
    motif: GrowthMotif,
  },
  {
    key: 'builds',
    to: '/terrain/builds',
    name: 'Builds',
    line: 'Other folders and GitHub repos, each as its own map and report.',
    motif: BuildsMotif,
  },
  {
    key: 'creek',
    to: '/terrain/creek',
    name: 'Creek',
    line: 'Which code writes which data — every call clickable to its line.',
    motif: CreekMotif,
  },
  {
    key: 'wiring',
    to: '/terrain/wiring',
    name: 'Wiring',
    line: 'Which files can reach which — the import graph, one file at a time.',
    motif: WiringMotif,
  },
  {
    key: 'runs',
    to: '/terrain/runs',
    name: 'Runs',
    line: 'What fires, what it writes, and who reads that later.',
    motif: RunsMotif,
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
  // Which room this hallway was opened from, so its card can say so.
  const pathname = useRouterState({ select: (state) => state.location.pathname });

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
    fetch('/api/usage/commands', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { commands: { name: string }[]; cold: string[] }) => {
        if (!alive || !data.commands?.length) return;
        // The door names the top skill and how much of the set is live —
        // "13 of 18" is the fact the room exists to deliver.
        const total = data.commands.length + (data.cold?.length ?? 0);
        setFacts((f) => ({
          ...f,
          commands: `${data.commands.length} of ${total} used · /${data.commands[0].name} leads`,
        }));
      })
      .catch(() => {});
    fetch('/api/observatory/terrain/growth', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((growth: GrowthData) => {
        if (!alive) return;
        const days = growth.repos.flatMap((repo) => repo.days);
        const commits = days.reduce((sum, d) => sum + d.commits, 0);
        const first = days.map((d) => d.date).sort()[0];
        if (commits > 0 && first) {
          setFacts((f) => ({
            ...f,
            growth: `${compact(commits)} commits since ${monthLabel(first.slice(0, 7))}`,
          }));
        }
      })
      .catch(() => {});
    fetch('/api/observatory/terrain/builds', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { builds: { name: string }[] }) => {
        if (!alive || !data.builds?.length) return;
        const count = data.builds.length;
        setFacts((f) => ({
          ...f,
          builds: count === 1 ? data.builds[0].name : `${count} builds`,
        }));
      })
      .catch(() => {});
    fetch('/api/observatory/flow', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((flow: { events: { conv: string }[] }) => {
        if (!alive || !flow.events?.length) return;
        const agents = new Set(flow.events.map((e) => e.conv)).size;
        setFacts((f) => ({
          ...f,
          flow: `${flow.events.length} recent ${flow.events.length === 1 ? 'write' : 'writes'} · ${agents} ${
            agents === 1 ? 'agent' : 'agents'
          }`,
        }));
      })
      .catch(() => {});
    fetch('/api/pond/threads', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { threads: { tag: string; days: number }[] }) => {
        if (!alive || !data.threads?.length) return;
        // The widest thread, by days touched — the door states the shape
        // that's actually behind it right now.
        const widest = data.threads[0];
        setFacts((f) => ({
          ...f,
          pond: `${data.threads.length} threads · ${widest.tag} spans ${widest.days} days`,
        }));
      })
      .catch(() => {});
    fetch('/api/creek?days=14', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((creek: { files: unknown[]; collections: unknown[] }) => {
        if (!alive || !creek.files?.length) return;
        setFacts((f) => ({
          ...f,
          creek: `${creek.files.length} files feed ${creek.collections.length} collections`,
        }));
      })
      .catch(() => {});
    fetch('/api/observatory/terrain/graph', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((graph: { counts?: { files: number; edges: number } }) => {
        if (!alive || !graph.counts?.files) return;
        setFacts((f) => ({
          ...f,
          wiring: `${compact(graph.counts!.files)} files · ${compact(graph.counts!.edges)} edges`,
        }));
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
          const here = pathname === room.to;
          return (
            <Link
              key={room.key}
              to={room.to}
              className={here ? `${styles.card} ${styles.cardHere}` : styles.card}
              style={{ '--card-index': i } as React.CSSProperties}
              aria-current={here ? 'page' : undefined}
              // Tapping the room you're already in just steps back into it.
              onClick={here ? onClose : undefined}
            >
              <span className={styles.motif}>
                <Motif />
              </span>
              <span className={styles.name}>
                {room.name}
                {here ? <span className={styles.here}>you&rsquo;re here</span> : null}
              </span>
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
