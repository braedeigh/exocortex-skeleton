/**
 * SwarmClosingFold.tsx — the "swarm closed" line in a room helper's chat,
 * opened into the whole closing summary.
 *
 * What this is, in plain English: when a swarm closes, its helper writes what
 * the swarm did and the room's helper is told in one line (swarm_helper.py
 * `_tell_room`). This is the button under that line. Closed, it is one row;
 * tapped, it fetches that swarm's closing summaries and shows the one this
 * line announced — the summary in plain words, the closing check (what git
 * and the session records show) folded beneath it, and two buttons: to the
 * swarm's helper, where she can ask what happened, and to the swarm's page.
 *
 * Nothing is fetched until she opens it, so a chat with many closed lines
 * costs nothing to load.
 *
 * Prompt that produced it: "one line is fine as long as it is clickable to
 * expand".
 *
 * Touches: replyViews.tsx (draws one under a reply for each swarm the reply
 * says closed), events.ts (reads the `swarm_closed` mark off the line),
 * swarmApi.ts (`useSwarmClosings` → GET /api/swarms/<id>/closings),
 * journal/markdown.ts (the summary's markdown), SwarmClosingFold.module.css.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { mdToHtml } from '../journal/markdown';
import { sessionLocation } from './sessionLocation';
import { closingFor, useSwarmClosings } from './swarmApi';
import styles from './SwarmClosingFold.module.css';

export function SwarmClosingFold({ swarmId, at }: { swarmId: number; at: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const found = useSwarmClosings(swarmId, open);
  const closing = found.data ? closingFor(found.data.closings, at) : null;
  const helper = found.data?.helper_conv ?? null;

  return (
    <div className={styles.fold}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.chevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
        {open ? 'Hide the closing summary' : 'Read the whole closing summary'}
      </button>
      {open ? (
        <div className={styles.body}>
          {found.isLoading ? <p className={styles.muted}>Loading…</p> : null}
          {found.isError ? (
            <p className={styles.error}>
              Couldn&rsquo;t load swarm {swarmId}&rsquo;s closing summary. The swarm may have been merged into
              another or dissolved.
            </p>
          ) : null}
          {found.data && !closing ? (
            <p className={styles.muted}>No closing summary is kept for swarm {swarmId}.</p>
          ) : null}
          {closing ? (
            <>
              {/* mdToHtml escapes the text before it marks it up, so the
                  model's words can't carry markup in. */}
              {closing.summary ? (
                <div className={styles.text} dangerouslySetInnerHTML={{ __html: mdToHtml(closing.summary) }} />
              ) : (
                <p className={styles.error}>
                  No summary was written ({closing.error ?? 'the model call failed'}). The closing check below is
                  what git shows.
                </p>
              )}
              <details className={styles.check}>
                <summary className={styles.checkHead}>The closing check: what git and the session records show</summary>
                <div className={styles.text} dangerouslySetInnerHTML={{ __html: mdToHtml(closing.facts) }} />
              </details>
            </>
          ) : null}
          {found.data ? (
            <div className={styles.doors}>
              {helper ? (
                <button type="button" className={styles.door} onClick={() => void navigate(sessionLocation(helper))}>
                  Ask its helper about it
                </button>
              ) : null}
              <button
                type="button"
                className={styles.door}
                onClick={() => void navigate({ to: '/observatory/swarm/$swarmId', params: { swarmId: String(swarmId) } })}
              >
                Open the swarm&rsquo;s page
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
