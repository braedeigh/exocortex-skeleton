/**
 * One journal card: a single thing said, by you or the Keeper, with its time,
 * tags, and chips (thread, counter, the conversation it came from). Reading,
 * its words are rendered as light markdown with people and threads
 * highlighted, and any photos in it show as a thumbnail row underneath
 * (CardPhotos.tsx). Editing, it becomes a text box with Save/Cancel, a
 * timestamp button, tag editing, and a delete that asks first. In search
 * results it's read-only, with the matching words lit (searchMarks.ts).
 *
 * Touches: `markdown.ts` + `entityHighlight.ts` (rendering the words),
 * `photoRefs.ts` + `CardPhotos.tsx` (the photos), `CardStream.tsx` (which
 * lays the cards out and passes every handler in).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Sheet } from '../../ui';
import type { EntityMatcher } from './entityHighlight';
import { highlightEntities } from './entityHighlight';
import { mdToHtml } from './markdown';
import { CardPhotos } from './CardPhotos';
import { splitPhotos } from './photoRefs';
import { marksToHtml, stripMarks } from './searchMarks';
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
  /** Session titles keyed by conversation id — a card highlighted out of a
   * conversation earns a chip back to the room it was said in. */
  sessionNames?: ReadonlyMap<string, string>;
  /** Tapped on a session chip — opens that conversation. */
  onOpenSession?: (convId: string) => void;
  /** Edit-mode tag editor: add one tag (tags are the thread link, so this is
   * "put this card in that thread"). Editor only renders when both tag
   * callbacks are wired. */
  onAddTag?: (id: string, tag: string) => void;
  /** Edit-mode tag editor: remove one tag. */
  onRemoveTag?: (id: string, tag: string) => void;
  /** Read-only: no edit pencil. The search results use this — changes are
   * made on the card's own day, never from a list of results. */
  readOnly?: boolean;
  /** The card's text with search hits wrapped in searchMarks.ts markers;
   * when given, it's rendered in place of `card.body` with the hits lit. */
  markedBody?: string;
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
  sessionNames,
  onOpenSession,
  onAddTag,
  onRemoveTag,
  readOnly = false,
  markedBody,
}: EntryCardProps) {
  const [draft, setDraft] = useState(card.body);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // What she types becomes a slug the pool accepts ("Dating & Romance" ->
  // "dating-romance") — same shape TAG_RE enforces server-side.
  function submitTag() {
    const slug = tagDraft.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (!slug || card.tags.includes(slug)) return;
    onAddTag?.(card.id, slug);
    setTagDraft('');
  }

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

  // Split the photos out of the words: the words render as text, the photos
  // as thumbnails below them. Editing still shows the raw markers. A search
  // result's hit markers ride through the markdown step and become <mark>s
  // at the end (searchMarks.ts); they're wiped from the photo names, which
  // go to the server as file names.
  const { text: bodyText, photos } = useMemo(() => {
    const split = splitPhotos(markedBody ?? card.body);
    if (markedBody === undefined) return split;
    return {
      text: split.text,
      photos: split.photos.map((p) => ({ name: stripMarks(p.name), caption: stripMarks(p.caption) })),
    };
  }, [markedBody, card.body]);
  const bodyHtml = useMemo(() => {
    const html = highlightEntities(mdToHtml(bodyText), matcher);
    return markedBody === undefined ? html : marksToHtml(html);
  }, [bodyText, matcher, markedBody]);
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
        {/* Where this card was pulled from — a span she highlighted in a
            conversation carries the room it was said in, and the chip opens it
            back up. Same shape as its thread and counter siblings; the ✦ is the
            same mark the highlight gesture uses in the observatory. */}
        {card.session && sessionNames?.has(card.session) ? (
          <button
            type="button"
            className={styles.threadChip}
            onClick={() => onOpenSession?.(card.session!)}
            data-track="card-session-chip"
          >
            &#10022; {sessionNames.get(card.session)}
          </button>
        ) : null}
        <span className={styles.spacer} />
        {!editing && !readOnly ? (
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
          {onAddTag && onRemoveTag ? (
            /* The tag editor — edit mode only ("small until edit"): every tag
               as a chip with a visible ×, plus an input that suggests the
               live thread names. Tagging a card is how it joins a thread, so
               this row IS the "add this card to a thread" control. */
            <div className={styles.tagRow}>
              {card.tags.map((t) => (
                <span key={t} className={styles.tagChip}>
                  {threadNames?.get(t) ?? t}
                  <button
                    type="button"
                    className={styles.tagRemove}
                    aria-label={`Remove tag ${t}`}
                    onClick={() => onRemoveTag(card.id, t)}
                    disabled={saving}
                    data-track="card-tag-remove"
                  >
                    &times;
                  </button>
                </span>
              ))}
              <input
                className={styles.tagInput}
                list={`thread-tags-${card.id}`}
                placeholder="+ tag / thread"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitTag();
                  }
                }}
                disabled={saving}
                data-track="card-tag-input"
              />
              <datalist id={`thread-tags-${card.id}`}>
                {threadNames
                  ? [...threadNames.entries()]
                      .filter(([slug]) => !card.tags.includes(slug))
                      .map(([slug, name]) => <option key={slug} value={slug} label={name} />)
                  : null}
              </datalist>
              <Button variant="secondary" onClick={submitTag} disabled={saving || !tagDraft.trim()} data-track="card-tag-add">
                Add
              </Button>
            </div>
          ) : null}
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
          {bodyText || !photos.length ? (
            <div
              className={`${styles.body} ${isK ? styles.body_K : ''} ${isContext ? styles.body_context : ''}`}
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : null}
          <CardPhotos photos={photos} />
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
