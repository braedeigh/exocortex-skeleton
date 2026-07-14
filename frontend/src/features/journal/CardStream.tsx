import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
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
  addSaving: boolean;
  /** Resolves true on a successful save; the composer clears its draft on
   * success. New notes always append to the end of the day. */
  onComposeSave: (body: string) => Promise<boolean>;
  /** The bottom composer is always mounted, so polling can't key off a
   * "composing" flag — fires whenever its focused-or-has-draft state
   * changes so the parent can fold it into the same pause condition. */
  onBottomActiveChange: (active: boolean) => void;
}

interface BottomComposerProps {
  saving: boolean;
  onSave: (body: string) => Promise<boolean>;
  onActiveChange: (active: boolean) => void;
}

/** Nearest ancestor that actually scrolls — the journal scrolls inside the
 * page div (overflow-y: auto), not the window, so scroll compensation has
 * to target it directly. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/**
 * Always-open composer at the end of the stream — no dashed prompt to tap
 * through first, since a note at the end of the day is the common case.
 * The wrapper is position: sticky, so it rides the bottom edge of the
 * scroller while she's reading higher up and settles into normal flow at
 * the true bottom of the day. Textarea + Save sit side by side; the
 * textarea starts at the Save button's height and auto-grows with the
 * draft. Saving clears the draft but leaves the composer mounted.
 */
function BottomComposer({ saving, onSave, onActiveChange }: BottomComposerProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wasActive = useRef(false);

  useEffect(() => {
    if (!taRef.current) return;
    const ta = taRef.current;
    const prevBottom = ta.getBoundingClientRect().bottom;
    ta.style.height = 'auto';
    // Floor at the Save button's height (--tap-target, 44px) so the empty
    // row reads as one compact line; +2 covers the top/bottom borders that
    // scrollHeight doesn't include.
    ta.style.height = `${Math.max(44, ta.scrollHeight + 2)}px`;
    // Pin the composer's bottom edge where it was on screen, so the box
    // grows upward (earlier cards slide up) instead of walking the Save
    // row down past the fold.
    const delta = ta.getBoundingClientRect().bottom - prevBottom;
    if (delta !== 0) scrollParent(ta)?.scrollBy(0, delta);
  }, [draft]);

  const active = focused || draft.trim().length > 0;
  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    onActiveChange(active);
  }, [active, onActiveChange]);

  async function handleSave() {
    const ok = await onSave(draft);
    if (ok) setDraft('');
  }

  return (
    <div className={styles.dock}>
      <div className={styles.composer}>
        <div className={styles.composerRow}>
          <textarea
            ref={taRef}
            className={styles.editArea}
            // Textareas default to rows=2, and scrollHeight can never
            // measure smaller than that intrinsic height — without rows=1
            // the auto-size floor silently becomes two lines (~68px).
            rows={1}
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
}

/** Context cards first (dashed/italic/muted), then the rest in their original
 * ts/id order, with the always-open sticky composer at the end. */
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
  addSaving,
  onComposeSave,
  onBottomActiveChange,
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
      {lines.map(renderCard)}
      <BottomComposer saving={addSaving} onSave={onComposeSave} onActiveChange={onBottomActiveChange} />
    </div>
  );
}
