import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { EntryCard } from './EntryCard';
import { RefCard } from './RefCard';
import type { Card } from './types';
import styles from './CardStream.module.css';

export interface CardStreamHandle {
  /** Scroll the always-open bottom composer into view and focus its textarea
   * — used by the rail's floating "+ Add note" button and the stream's own
   * "+ Add a note" slot up top. */
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

export interface BottomComposerHandle {
  focus: () => void;
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
 * Textarea + Save sit side by side; the textarea starts at the Save
 * button's height and auto-grows with the draft. Saving clears the draft
 * but leaves the composer mounted for the next note.
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
    const ok = await onSave(draft);
    if (ok) setDraft('');
  }

  return (
    <div className={styles.addSlot} ref={containerRef}>
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
});

/** Context cards first (dashed/italic/muted), then the rest in their original ts/id order —
 * with a "+ Add a note" shortcut right after the context cards that jumps to
 * the always-open composer at the end. */
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
    addSaving,
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
      <div className={styles.addSlot}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={(e) => {
            e.stopPropagation();
            bottomComposerRef.current?.focus();
          }}
        >
          + Add a note
        </button>
      </div>
      {lines.map(renderCard)}
      <BottomComposer ref={bottomComposerRef} saving={addSaving} onSave={onComposeSave} onActiveChange={onBottomActiveChange} />
    </div>
  );
});
