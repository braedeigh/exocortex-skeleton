import { useMemo } from 'react';
import type { EntityMatcher } from './entityHighlight';
import { EntryCard } from './EntryCard';
import { RefCard } from './RefCard';
import type { Card } from './types';
import styles from './CardStream.module.css';

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
}

/** Context cards first (dashed/italic/muted), then the rest in their original ts/id order. */
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
}: CardStreamProps) {
  const ordered = useMemo(() => {
    const context = cards.filter((c) => c.kind === 'context');
    const lines = cards.filter((c) => c.kind !== 'context');
    return [...context, ...lines];
  }, [cards]);

  return (
    <div className={styles.stream}>
      {ordered.map((card) =>
        card.kind === 'ref' ? (
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
        ),
      )}
    </div>
  );
}
