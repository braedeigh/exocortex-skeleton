import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { EntryCard } from './EntryCard';
import { RefCard } from './RefCard';
import type { Card } from './types';
import styles from './CardStream.module.css';

export type AddPosition = 'top' | 'bottom';

export interface CardStreamHandle {
  /** Scroll the always-open bottom composer into view and focus its textarea
   * — used by the rail's floating "+ Add note" button. */
  focusBottomComposer: () => void;
}

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
  /** Whether the top "+ Add a note" slot's composer is open (the bottom
   * composer is always open, so it has no "composing" state of its own). */
  composingTop: boolean;
  addSaving: boolean;
  onComposeStart: () => void;
  onComposeCancel: () => void;
  /** Resolves true on a successful save. Both slots clear their draft on
   * success; the top slot's parent also closes its composer. */
  onComposeSave: (position: AddPosition, body: string) => Promise<boolean>;
  /** The bottom composer is always mounted, so polling can't key off
   * `composingTop` for it — fires whenever its focused-or-has-draft state
   * changes so the parent can fold it into the same pause condition. */
  onBottomActiveChange: (active: boolean) => void;
}

interface CardAddSlotProps {
  composing: boolean;
  saving: boolean;
  onStart: () => void;
  onCancel: () => void;
  onSave: (position: AddPosition, body: string) => Promise<boolean>;
}

/**
 * Quiet "+ Add a note" prompt that swaps in place for a composer styled
 * like an editing entry card — lands right under the keeper's context
 * summary. Mirrors EntryCard's editing textarea/controls; port of legacy
 * buildCardAddEl()/enterCardAdd()/saveNewCard().
 */
function CardAddSlot({ composing, saving, onStart, onCancel, onSave }: CardAddSlotProps) {
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

  async function handleSave() {
    const ok = await onSave('top', draft);
    if (ok) setDraft('');
  }

  if (!composing) {
    return (
      <div className={styles.addSlot}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={(e) => {
            e.stopPropagation();
            onStart();
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
          placeholder="Note for the top of the day…"
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
              void handleSave();
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

interface BottomComposerProps {
  saving: boolean;
  onSave: (position: AddPosition, body: string) => Promise<boolean>;
  onActiveChange: (active: boolean) => void;
}

export interface BottomComposerHandle {
  focus: () => void;
}

/**
 * Always-open composer at the end of the stream — no dashed prompt to tap
 * through first, since a note at the end of the day is the common case.
 * Textarea + Save sit side by side (not stacked like the top slot's Cancel/
 * Save row) so the row stays compact; saving clears the draft but leaves
 * the composer mounted for the next note.
 */
const BottomComposer = forwardRef<BottomComposerHandle, BottomComposerProps>(function BottomComposer(
  { saving, onSave, onActiveChange },
  ref,
) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasActive = useRef(false);

  useEffect(() => {
    if (!taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(68, ta.scrollHeight + 2)}px`;
  }, [draft]);

  const active = focused || draft.trim().length > 0;
  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    onActiveChange(active);
  }, [active, onActiveChange]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Focusing immediately can cancel the smooth scroll (and pop the
      // keyboard open at the wrong spot) — wait a frame so the scroll has
      // started before the textarea grabs focus.
      requestAnimationFrame(() => taRef.current?.focus());
    },
  }));

  async function handleSave() {
    const ok = await onSave('bottom', draft);
    if (ok) setDraft('');
  }

  return (
    <div className={styles.addSlot} ref={containerRef}>
      <div className={styles.composer}>
        <div className={styles.composerRow}>
          <textarea
            ref={taRef}
            className={styles.editArea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Note for the end of the day…"
            disabled={saving}
          />
          <Button
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              void handleSave();
            }}
            disabled={saving || !draft.trim()}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
});

/** Context cards first (dashed/italic/muted), then the rest in their original ts/id order —
 * with a "+ Add a note" slot right after the context cards and an always-open
 * composer at the end. */
export const CardStream = forwardRef<CardStreamHandle, CardStreamProps>(function CardStream(
  {
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
    composingTop,
    addSaving,
    onComposeStart,
    onComposeCancel,
    onComposeSave,
    onBottomActiveChange,
  },
  ref,
) {
  const context = useMemo(() => cards.filter((c) => c.kind === 'context'), [cards]);
  const lines = useMemo(() => cards.filter((c) => c.kind !== 'context'), [cards]);
  const bottomComposerRef = useRef<BottomComposerHandle>(null);

  useImperativeHandle(ref, () => ({
    focusBottomComposer: () => bottomComposerRef.current?.focus(),
  }));

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
        composing={composingTop}
        saving={addSaving}
        onStart={onComposeStart}
        onCancel={onComposeCancel}
        onSave={onComposeSave}
      />
      {lines.map(renderCard)}
      <BottomComposer ref={bottomComposerRef} saving={addSaving} onSave={onComposeSave} onActiveChange={onBottomActiveChange} />
    </div>
  );
});
