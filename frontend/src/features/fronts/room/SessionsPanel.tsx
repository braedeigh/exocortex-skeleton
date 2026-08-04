/**
 * SessionsPanel.tsx — the conversations living on this front, and the button
 * that starts a new one here.
 *
 * This is the only panel in a room whose contents are UNFINISHED. Every other
 * panel lists stable items; a conversation is a sentence stopped halfway. So
 * the rows lead with where she left off rather than just a title — "pick up
 * where you left off" needs the *where*, or it's a list of names you have to
 * open three of to find the one you meant.
 *
 * Starting a session here does two separable things (routes/observatory.py
 * observatory_conv_create): TAGS it to the front, so it comes back to this
 * panel, and SEEDS it with the front's brief, so it opens already knowing
 * which part of her life it's in.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { sessionLocation } from '../../observatory/sessionLocation';
import { useFrontBrief, useFrontSessions, useStartFrontSession, type FrontSession } from './useFrontSessions';
import styles from './SessionsPanel.module.css';

function ago(stamp: string): string {
  if (!stamp) return '';
  const then = Date.parse(stamp.replace(' ', 'T'));
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function SessionRow({ session, onOpen }: { session: FrontSession; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={styles.row} onClick={() => onOpen(session.id)}>
        <span className={styles.rowHead}>
          <span className={styles.rowTitle}>{session.title}</span>
          {session.running && <span className={styles.live}>live</span>}
          <span className={styles.when}>{ago(session.last_at)}</span>
        </span>
        {session.gist && <span className={styles.gist}>{session.gist}</span>}
        {/* A guess must never pass itself off as a filing she made. */}
        {session.source === 'inferred' && <span className={styles.inferred}>sorted here automatically</span>}
      </button>
    </li>
  );
}

export function SessionsPanel({ frontId, frontName }: { frontId: string; frontName: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useFrontSessions(frontId);
  const start = useStartFrontSession(frontId);
  const [showBrief, setShowBrief] = useState(false);
  const brief = useFrontBrief(frontId, showBrief);

  function open(id: string) {
    // sessionLocation is the one place that knows the observatory URL shape —
    // spelling it by hand here once put the id in a dead URL segment and
    // opened a blank compose instead of the session.
    void navigate(sessionLocation(id));
  }

  const sessions = data?.sessions ?? [];

  return (
    <div className={styles.wrap}>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.start}
          disabled={start.isPending}
          onClick={() =>
            start.mutate(
              { title: `${frontName} session` },
              { onSuccess: (res) => open(res.id) },
            )
          }
        >
          {start.isPending ? 'Starting…' : '+ Start a session here'}
        </button>
        <button type="button" className={styles.peek} onClick={() => setShowBrief((v) => !v)}>
          {showBrief ? 'Hide what it opens with' : 'What will it know?'}
        </button>
      </div>

      {start.isError && <p className={styles.error}>Couldn’t start a session.</p>}

      {showBrief && (
        <pre className={styles.brief}>
          {brief.isLoading ? 'Loading…' : brief.data?.brief || 'Nothing to hand it yet.'}
        </pre>
      )}

      {isLoading ? (
        <p className={styles.empty}>Loading…</p>
      ) : sessions.length === 0 ? (
        <p className={styles.empty}>
          No conversations on this front yet. Start one and it stays here.
        </p>
      ) : (
        <ul className={styles.list}>
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onOpen={open} />
          ))}
        </ul>
      )}
    </div>
  );
}
