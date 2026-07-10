import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { highlightEntities } from './entityHighlight';
import { mdToHtml } from './markdown';
import { classifyRef, refLabel } from './refTargets';
import type { RefTarget } from './refTargets';
import { insertAtCursor, timestampMarker } from './timestampInsert';
import type { Card } from './types';
import styles from './RefCard.module.css';

export interface RefCardProps {
  card: Card;
  editing: boolean;
  saving: boolean;
  matcher: EntityMatcher;
  onEdit: (id: string) => void;
  onCancel: () => void;
  onSave: (id: string, body: string) => void;
  onConfirmDelete: (id: string) => void;
  /** Navigate the journal to a target date (same mechanism as prev/next/calendar). */
  onNavigateDate: (date: string) => void;
  /** Open the PersonPopover for a slug — the same state/handler the inline entity-click path uses. */
  onPersonClick: (slug: string) => void;
}

/**
 * A keeper-authored annotation referencing past events — rendered as a
 * small, visually-quiet "margin note" cell rather than a full B/K entry
 * card: no who-badge, an accent left border, a "↳ ref" label, and a row of
 * chips (one per Card.refs entry) instead of the usual meta bar.
 *
 * Edit affordance: rather than reusing EntryCard's render tree (its meta
 * bar / who-badge / body chrome doesn't apply here), this gives the ref
 * card its own minimal edit-in-place UI. It wires to the *same*
 * onSave/onConfirmDelete callbacks CardStream already passes to EntryCard
 * (backed by the same useUpdateCard/useDeleteCard mutations in
 * useJournalData.ts) — so no new mutation hook, just a smaller view.
 */
export function RefCard({
  card,
  editing,
  saving,
  matcher,
  onEdit,
  onCancel,
  onSave,
  onConfirmDelete,
  onNavigateDate,
  onPersonClick,
}: RefCardProps) {
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
    ta.style.height = `${Math.max(52, ta.scrollHeight + 2)}px`;
    ta.focus();
  }, [editing, draft]);

  function addTimestamp() {
    const el = taRef.current;
    if (!el) return;
    insertAtCursor(el, draft, timestampMarker(), setDraft);
  }

  const bodyHtml = useMemo(() => highlightEntities(mdToHtml(card.body), matcher), [card.body, matcher]);
  const targets = useMemo(() => (card.refs ?? []).map(classifyRef), [card.refs]);

  function chipClick(target: RefTarget) {
    if (target.type === 'date') onNavigateDate(target.date);
    else if (target.type === 'person') onPersonClick(target.slug);
  }

  const classes = [styles.card, editing ? styles.editing : ''].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className={styles.meta}>
        <span className={styles.label}>&#8627; ref</span>
        <span className={styles.spacer} />
        {!editing ? (
          <IconButton aria-label="Edit reference" onClick={() => onEdit(card.id)}>
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
        <>
          <div className={styles.body} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
          {targets.length > 0 ? (
            <div className={styles.chips}>
              {targets.map((target, i) =>
                target.type === 'file' ? (
                  <a
                    key={i}
                    className={styles.chip}
                    href={`/files?path=${encodeURIComponent(target.path)}`}
                  >
                    {refLabel(target)}
                  </a>
                ) : (
                  <button key={i} type="button" className={styles.chip} onClick={() => chipClick(target)}>
                    {refLabel(target)}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </>
      )}

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete this reference?">
        <p className={styles.confirmPreview}>
          {card.body.slice(0, 80)}
          {card.body.length > 80 ? '…' : ''}
        </p>
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
