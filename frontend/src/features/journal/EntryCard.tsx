/**
 * One journal card: a single thing said, by you or the Keeper, with its time,
 * tags, and chips (thread, counter, the conversation it came from). Reading,
 * its words are rendered as light markdown with people and threads
 * highlighted, and any photos in it show as a thumbnail row underneath
 * (CardPhotos.tsx). An entry that's been changed wears an "edited" chip
 * opening its history (EditHistorySheet.tsx). In search results it's
 * read-only, with the matching words lit (searchMarks.ts).
 *
 * The 24-hour window (docs/journal-database.md): for a day after it's saved
 * a card has a pencil, and editing it gives a text box with Save/Cancel, a
 * timestamp button, tag editing, a delete that asks first, and a quiet
 * "locks at …" line. After that the words are fixed: the pencil becomes
 * "+ note", which opens a box for a later note (saved on today's page, linked
 * here) beside the same tag editor — labels never lock. A note wears a
 * "↪ Jul 14: '…'" quote of the card it's about; an old card with notes shows
 * "N notes added later", opening to them.
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
import { EditHistorySheet } from './EditHistorySheet';
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
  /** The server's today, "YYYY-MM-DD" — lets the lock line say "today" /
   * "tomorrow" instead of a date. */
  today?: string | null;
  /** Save a later note on this (locked) card. Resolves true on success.
   * Without it, a locked card offers no "+ note". */
  onAddNote?: (id: string, body: string) => Promise<boolean>;
  /** True while this card's note is saving. */
  noteSaving?: boolean;
  /** Tapped on one of the notes added later — jumps to it on its own day. */
  onOpenCard?: (date: string, id: string) => void;
}

