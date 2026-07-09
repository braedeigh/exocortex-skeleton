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
}

/** "8:46 AM" from "YYYY-MM-DD HH:MM:SS" — string ops only, no Date/timezone games. */
function cardClock(ts: string): string {
  const h = parseInt(ts.slice(11, 13), 10);
  const m = ts.slice(14, 16);
  if (Number.isNaN(h)) return '';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function EntryCard({ card, editing, saving, matcher, onEdit, onCancel, onSave, onConfirmDelete }: EntryCardProps) {
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
    <div className={classes}>
      <div className={styles.meta}>
        <span className={`${styles.who} ${isK ? styles.who_K : styles.who_B}`}>{card.who}</span>
        <span className={styles.time}>{cardClock(card.ts)}</span>
        <span className={styles.spacer} />
        {!editing ? (
          <IconButton aria-label="Edit entry" onClick={() => onEdit(card.id)}>
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
            <Button variant="secondary" onClick={addTimestamp} disabled={saving}>
              + Timestamp
            </Button>
            <Button variant="secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => onSave(card.id, draft)} disabled={saving || !draft.trim()}>
              Save
            </Button>
          </div>
        </>
      ) : (
        <div
          className={`${styles.body} ${isK ? styles.body_K : ''} ${isContext ? styles.body_context : ''}`}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete this entry?">
        <p className={styles.confirmPreview}>{card.body.slice(0, 80)}{card.body.length > 80 ? '…' : ''}</p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
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
