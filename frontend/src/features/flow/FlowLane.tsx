import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { dispatchIntent } from '../../shell/panels/windowBus';
import { relativeAge } from '../terrain/terrainGraph';
import { FRONT_EMOJI, frontLabel, useFronts } from '../fronts/useFronts';
import { useFlow, type FlowEvent } from './api';
import {
  PLACE_LABEL,
  applyFlowFilters,
  readFlowFilters,
  toggleChip,
  visibleFronts,
  visiblePlaces,
  writeFlowFilters,
  type FlowChip,
  type FlowFilters,
} from './filters';
import styles from './FlowLane.module.css';

/**
 * FlowLane — code as it's being written, one of the terrain's rooms
 * (/terrain/flow, routes/terrain_.flow.tsx).
 *
 * The map answers "where has work happened"; this lane answers "what is being
 * written RIGHT NOW". Every Edit/Write an agent makes arrives as a card —
 * newest on top, each carrying the actual lines it wrote — polling
 * /api/observatory/flow every ~5s while visible. It's built to be a WATCHING
 * surface: parked in a tile under the terrain map on a second monitor, read
 * at a glance, asked for nothing.
 *
 * A chip row above the cards filters by PLACE (which broad kind of file —
 * journal/threads/research/data/docs/code/other, terrain.py's _flow_place)
 * and by FRONT (life-domain tags). Chips within one axis union; the two axes
 * intersect (see filters.ts for the pure logic). This is a watching surface,
 * not the pond, so an inactive filter HIDES cards rather than dimming them —
 * a quiet "N writes hidden by filters" line under the row says what's not
 * shown and offers a clear-all. The selection persists to localStorage
 * ('flow-filters') the same way ThreadsDirectory.tsx persists its sort mode.
 * Filtering only ever shortens the rendered array — it never reorders or
 * remounts a surviving card, so the poll/remount guarantee below still
 * holds for anything still on screen.
 *
 * Tapping a card rides the window bus (shell/panels/windowBus.ts): the file
 * opens in whatever code tile is watching — this window or another monitor's,
 * the same rule as terrain's file taps and the observatory's file lists. With
 * no code tile anywhere it falls back to navigating this page to /code.
 *
 * Cards keyed by the event's stable id, so a poll never remounts (or
 * re-animates) a card she's already seen — only genuinely new writes slide in.
 *
 * Prompt that produced it: "another additional visual where I see what code
 * is being written in real time … the vertical screen will be the terrain UI
 * and code and information flows as it's happening"; and later, "in flow,
 * filter by what kind of file is being written — journal, threads, research,
 * data, docs, code — and by front".
 */

const KIND_LABEL: Record<FlowEvent['kind'], string> = {
  edit: 'edit',
  write: 'wrote',
  create: 'new file',
};

/** Live document visibility — stops the poll (FlowLane is a peripheral
 * surface; a hidden one shouldn't cost anything). Same shape as the map's. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

function FlowCard({ event, onOpen }: { event: FlowEvent; onOpen: (e: FlowEvent) => void }) {
  const age = relativeAge(event.epoch);
  const shown = event.snippet ? event.snippet.split('\n').length : 0;
  const more = event.snippet_total_lines - shown;
  // The CSS caps a snippet at ~12 visible lines; past that (or past the
  // server's own trim) the card is showing an excerpt and should say so.
  const clipped = more > 0 || shown > 12;
  const fileName = event.path.split('/').pop() ?? event.path;
  return (
    <li className={styles.card}>
      <button type="button" className={styles.cardBody} onClick={() => onOpen(event)}>
        <span className={styles.cardHead}>
          <span className={[styles.chip, styles[`chip_${event.kind}`]].join(' ')}>
            {KIND_LABEL[event.kind]}
          </span>
          <span className={styles.file}>{fileName}</span>
          {/* The writing hand: dot pulses while its session's turn is live. */}
          <span className={styles.agent}>
            {event.running ? <span className={styles.liveDot} aria-label="writing now" /> : null}
            {event.title}
          </span>
          <span className={styles.age}>{age === 'now' ? 'just now' : `${age} ago`}</span>
        </span>
        <span className={styles.path}>
          {event.repo}/{event.path}
        </span>
        {event.snippet ? (
          <span className={styles.snippetWrap}>
            <pre
              className={[styles.snippet, clipped ? styles.snippetClipped : '']
                .filter(Boolean)
                .join(' ')}
            >
              {event.snippet}
            </pre>
            {more > 0 ? (
              <span className={styles.more}>
                +{more} more {more === 1 ? 'line' : 'lines'}
              </span>
            ) : null}
          </span>
        ) : (
          // A secret-named file's write still shows — its contents don't.
          <span className={styles.withheld}>contents not shown</span>
        )}
      </button>
    </li>
  );
}