/** "8:46 AM" from "YYYY-MM-DD HH:MM:SS" — string ops only, no Date/timezone games. */
/** "Sep 24" from an `edited` stamp ("YYYY-MM-DD HH:MM:SS") — display only. */
function formatEditedDay(stamp: string): string {
  const date = new Date(`${stamp.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? stamp.slice(0, 10) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Nov 17" -> the day after `day` ("YYYY-MM-DD"), for the lock line's
 * "tomorrow". Noon keeps it clear of any daylight-saving edge. */
function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + 1);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** "locks at 11:15 PM tomorrow" from a locks_at stamp and the server's
 * today — "today" / "tomorrow" when it's one of those, else "on Nov 18". */
function lockLine(locksAt: string, today: string | null | undefined): string {
  const day = locksAt.slice(0, 10);
  const when = today && day === today ? 'today' : today && day === nextDay(today) ? 'tomorrow' : `on ${formatReplyDate(day)}`;
  return `locks at ${cardClock(locksAt)} ${when}`;
}

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

/** "🎙 voice · kitchen-mac" for a card that arrived through a device, or null
 * for an ordinary typed card. Reads the `via:<device>` and `voice` tags. */
function sourceLabel(tags: readonly string[]): string | null {
  const via = tags.find((t) => t.startsWith('via:'));
  if (!via) return null;
  const device = via.slice('via:'.length);
  const how = tags.includes('voice') ? '\u{1F399}\uFE0F voice' : 'via';
  return device ? `${how} \u00B7 ${device}` : how;
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
  today,
  onAddNote,
  noteSaving = false,
  onOpenCard,
}: EntryCardProps) {
  const [draft, setDraft] = useState(card.body);
  const [noteDraft, setNoteDraft] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  // Past its 24 hours: the words are fixed, and "editing" means adding a note.
  // A card the server didn't stamp (an older payload) counts as open.
  const locked = card.editable === false;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
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
  }, [editing, draft, noteDraft]);

  // Closing the note box (Cancel, or another card opened) drops its draft.
  useEffect(() => {
    if (!editing) setNoteDraft('');
  }, [editing]);

  async function saveNote() {
    if (!onAddNote || !noteDraft.trim()) return;
    const ok = await onAddNote(card.id, noteDraft);
    if (ok) setNoteDraft('');
  }

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
  /** The tag editor — in the edit box and in a locked card's note box alike
   * ("small until edit"): every tag as a chip with a visible ×, plus an input
   * that suggests the live thread names. Tagging a card is how it joins a
   * thread, so this row IS the "add this card to a thread" control. Only
   * renders when both tag callbacks are wired. */
  function tagEditor() {
    if (!onAddTag || !onRemoveTag) return null;
    const busy = saving || noteSaving;
    return (
      <div className={styles.tagRow}>
        {card.tags.map((t) => (
          <span key={t} className={styles.tagChip}>
            {threadNames?.get(t) ?? t}
            <button
              type="button"
              className={styles.tagRemove}
              aria-label={`Remove tag ${t}`}
              onClick={() => onRemoveTag(card.id, t)}
              disabled={busy}
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
          disabled={busy}
          data-track="card-tag-input"
        />
        <datalist id={`thread-tags-${card.id}`}>
          {threadNames
            ? [...threadNames.entries()]
                .filter(([slug]) => !card.tags.includes(slug))
                .map(([slug, name]) => <option key={slug} value={slug} label={name} />)
            : null}
        </datalist>
        <Button variant="secondary" onClick={submitTag} disabled={busy || !tagDraft.trim()} data-track="card-tag-add">
          Add
        </Button>
      </div>
    );
  }

  const isContext = card.kind === 'context';
  // The speaker badge: each of the three speakers has its own look, so a
  // system reminder never passes for her words or the keeper's.
  const whoClass = card.who === 'K' ? styles.who_K : card.who === 'S' ? styles.who_S : styles.who_B;

  const classes = [styles.card, isContext ? styles.context : '', editing ? styles.editing : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} data-card-id={card.id}>
      <div className={styles.meta}>
        <span className={`${styles.who} ${whoClass}`} title={card.who === 'S' ? 'System reminder' : undefined}>
          {card.who}
        </span>
        <span className={styles.time}>{cardClock(card.ts)}</span>
        {/* The entry was changed after it was written: say when, and open
            what it used to say. The time above stays the original one. */}
        {card.edited ? (
          <button
            type="button"
            className={styles.editedChip}
            onClick={() => setHistoryOpen(true)}
            title="See what it said before"
            data-track="card-edited-chip"
          >
            &#9998; edited {formatEditedDay(card.edited)}
          </button>
        ) : null}
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
        {/* How this card came in, when it wasn't typed: a `via:<device>` tag
            names the machine that heard it and `voice` says it was spoken
            (routes/ear.py mints both). A fact about the entry, not a link,
            so it's quiet like the edited chip. */}
        {sourceLabel(card.tags) ? (
          <span className={styles.sourceChip} data-track="card-source-chip">
            {sourceLabel(card.tags)}
          </span>
        ) : null}
        <span className={styles.spacer} />
        {!editing && !readOnly && !locked ? (
          <IconButton aria-label="Edit entry" onClick={() => onEdit(card.id)} data-track="card-edit">
            &#9998;
          </IconButton>
        ) : null}
        {/* Locked: no pencil. The one thing left to do with the words is
            answer them — a note, on today's page. Opening it also shows the
            tag editor, since labels don't lock. */}
        {!editing && !readOnly && locked && onAddNote ? (
          <button
            type="button"
            className={styles.noteButton}
            onClick={() => onEdit(card.id)}
            title="This entry is locked. Add a note to it — it goes on today's page."
            data-track="card-add-note"
          >
            + note
          </button>
        ) : null}
      </div>

      {editing && locked ? (
        <>
          <p className={styles.lockNote}>
            Locked — it was saved more than a day ago. A note goes on today&apos;s page, linked to this entry.
          </p>
          <textarea
            ref={taRef}
            className={styles.editArea}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Add a note…"
            disabled={noteSaving}
          />
          {tagEditor()}
          <div className={styles.controls}>
            <span className={styles.controlsSpacer} />
            <Button variant="secondary" onClick={onCancel} disabled={noteSaving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void saveNote()}
              disabled={noteSaving || !noteDraft.trim()}
              data-track="card-note-save"
            >
              Save note
            </Button>
          </div>
        </>
      ) : editing ? (
        <>
          <textarea
            ref={taRef}
            className={styles.editArea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
          />
          {tagEditor()}
          {/* How long this stays changeable — after that, notes only. */}
          {card.locks_at ? <p className={styles.lockNote}>Can be changed or deleted until it {lockLine(card.locks_at, today)}.</p> : null}
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
              {/* A note on an old card reads "↪ Jul 14:"; a reply to a
                  Keeper question keeps its "↳ Jul 14". Same chip, same jump. */}
              <span className={styles.replyContextDate}>
                {card.reply_context.link === 'note'
                  ? <>&#8618; {formatReplyDate(card.reply_context.date)}:</>
                  : <>&#8627; {formatReplyDate(card.reply_context.date)}</>}
              </span>
              <span className={styles.replyContextSnippet}>&#8220;{card.reply_context.snippet}&#8221;</span>
            </button>
          ) : null}
          {bodyText || !photos.length ? (
            <div
              className={`${styles.body} ${card.who === 'K' ? styles.body_K : ''} ${isContext ? styles.body_context : ''}`}
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : null}
          <CardPhotos photos={photos} />
          {/* Later thoughts on this entry, saved on the days they were had —
              folded to one line until she opens it. */}
          {card.notes && card.notes.length > 0 ? (
            <div className={styles.laterNotes}>
              <button
                type="button"
                className={styles.laterNotesToggle}
                onClick={() => setNotesOpen((open) => !open)}
                aria-expanded={notesOpen}
                data-track="card-later-notes"
              >
                {card.notes.length} {card.notes.length === 1 ? 'note' : 'notes'} added later &middot;{' '}
                {formatReplyDate(card.notes[card.notes.length - 1].date)} {notesOpen ? '▴' : '▾'}
              </button>
              {notesOpen
                ? card.notes.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      className={styles.replyContext}
                      onClick={() => onOpenCard?.(note.date, note.id)}
                      data-track="card-later-note"
                    >
                      <span className={styles.replyContextDate}>{formatReplyDate(note.date)}</span>
                      <span className={styles.replyContextSnippet}>&#8220;{note.snippet}&#8221;</span>
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </>
      )}

      {card.edited ? (
        <EditHistorySheet
          cardId={card.id}
          currentBody={card.body || stripMarks(markedBody ?? '')}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

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
