import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { EntryCard } from './EntryCard';
import { RefCard } from './RefCard';
import type { Card } from './types';
import styles from './CardStream.module.css';

export type AddPosition = 'top' | 'bottom';

export interface CardStreamProps {
  cards: Card[];
  editingCardId: string | null;
  savingCardId: string | null;
  matcher: EntityMatcher;
  onEdit: (id: string) => void;
  onCancel: () => void;
  onSave: (id: string, body: string) => void;
  onConfirmDelete: (id: string) => void;
  /** Passed through to "ref" cards' date chips. */
  onNavigateDate: (date: string) => void;
  /** Passed through to "ref" cards' person chips. */
  onPersonClick: (slug: string) => void;
  /** Which "+ Add a note" slot (if any) currently has its composer open. */
  composingPosition: AddPosition | null;
  addSaving: boolean;
  onComposeStart: (position: AddPosition) => void;
  onComposeCancel: () => void;
  onComposeSave: (position: AddPosition, body: string) => void;
}

interface CardAddSlotProps {
  position: AddPosition;
  composing: boolean;
  saving: boolean;
  onStart: (position: AddPosition) => void;
  onCancel: () => void;
  onSave: (position: AddPosition, body: string) => void;
}

/**
 * Quiet "+ Add a note" prompt that swaps in place for a composer styled
 * like an editing entry card — the top slot lands right under the keeper's
 * context summary, the bottom slot at the end of the day. Mirrors
 * EntryCard's editing textarea/controls; port of legacy
 * buildCardAddEl()/enterCardAdd()/saveNewCard().
 */
function CardAddSlot({ position, composing, saving, onStart, onCancel, onSave }: CardAddSlotProps) {
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Fresh draft every time this slot opens (reopening after a prior compose
  // session must not resurrect leftover text).
  useEffect(() => {
    if (composing) setDraft('');
  }, [composing]);

  useEffect(() => {
    if (!composing || !taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(68, ta.scrollHeight + 2)}px`;
  }, [composing, draft]);

  if (!composing) {
    return (
      <div className={styles.addSlot}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={(e) => {
            e.stopPropagation();
            onStart(position);
          }}
        >
          + Add a note
        </button>
      </div>
    );
  }

  return (
    <div className={styles.addSlot}>
      <div className={styles.composer}>
        <textarea
          ref={taRef}
          className={styles.editArea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={position === 'top' ? 'Note for the top of the day…' : 'Note for the end of the day…'}
          disabled={saving}
          autoFocus
        />
        <div className={styles.controls}>
          <span className={styles.controlsSpacer} />
          <Button
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              onSave(position, draft);
            }}
            disabled={saving || !draft.trim()}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Context cards first (dashed/italic/muted), then the rest in their original ts/id order —
 * with a "+ Add a note" slot right after the context cards and one more at the end. */
export function CardStream({
  cards,
  editingCardId,
  savingCardId,
  matcher,
  onEdit,
  onCancel,
  onSave,
  onConfirmDelete,
  onNavigateDate,
  onPersonClick,
  composingPosition,
  addSaving,
  onComposeStart,
  onComposeCancel,
  onComposeSave,
}: CardStreamProps) {
  const context = useMemo(() => cards.filter((c) => c.kind === 'context'), [cards]);
  const lines = useMemo(() => cards.filter((c) => c.kind !== 'context'), [cards]);

  function renderCard(card: Card) {
    return card.kind === 'ref' ? (
      <RefCard
        key={card.id}
        card={card}
        editing={editingCardId === card.id}
        saving={savingCardId === card.id}
        matcher={matcher}
        onEdit={onEdit}
        onCancel={onCancel}
        onSave={onSave}
        onConfirmDelete={onConfirmDelete}
        onNavigateDate={onNavigateDate}
        onPersonClick={onPersonClick}
      />
    ) : (
      <EntryCard
        key={card.id}
        card={card}
        editing={editingCardId === card.id}
        saving={savingCardId === card.id}
        matcher={matcher}
        onEdit={onEdit}
        onCancel={onCancel}
        onSave={onSave}
        onConfirmDelete={onConfirmDelete}
      />
    );
  }

  return (
    <div className={styles.stream}>
      {context.map(renderCard)}
      <CardAddSlot
        position="top"
        composing={composingPosition === 'top'}
        saving={addSaving}
        onStart={onComposeStart}
        onCancel={onComposeCancel}
        onSave={onComposeSave}
      />
      {lines.map(renderCard)}
      <CardAddSlot
        position="bottom"
        composing={composingPosition === 'bottom'}
        saving={addSaving}
        onStart={onComposeStart}
        onCancel={onComposeCancel}
        onSave={onComposeSave}
      />
    </div>
  );
}