function FilterChip({
  chip,
  label,
  active,
  onToggle,
}: {
  chip: FlowChip;
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={[styles.filterChip, active ? styles.filterChipActive : ''].join(' ')}
      aria-pressed={active}
      onClick={onToggle}
    >
      {label}
      <span className={styles.filterChipCount}>{chip.count}</span>
    </button>
  );
}

function FlowFilterRow({
  events,
  filters,
  onTogglePlace,
  onToggleFront,
}: {
  events: FlowEvent[];
  filters: FlowFilters;
  onTogglePlace: (place: string) => void;
  onToggleFront: (front: string) => void;
}) {
  const { data: fronts } = useFronts();
  const placeChips = useMemo(() => visiblePlaces(events, filters.places), [events, filters.places]);
  const frontChips = useMemo(() => visibleFronts(events, filters.fronts), [events, filters.fronts]);
  if (placeChips.length === 0 && frontChips.length === 0) return null;

  return (
    <div className={styles.filterRow} role="group" aria-label="Filter the flow">
      {placeChips.length > 0 ? (
        <div className={styles.filterGroup}>
          {placeChips.map((chip) => (
            <FilterChip
              key={chip.id}
              chip={chip}
              label={PLACE_LABEL[chip.id as keyof typeof PLACE_LABEL] ?? chip.id}
              active={filters.places.includes(chip.id)}
              onToggle={() => onTogglePlace(chip.id)}
            />
          ))}
        </div>
      ) : null}
      {placeChips.length > 0 && frontChips.length > 0 ? <span className={styles.filterDivider} /> : null}
      {frontChips.length > 0 ? (
        <div className={styles.filterGroup}>
          {frontChips.map((chip) => (
            <FilterChip
              key={chip.id}
              chip={chip}
              label={fronts ? frontLabel(fronts, chip.id) : `${FRONT_EMOJI[chip.id] || '🏷️'} ${chip.id}`}
              active={filters.fronts.includes(chip.id)}
              onToggle={() => onToggleFront(chip.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FlowLane() {
  const visible = usePageVisible();
  const { data, isError } = useFlow(visible);
  const navigate = useNavigate();
  const [filters, setFilters] = useState<FlowFilters>(() => readFlowFilters());

  useEffect(() => {
    writeFlowFilters(filters);
  }, [filters]);

  // Same open rule as everywhere else code opens: a watching code tile —
  // this window or another monitor's — catches it; nobody watching, navigate.
  const openEvent = (e: FlowEvent) => {
    if (dispatchIntent({ kind: 'code', repo: e.repo, path: e.path }) !== 'none') return;
    void navigate({ to: '/code', search: { repo: e.repo, path: e.path } });
  };

  const events = data?.events ?? [];
  const filtered = useMemo(() => applyFlowFilters(events, filters), [events, filters]);
  const hiddenCount = events.length - filtered.length;
  const filtersActive = filters.places.length > 0 || filters.fronts.length > 0;

  const togglePlace = (place: string) =>
    setFilters((f) => ({ ...f, places: toggleChip(f.places, place) }));
  const toggleFront = (front: string) =>
    setFilters((f) => ({ ...f, fronts: toggleChip(f.fronts, front) }));
  const clearFilters = () => setFilters({ places: [], fronts: [] });

  return (
    <section className={styles.view} aria-label="Code being written">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Flow</h2>
          <p className={styles.sub}>Code as it&rsquo;s being written — newest first.</p>
        </div>
        <Link to="/terrain/files" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      <FlowFilterRow
        events={events}
        filters={filters}
        onTogglePlace={togglePlace}
        onToggleFront={toggleFront}
      />
      {filtersActive && hiddenCount > 0 ? (
        <p className={styles.hiddenNote}>
          {hiddenCount} {hiddenCount === 1 ? 'write' : 'writes'} hidden by filters
          <button type="button" className={styles.clearFilters} onClick={clearFilters}>
            clear all
          </button>
        </p>
      ) : null}

      {isError ? <p className={styles.note}>Couldn&rsquo;t read the flow.</p> : null}
      {data && events.length === 0 ? (
        <p className={styles.note}>
          Nothing flowing right now — the lane fills as agents write.
        </p>
      ) : null}
      {data && events.length > 0 && filtered.length === 0 ? (
        <p className={styles.note}>Nothing matches the current filters.</p>
      ) : null}

      <ol className={styles.list}>
        {filtered.map((e) => (
          <FlowCard key={e.id} event={e} onOpen={openEvent} />
        ))}
      </ol>
    </section>
  );
}
