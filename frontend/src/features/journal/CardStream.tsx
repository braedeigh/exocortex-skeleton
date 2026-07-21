import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import type { MarkedTodo } from '../../api/endpoints';
import { fmtTime } from '../todos/todoHelpers';
import type { EntityMatcher } from './entityHighlight';
import { EntryCard } from './EntryCard';
import { RefCard } from './RefCard';
import type { Card } from './types';
import styles from './CardStream.module.css';

export interface CardStreamProps {
  cards: Card[];
  /** This day's to-do completion moments — woven between entries by
   * time-of-day. Each sits at the most precise moment she's claimed
   * (edited finished time, else the tap minute). Computed overlay, not
   * cards: nothing is minted, an un-check makes the footprint vanish. */
  markers?: MarkedTodo[];
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
  /** Passed through to entry cards' reply-context chip. */
  onReplyContext: (ctx: NonNullable<Card['reply_context']>) => void;
  /** Live-thread names by slug, for entry cards' meta-row thread chips. */
  threadNames: ReadonlyMap<string, string>;
  /** Passed through to entry cards' meta-row thread chips. */
  onOpenThread: (slug: string) => void;
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
    const sc = scrollParent(ta);
    const wasAtBottom = sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4 : false;
    ta.style.height = 'auto';
    // Floor at the Save button's height (--tap-target, 44px) so the empty
    // row reads as one compact line; +2 covers the top/bottom borders that
    // scrollHeight doesn't include.
    ta.style.height = `${Math.max(44, ta.scrollHeight + 2)}px`;
    // At the end of the day, growth pushes the cards up — stay glued to the
    // bottom. Mid-page, the sticky dock is already pinned to the viewport's
    // bottom edge, so no compensation is needed there.
    if (wasAtBottom && sc) sc.scrollTop = sc.scrollHeight;
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
          data-track="compose-save"
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
  );
}

/** Context cards first (dashed/italic/muted), then the rest in their original
 * ts/id order, with the always-open sticky composer at the end. */
export function CardStream({
  cards,
  markers = [],
  editingCardId,
  savingCardId,
  matcher,
  onEdit,
  onCancel,
  onSave,
  onConfirmDelete,
  onNavigateDate,
  onPersonClick,
  onReplyContext,
  threadNames,
  onOpenThread,
  addSaving,
  onComposeSave,
  onBottomActiveChange,
}: CardStreamProps) {
  const context = useMemo(() => cards.filter((c) => c.kind === 'context'), [cards]);
  const lines = useMemo(() => cards.filter((c) => c.kind !== 'context'), [cards]);

  // Stable weave: each marker slots before the first entry whose
  // time-of-day is later than the tap — entries never reorder. Card ts is
  // "YYYY-MM-DD HH:MM:SS", markers carry "HH:MM"; sliced string compare is
  // exact ("14:30" < "14:30:22" ✓). Taps after the last entry trail the day.
  const woven = useMemo(() => {
    const out: Array<{ kind: 'card'; card: Card } | { kind: 'marker'; marker: MarkedTodo }> = [];
    const pending = [...markers].sort((a, b) => a.time.localeCompare(b.time));
    for (const card of lines) {
      const t = card.ts.slice(11, 16);
      while (pending.length && pending[0].time <= t) {
        out.push({ kind: 'marker', marker: pending.shift() as MarkedTodo });
      }
      out.push({ kind: 'card', card });
    }
    for (const marker of pending) out.push({ kind: 'marker', marker });
    return out;
  }, [lines, markers]);

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
        onReplyContext={onReplyContext}
        threadNames={threadNames}
        onOpenThread={onOpenThread}
      />
    );
  }

  return (
    <div className={styles.stream}>
      {context.map(renderCard)}
      {woven.map((w) =>
        w.kind === 'card' ? (
          renderCard(w.card)
        ) : (
          <div key={`marked-${w.marker.id}`} className={styles.marker}>
            <span className={styles.markerCheck} aria-hidden="true">
              &#10003;
            </span>
            <span className={styles.markerText}>{w.marker.text}</span>
            <span className={styles.markerTime}>{fmtTime(w.marker.time)}</span>
          </div>
        ),
      )}
      <BottomComposer saving={addSaving} onSave={onComposeSave} onActiveChange={onBottomActiveChange} />
    </div>
  );
}
