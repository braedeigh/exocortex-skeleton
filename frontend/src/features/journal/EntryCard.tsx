import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { highlightEntities } from './entityHighlight';
import { mdToHtml } from './markdown';
import { insertAtCursor, timestampMarker } from './timestampInsert';
import type { Card } from './types';
import styles from './EntryCard.module.css';

export interface EntryCardProps {
  card: Card;
  editing: boolean;
  saving: boolean;
  matcher: EntityMatcher;
  onEdit: (id: string) => void;
  onCancel: () => void;
  onSave: (id: string, body: string) => void;
  onConfirmDelete: (id: string) => void;
  /** Tapped on the reply-context chip (read mode only) — jumps to the
   * parent's journal day and scrolls/flashes the parent entry. */
  onReplyContext?: (ctx: NonNullable<Card['reply_context']>) => void;
  /** Live-thread display names keyed by slug — resolves which of this card's
   * tags get a thread chip in the meta row. */
  threadNames?: ReadonlyMap<string, string>;
  /** Tapped on a meta-row thread chip — opens that thread's page. */
  onOpenThread?: (slug: string) => void;
  /** Day-counter labels keyed by their "counter-<slug>" tag — a note cell's
   * chip back to its counter (the thread chip's sibling). */
  counterNames?: ReadonlyMap<string, string>;
  /** Tapped on a counter chip — jumps to the counter's home. */
  onOpenCounter?: (tag: string) => void;
}

/** "8:46 AM" from "YYYY-MM-DD HH:MM:SS" — string ops only, no Date/timezone games. */
function cardClock(ts: string): string {
  const h = parseInt(ts.slice(11, 13), 10);
  const m = ts.slice(14, 16);
  if (Number.isNaN(h)) return '';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2026-02-27" -> "Feb 27" — string ops on the date parts only, no
 * Date()/timezone games (house convention; mirrors ThreadJournalPage's
 * formatDate, minus the year suffix — a reply chip never needs it). */
function formatReplyDate(date: string): string {
  const monthIdx = parseInt(date.slice(5, 7), 10) - 1;
  const day = parseInt(date.slice(8, 10), 10);
  const name = MONTH_ABBR[monthIdx];
  if (!name || Number.isNaN(day)) return date;
  return `${name} ${day}`;
}

export function EntryCard({
  card,
  editing,
  saving,
  matcher,
  onEdit,
  onCancel,
  onSave,
  onConfirmDelete,
  onReplyContext,
  threadNames,
  onOpenThread,
  counterNames,
  onOpenCounter,
}: EntryCardProps) {
  const [draft, setDraft] = useState(card.body);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) setDraft(card.body);
  }, [editing, card.body]);

  useEffect(() => {
    if (!editing || !taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(68, ta.scrollHeight + 2)}px`;
    ta.focus();
  }, [editing, draft]);

  function addTimestamp() {
    const el = taRef.current;
    if (!el) return;
    insertAtCursor(el, draft, timestampMarker(), setDraft);
  }

  const bodyHtml = useMemo(() => highlightEntities(mdToHtml(card.body), matcher), [card.body, matcher]);
  const isContext = card.kind === 'context';
  const isK = card.who === 'K';

  const classes = [styles.card, isContext ? styles.context : '', editing ? styles.editing : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} data-card-id={card.id}>
      <div className={styles.meta}>
        <span className={`${styles.who} ${isK ? styles.who_K : styles.who_B}`}>{card.who}</span>
        <span className={styles.time}>{cardClock(card.ts)}</span>
        {card.tags
          .filter((t) => threadNames?.has(t))
          .map((t) => (
            <button
              key={t}
              type="button"
              className={styles.threadChip}
              onClick={() => onOpenThread?.(t)}
              data-track="card-thread-chip"
            >
              &#x29C9; {threadNames!.get(t)}
            </button>
          ))}
        {card.tags
          .filter((t) => counterNames?.has(t))
          .map((t) => (
            <button
              key={t}
              type="button"
              className={styles.threadChip}
              onClick={() => onOpenCounter?.(t)}
              data-track="card-counter-chip"
            >
              &#x23F1; {counterNames!.get(t)}
            </button>
          ))}
        <span className={styles.spacer} />
        {!editing ? (
          <IconButton aria-label="Edit entry" onClick={() => onEdit(card.id)} data-track="card-edit">
            &#9998;
          </IconButton>
        ) : null}
      </div>

      {editing ? (
        <>
          <textarea
            ref={taRef}
            className={styles.editArea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
          />
          <div className={styles.controls}>
            <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={saving}>
              Delete
            </Button>
            <span className={styles.controlsSpacer} />
            <Button variant="secondary" onClick={addTimestamp} disabled={saving} data-track="card-timestamp">
              + Timestamp
            </Button>
            <Button variant="secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => onSave(card.id, draft)}
              disabled={saving || !draft.trim()}
              data-track="card-save"
            >
              Save
            </Button>
          </div>
        </>
      ) : (
        <>
          {card.reply_context ? (
            <button
              type="button"
              className={styles.replyContext}
              onClick={() => onReplyContext?.(card.reply_context!)}
              data-track="card-reply-context"
            >
              <span className={styles.replyContextDate}>&#8627; {formatReplyDate(card.reply_context.date)}</span>
              <span className={styles.replyContextSnippet}>&#8220;{card.reply_context.snippet}&#8221;</span>
            </button>
          ) : null}
          <div
            className={`${styles.body} ${isK ? styles.body_K : ''} ${isContext ? styles.body_context : ''}`}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        </>
      )}

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete this entry?">
        <p className={styles.confirmPreview}>{card.body.slice(0, 80)}{card.body.length > 80 ? '…' : ''}</p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-track="card-delete"
            onClick={() => {
              setConfirmOpen(false);
              onConfirmDelete(card.id);
            }}
          >
            Delete
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
