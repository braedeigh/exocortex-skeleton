import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { dispatchIntent } from '../../shell/panels/windowBus';
import { relativeAge } from '../terrain/terrainGraph';
import { useFlow, type FlowEvent } from './api';
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
 * and code and information flows as it's happening".
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

export function FlowLane() {
  const visible = usePageVisible();
  const { data, isError } = useFlow(visible);
  const navigate = useNavigate();

  // Same open rule as everywhere else code opens: a watching code tile —
  // this window or another monitor's — catches it; nobody watching, navigate.
  const openEvent = (e: FlowEvent) => {
    if (dispatchIntent({ kind: 'code', repo: e.repo, path: e.path }) !== 'none') return;
    void navigate({ to: '/code', search: { repo: e.repo, path: e.path } });
  };

  const events = data?.events ?? [];

  return (
    <section className={styles.view} aria-label="Code being written">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Flow</h2>
          <p className={styles.sub}>Code as it&rsquo;s being written — newest first.</p>
        </div>
        <Link to="/terrain/map" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      {isError ? <p className={styles.note}>Couldn&rsquo;t read the flow.</p> : null}
      {data && events.length === 0 ? (
        <p className={styles.note}>
          Nothing flowing right now — the lane fills as agents write.
        </p>
      ) : null}

      <ol className={styles.list}>
        {events.map((e) => (
          <FlowCard key={e.id} event={e} onOpen={openEvent} />
        ))}
      </ol>
    </section>
  );
}
