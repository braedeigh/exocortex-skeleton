/**
 * AgentNotes — the "from agents" block on a to-do: every note an agent left,
 * each showing WHO (agentLabel), WHEN (minute stamp), the short text, and
 * its citations as tappable links (provenance.refTarget). Sits under the
 * owner's own Description in the edit form and is visibly a different thing
 * from it — the agent's words are never editable here, only dismissable
 * (an × per note, confirm-free because the note is the agent's, not hers,
 * and it can be re-derived from its citation).
 *
 * `onDismiss` is optional: the approval sheet renders the same block
 * read-only for a note that hasn't been committed yet.
 */
import { Link } from '@tanstack/react-router';
import { IconButton } from '../../ui';
import { agentLabel, refTarget, stampLabel } from './provenance';
import { fmtAddedDate } from './todoHelpers';
import type { AgentNote } from './types';
import styles from './AgentNotes.module.css';

export interface AgentNotesProps {
  notes: AgentNote[];
  onDismiss?: (note: AgentNote) => void;
}

function RefLink({ r }: { r: string }) {
  const t = refTarget(r);
  if (t.kind === 'route') {
    return (
      <Link to={t.to} search={t.search ?? {}} className={styles.ref}>
        ↗ {t.label}
      </Link>
    );
  }
  if (t.kind === 'external') {
    return (
      <a href={t.href} target="_blank" rel="noreferrer" className={styles.ref}>
        ↗ {t.label}
      </a>
    );
  }
  return <span className={styles.refText}>{t.label}</span>;
}

export function AgentNotes({ notes, onDismiss }: AgentNotesProps) {
  if (!notes.length) return null;
  return (
    <div className={styles.list}>
      {notes.map((n) => (
        <div key={`${n.by}|${n.at}`} className={styles.note}>
          <div className={styles.body}>
            <div className={styles.who}>
              <span className={styles.by}>{agentLabel(n.by)}</span>
              <span className={styles.when}>{stampLabel(n.at, fmtAddedDate)}</span>
            </div>
            <div className={styles.text}>{n.text}</div>
            <div className={styles.refs}>
              {n.refs.map((r) => (
                <RefLink key={r} r={r} />
              ))}
              {n.conv && !n.refs.includes(`conv:${n.conv}`) ? <RefLink r={`conv:${n.conv}`} /> : null}
            </div>
          </div>
          {onDismiss ? (
            <IconButton aria-label={`Dismiss note from ${agentLabel(n.by)}`} onClick={() => onDismiss(n)}>
              &times;
            </IconButton>
          ) : null}
        </div>
      ))}
    </div>
  );
}
