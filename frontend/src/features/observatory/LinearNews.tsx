import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getLinearFeed, type LinearEvent, type LinearFeedState } from './api';
import { markLinearNewsSeen, readLinearNewsSeen } from './linearNewsSeen';
import { sessionLocation } from './sessionLocation';
import styles from './LinearBoard.module.css';

/**
 * LinearNews — "New in Linear", at the top of the Linear room's page: what
 * someone other than her did in Linear lately, newest first.
 *
 * Linear can't push to this machine, so the app asks it once a minute and
 * writes down what it finds (linear_feed.py). Her own actions, and her
 * sessions' (they act under her name), are never in the list. Each row says
 * who did what to which issue, shows a comment's words, and is a link out to
 * Linear. Rows she hasn't looked at yet are set apart; looking at the page is
 * what marks them seen, on this device (linearNewsSeen.ts).
 *
 * The same news wakes the Linear helper, a helper session that tells her in
 * its chat and passes it on to the sessions it affects. The button opens that
 * chat once the helper exists.
 *
 * Reads GET /api/linear-room/feed (routes/linear_room.py), which never calls
 * Linear, again every minute while the page is open.
 *
 * Prompt that produced it: "I want to create something that pushes linear
 * stuff to my app. And the helpers notice it and can send out info".
 */

// How many rows show before "Show all".
const SHOWN_AT_FIRST = 5;

export function LinearNews() {
  const navigate = useNavigate();
  const [feed, setFeed] = useState<LinearFeedState | null>(null);
  const [showAll, setShowAll] = useState(false);
  // What she had seen when the page opened. Kept for the whole visit, so the
  // new rows stay marked while she reads them.
  const [seenBefore] = useState(readLinearNewsSeen);

  // Load the news now and once a minute: the same beat the app checks Linear on.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getLinearFeed()
        .then((f) => {
          if (alive) setFeed(f);
        })
        .catch(() => {});
    void load();
    const id = window.setInterval(() => void load(), 60000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Looking at the page marks the news seen: remember the newest one shown.
  const newest = feed?.events[0]?.at;
  useEffect(() => {
    if (newest) markLinearNewsSeen(newest);
  }, [newest]);

  if (!feed || (!feed.on && feed.events.length === 0)) return null;

  const events = showAll ? feed.events : feed.events.slice(0, SHOWN_AT_FIRST);
  const helper = feed.helper;

  return (
    <section className={styles.news}>
      <div className={styles.head}>
        <h2 className={styles.heading}>
          New in Linear <span className={styles.muted}>· from other people</span>
        </h2>
        {helper ? (
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => void navigate(sessionLocation(helper))}
            data-track="observatory-linear-helper"
          >
            Linear helper →
          </button>
        ) : null}
      </div>
      {feed.error ? <div className={styles.error}>The last check of Linear failed: {feed.error}</div> : null}

      {feed.events.length === 0 ? (
        <div className={styles.quiet}>
          Nothing from anyone else yet. The app asks Linear once a minute; your own changes and your sessions' don't
          count.
        </div>
      ) : (
        events.map((event) => <NewsRow key={event.id} event={event} isNew={event.at > seenBefore} />)
      )}

      {feed.events.length > SHOWN_AT_FIRST ? (
        <button type="button" className={styles.smallButton} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${feed.events.length}`}
        </button>
      ) : null}
      {feed.checked_at ? <div className={styles.issueLine}>Last checked {when(feed.checked_at)}.</div> : null}
    </section>
  );
}

/** One thing someone did: who, what, which issue, when — a link out to Linear. */
function NewsRow({ event, isNew }: { event: LinearEvent; isNew: boolean }) {
  return (
    <a
      className={[styles.newsRow, isNew ? styles.newsRowNew : ''].filter(Boolean).join(' ')}
      href={event.url}
      target="_blank"
      rel="noreferrer"
    >
      <span className={styles.newsWhat}>
        <strong>{event.actor}</strong> {event.summary}
        {event.kind === 'comment' ? ' on ' : ': '}
        <span className={styles.ident}>{event.identifier}</span> {event.title}
        {isNew ? <span className={styles.newsTag}>New</span> : null}
      </span>
      {event.body ? <span className={styles.newsBody}>{clip(event.body)}</span> : null}
      <span className={styles.issueLine}>{when(event.at)} · Open in Linear ↗</span>
    </a>
  );
}

/** A long comment, cut for the list; the link shows the rest. */
function clip(text: string) {
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/** "Oct 1, 3:14 PM" — local and short. */
function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
