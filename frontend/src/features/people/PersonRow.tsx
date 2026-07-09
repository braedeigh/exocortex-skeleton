import type { KeyboardEvent, MouseEvent } from 'react';
import { Sparkline } from './Sparkline';
import { daysSince, lastDateOf, monthDay, relLabel, statsLine } from './rosterLogic';
import type { RosterPerson } from './types';
import styles from './PersonRow.module.css';

export interface PersonRowProps {
  person: RosterPerson;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * One roster row (port of people.js renderRow/renderExpanded): name +
 * relative last-seen label + one-line blurb; tapping anywhere toggles the
 * expanded detail (stats line, sparkline, tags, latest note, link to the
 * Flask person page — the link stops propagation so it doesn't collapse
 * the row first).
 */
export function PersonRow({ person, now, expanded, onToggle }: PersonRowProps) {
  const last = lastDateOf(person);
  const lastLabel = last ? relLabel(daysSince(last, now)) : '';
  const stats = statsLine(person);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  }

  return (
    <div className={styles.row} role="button" tabIndex={0} onClick={onToggle} onKeyDown={onKeyDown}>
      <div className={styles.line1}>
        <span className={styles.name}>{person.name}</span>
        <span className={styles.lastSeen}>{lastLabel}</span>
      </div>
      <div className={styles.blurb}>{person.blurb || ''}</div>
      {expanded ? (
        <div className={styles.expanded}>
          {stats ? <div className={styles.stats}>{stats}</div> : null}
          {person.dates.length ? <Sparkline dates={person.dates} now={now} className={styles.spark} /> : null}
          {person.tags && person.tags.length ? (
            <div>
              {person.tags.map((t) => (
                <span key={t} className={styles.tag}>
                  #{t}
                </span>
              ))}
            </div>
          ) : null}
          {person.last_note ? (
            <div className={styles.note}>
              {monthDay(person.last_note.date)} — {person.last_note.note}
            </div>
          ) : null}
          {/* Plain <a>: the person page is still Flask-served (person.html) — full navigation, not a router link. */}
          <a
            className={styles.openLink}
            href={`/person/${encodeURIComponent(person.id)}`}
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            Open person page &rarr;
          </a>
        </div>
      ) : null}
    </div>
  );
}
