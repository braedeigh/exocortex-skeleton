import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { NotesPill } from '../todos/NotesPill';
import { useSessionsContext } from '../../shell/SessionsContext';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { openSessionInTerminal } from '../../shell/sessionIntent';
import { Button, IconButton, Sheet, ToastStack } from '../../ui';
import type { EntityMatcher } from '../journal/entityHighlight';
import { buildEntityMatcher, highlightEntities } from '../journal/entityHighlight';
import { mdToHtml } from '../journal/markdown';
import { startThreadTalk, talkLabel, type TalkState } from '../journal/threadTalk';
import type { ThreadJournalCardEntry, ThreadJournalDayEntry, ThreadJournalEntry } from '../journal/types';
import {
  useAddThreadEntry,
  useDeleteThreadEntry,
  usePeople,
  useServerDate,
  useThreadJournal,
  useThreads,
  useToasts,
  useUpdateThreadEntry,
} from '../journal/useJournalData';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import styles from './ThreadJournalPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

type SortOrder = 'desc' | 'asc';

const SORT_KEY = 'exo-thread-sort';

/** Lazily read the shared sort preference — same try/catch-on-localStorage
 * pattern as SplitLayout's readWidth. One preference for every thread. */
function readSortOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw === 'asc' || raw === 'desc') return raw;
  } catch {
    // ignore
  }
  return 'desc';
}

function writeSortOrder(order: SortOrder): void {
  try {
    localStorage.setItem(SORT_KEY, order);
  } catch {
    // ignore
  }
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2026-02-27" (+ current server year) -> "Feb 27" / "Feb 27, 2025" — string
 * ops on the date parts only, no Date()/timezone games (house convention). */
function formatDate(date: string, serverYear: string | null): string {
  const year = date.slice(0, 4);
  const monthIdx = parseInt(date.slice(5, 7), 10) - 1;
  const day = parseInt(date.slice(8, 10), 10);
  const name = MONTH_ABBR[monthIdx];
  if (!name || Number.isNaN(day)) return date;
  const base = `${name} ${day}`;
  return serverYear && year !== serverYear ? `${base}, ${year}` : base;
}

/** "2026-02-27 18:41:00" -> "6:41 PM" — same string-slicing convention as
 * EntryCard's cardClock, no Date() parsing. */
function formatTime(ts: string): string {
  const h = parseInt(ts.slice(11, 13), 10);
  const m = ts.slice(14, 16);
  if (Number.isNaN(h)) return '';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Long-entry clipping (see clipToContextWindow below): full text renders as-is
// up to FULL_TEXT_WORD_LIMIT words; past that, a ~CONTEXT_WINDOW_WORDS-word
// window around the entry's first mention of the thread is shown instead
// (FALLBACK_SNIPPET_WORDS from the start when no mention is found).
const FULL_TEXT_WORD_LIMIT = 120;
const CONTEXT_WINDOW_WORDS = 40;
const FALLBACK_SNIPPET_WORDS = 80;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive, word-boundary-wrapped RegExp matching this thread's own
 * name/aliases — null when there are no terms to match against (a thread
 * should never be treated as matching everything). Used to find the context
 * window for a long entry; not the same matcher as EntityMatcher (that one
 * covers every person/thread, this one only the page's own thread). */
function buildMentionRegex(name: string, aliases: string[]): RegExp | null {
  const terms = [name, ...aliases].map((t) => (t || '').trim()).filter(Boolean);
  if (!terms.length) return null;
  return new RegExp(`\\b(?:${terms.map(escapeRegExp).join('|')})\\b`, 'i');
}

interface WordToken {
  word: string;
  start: number;
  end: number;
}

/** Whitespace-delimited words with their character offsets in `text`, so a
 * character-index regex match can be mapped back to a word window. */
function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Long-entry clipping: text <= FULL_TEXT_WORD_LIMIT words renders unclipped.
 * Longer text clips to the CONTEXT_WINDOW_WORDS words before/after the FIRST
 * mention of the thread (by name/alias) in the raw text — with a leading/
 * trailing "…" wherever the window was actually clipped. If no mention is
 * found in a long entry, falls back to the first FALLBACK_SNIPPET_WORDS words
 * + " …". Returns `clipped: false` (and the untouched text) when no clipping
 * happened, so callers know whether to show the expand/collapse control.
 */
function clipToContextWindow(text: string, mentionRegex: RegExp | null): { text: string; clipped: boolean } {
  const tokens = tokenizeWords(text);
  if (tokens.length <= FULL_TEXT_WORD_LIMIT) {
    return { text, clipped: false };
  }

  let match: RegExpExecArray | null = null;
  if (mentionRegex) {
    const flags = mentionRegex.flags.includes('g') ? mentionRegex.flags : `${mentionRegex.flags}g`;
    match = new RegExp(mentionRegex.source, flags).exec(text);
  }

  if (!match) {
    const words = tokens.slice(0, FALLBACK_SNIPPET_WORDS).map((t) => t.word);
    return { text: `${words.join(' ')} …`, clipped: true };
  }

  const matchStart = match.index;
  const matchEnd = match.index + match[0].length;
  let startTok = tokens.findIndex((t) => t.end > matchStart);
  if (startTok === -1) startTok = tokens.length - 1;
  let endTok = startTok;
  while (endTok + 1 < tokens.length && tokens[endTok + 1].start < matchEnd) {
    endTok++;
  }

  const windowStart = Math.max(0, startTok - CONTEXT_WINDOW_WORDS);
  const windowEnd = Math.min(tokens.length - 1, endTok + CONTEXT_WINDOW_WORDS);
  let snippet = tokens
    .slice(windowStart, windowEnd + 1)
    .map((t) => t.word)
    .join(' ');
  if (windowStart > 0) snippet = `… ${snippet}`;
  if (windowEnd < tokens.length - 1) snippet = `${snippet} …`;
  return { text: snippet, clipped: true };
}

/** Post-process rendered entity-highlighted HTML so THIS page's own thread
 * mentions read differently from mentions of other threads. Matches the
 * exact `<span class="entity entity-thread" data-thread="<slug>">` markup
 * entityHighlight.ts emits (highlightEntities) and injects an extra plain
 * (non-module) class — styled via a `:global` rule in this page's CSS module
 * since the injected HTML can't reference hashed module class names. */
function markSelfMentions(html: string, slug: string): string {
  if (!slug) return html;
  const needle = `class="entity entity-thread" data-thread="${slug}"`;
  const replacement = `class="entity entity-thread thread-self-mention" data-thread="${slug}"`;
  return html.split(needle).join(replacement);
}

interface EntryPartition {
  /** ids of card entries that render as a margin note under some other card,
   * rather than as their own top-level entry in the sorted stream. */
  childIds: Set<string>;
  /** top-level card id -> its child notes, ascending by ts. */
  childrenByParent: Map<string, ThreadJournalCardEntry[]>;
  /** every card entry, by id — used to look up a card's `date` for the
   * update/delete mutations without a second pass over `entries`. */
  cardsById: Map<string, ThreadJournalCardEntry>;
}

/**
 * Nests card entries under the card their `reply_to` points at: "any card
 * whose reply_to matches another CARD entry's id in the list becomes a
 * child of that parent; everything else (including reply_to pointing
 * outside the list) stays top-level." The "+ note" affordance only ever
 * targets a top-level card (child notes can't themselves be replied to —
 * no note-on-note chains), so in practice a reply chain is exactly one
 * level deep. If hand-edited data ever produces a deeper chain anyway, this
 * walks the reply_to links to their ultimate in-list ancestor (cycle-
 * guarded) and flattens the whole chain to one level under it, rather than
 * silently dropping the deeper notes.
 */
function partitionCardEntries(entries: ThreadJournalEntry[]): EntryPartition {
  const cardsById = new Map<string, ThreadJournalCardEntry>();
  for (const e of entries) {
    if (e.kind === 'card') cardsById.set(e.id, e);
  }

  function topAncestorOf(id: string): string {
    const seen = new Set<string>();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const parent = cardsById.get(cur)?.reply_to;
      if (!parent || parent === cur || !cardsById.has(parent)) return cur;
      cur = parent;
    }
    return cur;
  }

  const childIds = new Set<string>();
  const childrenByParent = new Map<string, ThreadJournalCardEntry[]>();
  for (const c of cardsById.values()) {
    const top = topAncestorOf(c.id);
    if (top === c.id) continue;
    childIds.add(c.id);
    const list = childrenByParent.get(top) ?? [];
    list.push(c);
    childrenByParent.set(top, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  return { childIds, childrenByParent, cardsById };
}

export interface ThreadJournalPageProps {
  slug: string;
}

/**
 * The dedicated per-thread journal page (/threads/$slug) — where "Open full
 * thread" from the Threads page / journal's ThreadPopover lands: every
 * journal record tied to the thread (tagged pool cards ∪ cited sources,
 * routes/threads.py thread_journal). Sortable newest/oldest first (a shared
 * localStorage preference, defaulting to newest first), and a sticky bottom
 * composer lets her add a new entry (tagged with the thread's slug) or add
 * one and jump straight into talking about the thread.
 */
export function ThreadJournalPage({ slug }: ThreadJournalPageProps) {
  const { data, isLoading, isError } = useThreadJournal(slug);
  const { data: serverDateData } = useServerDate();
  const { data: peopleData } = usePeople();
  const { data: threadsData } = useThreads();
  const { data: frontsData } = useFronts();
  const fronts = frontsData ?? [];
  const navigate = useNavigate();
  const { setActive } = useSessionsContext();
  const [talkState, setTalkState] = useState<TalkState>('idle');
  const [sortOrder, setSortOrder] = useState<SortOrder>(readSortOrder);
  const { toasts, push, dismiss } = useToasts();
  // The one card/note currently open for interaction — either its edit mode
  // (an editable card/note) or its "+ note" mini-composer (a non-editable
  // top-level card). Shared so opening one closes any other, mirroring the
  // day-editor's single editingCardId (JournalPage.tsx).
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);

  const today = serverDateData?.server_date ?? null;
  const serverYear = today ? today.slice(0, 4) : null;
  const addEntry = useAddThreadEntry(slug, today, push);
  const updateEntry = useUpdateThreadEntry(slug, push);
  const deleteEntry = useDeleteThreadEntry(slug, push);

  const matcher = useMemo(
    () => buildEntityMatcher(peopleData?.people ?? [], threadsData?.threads ?? []),
    [peopleData, threadsData],
  );

  const mentionRegex = useMemo(
    () => buildMentionRegex(data?.thread?.name ?? '', data?.thread?.aliases ?? []),
    [data?.thread?.name, data?.thread?.aliases],
  );

  function goToDay(date: string) {
    void navigate({ to: '/journal', search: { date } });
  }

  function toggleSortOrder() {
    setSortOrder((cur) => {
      const next: SortOrder = cur === 'desc' ? 'asc' : 'desc';
      writeSortOrder(next);
      return next;
    });
  }

  /** Shared by the header's "Talk about this thread" button and the
   * composer's "Add & talk" — both drive the same TalkState so either
   * surface's label/disabled-while-sending logic stays in sync. */
  async function talk() {
    if (talkState === 'sending') return;
    setTalkState('sending');
    try {
      const res = await startThreadTalk(slug);
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        openSessionInTerminal(res.session);
        setTalkState('sent');
      } else {
        setActive(res.session);
        void navigate({ to: '/chat' });
      }
    } catch {
      setTalkState('error');
    }
  }

  const thread = data?.thread;
  const entries = data?.entries ?? [];

  // Payload order is ascending (oldest first) — reverse a copy for the
  // default "newest first" view. Never mutate the query's cached array.
  const displayedEntries = useMemo<ThreadJournalEntry[]>(
    () => (sortOrder === 'desc' ? [...entries].reverse() : entries),
    [entries, sortOrder],
  );

  const { childIds, childrenByParent, cardsById } = useMemo(() => partitionCardEntries(entries), [entries]);

  const savingEntryId = updateEntry.isPending
    ? (updateEntry.variables?.id ?? null)
    : deleteEntry.isPending
      ? (deleteEntry.variables?.id ?? null)
      : null;
  const addingNoteForId = addEntry.isPending ? (addEntry.variables?.replyTo ?? null) : null;

  function closeActive(id: string) {
    setActiveEntryId((cur) => (cur === id ? null : cur));
  }

  function handleSaveEdit(id: string, body: string) {
    const date = cardsById.get(id)?.date ?? '';
    updateEntry.mutate({ id, body, date }, { onSuccess: () => closeActive(id) });
  }

  function handleConfirmDelete(id: string) {
    const date = cardsById.get(id)?.date ?? '';
    deleteEntry.mutate({ id, date }, { onSuccess: () => closeActive(id) });
  }

  async function handleSaveNote(parentId: string, body: string): Promise<boolean> {
    try {
      await addEntry.mutateAsync({ body, replyTo: parentId });
      closeActive(parentId);
      return true;
    } catch {
      return false;
    }
  }

  async function handleComposerSave(body: string): Promise<boolean> {
    try {
      await addEntry.mutateAsync({ body });
      return true;
    } catch {
      return false;
    }
  }

  return (
    <div className={styles.page}>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <Link to="/threads" className={styles.backLink}>
        &larr; Threads
      </Link>

      {isLoading ? <div className={styles.empty}>Loading…</div> : null}
      {!isLoading && (isError || !data) ? (
        <div className={styles.empty}>Couldn’t load this thread.</div>
      ) : null}

      {thread ? (
        <>
          <header className={styles.header}>
            <h1 className={styles.title}>
              <span className={styles.titleMain}>⧉ {thread.name}</span>
              {thread.status === 'dormant' || thread.status === 'retired' ? (
                <span className={styles.badge}>{thread.status}</span>
              ) : null}
              {thread.kind ? <span className={styles.badgeOutline}>{thread.kind}</span> : null}
            </h1>

            {thread.fronts.length > 0 ? (
              <div className={styles.chipRow}>
                {thread.fronts.map((fid) => {
                  const f = fronts.find((x) => x.id === fid);
                  return (
                    <span key={fid} className={styles.frontChip}>
                      {FRONT_EMOJI[fid] || '🏷️'} {f?.name || fid}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {thread.people.length > 0 ? (
              <div className={styles.chipRow}>
                {thread.people.map((p) => (
                  <span key={p.slug} className={styles.personChip}>
                    {p.name}
                  </span>
                ))}
              </div>
            ) : null}

            {!isPublicMode() ? (
              <button type="button" className={styles.talkBtn} onClick={talk} disabled={talkState === 'sending'}>
                {talkLabel(talkState)}
              </button>
            ) : null}
          </header>

          {entries.length > 0 ? (
            <button type="button" className={styles.sortToggle} onClick={toggleSortOrder}>
              {sortOrder === 'desc' ? '↓ Newest first' : '↑ Oldest first'}
            </button>
          ) : null}

          <div className={styles.entries}>
            {entries.length === 0 ? (
              <div className={styles.empty}>No journal entries linked yet.</div>
            ) : (
              displayedEntries
                .filter((e) => !(e.kind === 'card' && childIds.has(e.id)))
                .flatMap((e) => {
                  if (e.kind === 'card') {
                    const canEdit = e.editable && e.who === 'B';
                    const nodes = [
                      <JournalCardEntry
                        key={`card-${e.id}`}
                        entry={e}
                        serverYear={serverYear}
                        matcher={matcher}
                        mentionRegex={mentionRegex}
                        threadSlug={slug}
                        onOpenDay={goToDay}
                        editing={activeEntryId === e.id && canEdit}
                        composingNote={activeEntryId === e.id && !canEdit}
                        saving={savingEntryId === e.id}
                        addingNote={addingNoteForId === e.id}
                        onEdit={() => setActiveEntryId(e.id)}
                        onCancelEdit={() => closeActive(e.id)}
                        onSaveEdit={(body) => handleSaveEdit(e.id, body)}
                        onConfirmDelete={() => handleConfirmDelete(e.id)}
                        onOpenNote={() => setActiveEntryId(e.id)}
                        onCancelNote={() => closeActive(e.id)}
                        onSaveNote={(body) => handleSaveNote(e.id, body)}
                      />,
                    ];
                    for (const child of childrenByParent.get(e.id) ?? []) {
                      const childCanEdit = child.editable && child.who === 'B';
                      nodes.push(
                        <ChildNoteEntry
                          key={`note-${child.id}`}
                          entry={child}
                          serverYear={serverYear}
                          matcher={matcher}
                          threadSlug={slug}
                          onOpenDay={goToDay}
                          editing={activeEntryId === child.id && childCanEdit}
                          saving={savingEntryId === child.id}
                          onEdit={() => setActiveEntryId(child.id)}
                          onCancelEdit={() => closeActive(child.id)}
                          onSaveEdit={(body) => handleSaveEdit(child.id, body)}
                          onConfirmDelete={() => handleConfirmDelete(child.id)}
                        />,
                      );
                    }
                    return nodes;
                  }
                  return [
                    e.excerpts.length > 0 ? (
                      <DayExcerptEntry
                        key={`day-${e.date}`}
                        entry={e}
                        serverYear={serverYear}
                        matcher={matcher}
                        threadSlug={slug}
                        onOpenDay={goToDay}
                      />
                    ) : (
                      <DayRow key={`day-${e.date}`} entry={e} serverYear={serverYear} onOpenDay={goToDay} />
                    ),
                  ];
                })
            )}
          </div>

          {!isPublicMode() ? (
            <ThreadComposer
              disabled={!today}
              saving={addEntry.isPending}
              talkState={talkState}
              onSave={handleComposerSave}
              onTalk={talk}
            />
          ) : null}
        </>
      ) : null}

      {!isPublicMode() ? <NotesPill tab="threads" onError={push} className={styles.notesPill} /> : null}
    </div>
  );
}

interface ThreadComposerProps {
  /** True until the server's "today" has loaded — a new card's ts depends
   * on it, so the composer can't submit before then. */
  disabled: boolean;
  saving: boolean;
  talkState: TalkState;
  /** Resolves true on a successful save; the composer clears its draft on
   * success either way (plain Add or as the first half of Add & talk). */
  onSave: (body: string) => Promise<boolean>;
  /** The page's shared talk() — run after a successful "Add & talk" save. */
  onTalk: () => Promise<void>;
}

/**
 * Sticky bottom composer for /threads/$slug — mirrors CardStream.tsx's
 * BottomComposer dock pattern (position: sticky riding `.page`'s bottom
 * edge, auto-growing textarea starting at one 44px row). Two actions: Add
 * saves a new card tagged with this thread's slug; Add & talk does the same
 * and then launches the same "talk about this thread" flow as the header
 * button, sharing its TalkState.
 */
function ThreadComposer({ disabled, saving, talkState, onSave, onTalk }: ThreadComposerProps) {
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    // Floor at one 44px row (--tap-target) so the empty composer reads as a
    // single compact line; +2 covers the top/bottom borders scrollHeight
    // doesn't include (same trick as CardStream's BottomComposer).
    ta.style.height = `${Math.max(44, ta.scrollHeight + 2)}px`;
  }, [draft]);

  const busy = disabled || saving;
  const canSubmit = !busy && draft.trim().length > 0;

  async function handleAdd() {
    if (!canSubmit) return;
    const ok = await onSave(draft);
    if (ok) setDraft('');
  }

  async function handleAddAndTalk() {
    if (!canSubmit || talkState === 'sending') return;
    const ok = await onSave(draft);
    if (ok) {
      setDraft('');
      await onTalk();
    }
  }

  return (
    <div className={styles.composerDock}>
      <div className={styles.composerRow}>
        <textarea
          ref={taRef}
          className={styles.composerArea}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add to this thread…"
          disabled={busy}
        />
        <div className={styles.composerActions}>
          <Button
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              void handleAdd();
            }}
            disabled={!canSubmit}
          >
            Add
          </Button>
          <Button
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              void handleAddAndTalk();
            }}
            disabled={!canSubmit || talkState === 'sending'}
          >
            💬 Chat
          </Button>
        </div>
      </div>
    </div>
  );
}

interface JournalCardEntryProps {
  entry: ThreadJournalCardEntry;
  serverYear: string | null;
  matcher: EntityMatcher;
  mentionRegex: RegExp | null;
  threadSlug: string;
  onOpenDay: (date: string) => void;
  /** True when this card is open in edit mode (editable && who === 'B'). */
  editing: boolean;
  /** True when this card's "+ note" mini-composer is open. */
  composingNote: boolean;
  /** Pending state for THIS card's own update/delete mutation. */
  saving: boolean;
  /** Pending state for a note being added as a reply to THIS card. */
  addingNote: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (body: string) => void;
  onConfirmDelete: () => void;
  onOpenNote: () => void;
  onCancelNote: () => void;
  onSaveNote: (body: string) => Promise<boolean>;
}

function JournalCardEntry({
  entry,
  serverYear,
  matcher,
  mentionRegex,
  threadSlug,
  onOpenDay,
  editing,
  composingNote,
  saving,
  addingNote,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onConfirmDelete,
  onOpenNote,
  onCancelNote,
  onSaveNote,
}: JournalCardEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const isK = entry.who === 'K';
  const canEdit = entry.editable && entry.who === 'B';

  const { text: snippetText, clipped } = useMemo(
    () => clipToContextWindow(entry.text, mentionRegex),
    [entry.text, mentionRegex],
  );
  const displayText = clipped && !expanded ? snippetText : entry.text;

  const bodyHtml = useMemo(
    () => markSelfMentions(highlightEntities(mdToHtml(displayText), matcher), threadSlug),
    [displayText, matcher, threadSlug],
  );

  return (
    <div className={`${styles.card} ${editing ? styles.cardEditing : ''}`}>
      <div className={styles.meta}>
        <span className={`${styles.who} ${isK ? styles.who_K : styles.who_B}`}>{entry.who}</span>
        <button type="button" className={styles.metaTime} onClick={() => onOpenDay(entry.date)}>
          {formatDate(entry.date, serverYear)} &middot; {formatTime(entry.ts)}
        </button>
        <span className={styles.metaSpacer} />
        {canEdit && !editing ? (
          <IconButton aria-label="Edit entry" onClick={onEdit}>
            &#9998;
          </IconButton>
        ) : null}
      </div>

      {editing ? (
        <EditBlock
          body={entry.text}
          saving={saving}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
          onConfirmDelete={onConfirmDelete}
        />
      ) : (
        <>
          <div
            className={`${styles.body} ${isK ? styles.body_K : ''}`}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          {clipped ? (
            <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less ▴' : 'Show full entry ▾'}
            </button>
          ) : null}
          {/* Read-only (past the rolling 24h window) cards can't be edited in
              place, but can still gather a note — a fresh reply card minted
              today rather than a mutation of the old one. */}
          {!canEdit ? (
            composingNote ? (
              <NoteComposer saving={addingNote} onCancel={onCancelNote} onSave={onSaveNote} />
            ) : (
              <button type="button" className={styles.noteBtn} onClick={onOpenNote}>
                + note
              </button>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

interface EditBlockProps {
  /** The card's persisted body — seeds the draft and backs the delete
   * confirm preview (never the in-progress draft, same as EntryCard). */
  body: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (body: string) => void;
  onConfirmDelete: () => void;
}

/** The in-place edit UI shared by top-level cards and child notes alike — a
 * grown textarea seeded with the raw text, Delete/spacer/Cancel/Save, and a
 * Sheet-confirmed delete with an 80-char preview. Mirrors EntryCard.tsx's
 * edit mode (the day-editor's reference) rather than reinventing one. The
 * card/note id itself isn't needed here — callers already curry it into
 * their onSave/onConfirmDelete closures. */
function EditBlock({ body, saving, onCancel, onSave, onConfirmDelete }: EditBlockProps) {
  const [draft, setDraft] = useState(body);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(body);
  }, [body]);

  useEffect(() => {
    if (!taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(68, ta.scrollHeight + 2)}px`;
    ta.focus();
  }, [draft]);

  return (
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
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSave(draft)} disabled={saving || !draft.trim()}>
          Save
        </Button>
      </div>

      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Delete this entry?">
        <p className={styles.confirmPreview}>
          {body.slice(0, 80)}
          {body.length > 80 ? '…' : ''}
        </p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmOpen(false);
              onConfirmDelete();
            }}
          >
            Delete
          </Button>
        </div>
      </Sheet>
    </>
  );
}

interface NoteComposerProps {
  saving: boolean;
  onCancel: () => void;
  onSave: (body: string) => Promise<boolean>;
}

/** Inline mini-composer that unfolds under a non-editable card's "+ note"
 * button — an auto-grow textarea plus Cancel / Save note. Saving mints a
 * fresh reply card (kept editable for its own next-24h window) rather than
 * touching the old one. */
function NoteComposer({ saving, onCancel, onSave }: NoteComposerProps) {
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!taRef.current) return;
    const ta = taRef.current;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(44, ta.scrollHeight + 2)}px`;
    ta.focus();
  }, [draft]);

  async function handleSave() {
    const ok = await onSave(draft);
    if (ok) setDraft('');
  }

  return (
    <div className={styles.noteComposer}>
      <textarea
        ref={taRef}
        className={styles.noteComposerArea}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a note…"
        disabled={saving}
      />
      <div className={styles.noteComposerActions}>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving || !draft.trim()}>
          Save note
        </Button>
      </div>
    </div>
  );
}

interface ChildNoteEntryProps {
  entry: ThreadJournalCardEntry;
  serverYear: string | null;
  matcher: EntityMatcher;
  threadSlug: string;
  onOpenDay: (date: string) => void;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (body: string) => void;
  onConfirmDelete: () => void;
}

/**
 * A reply card riding as a margin note under its parent — RefCard's visual
 * dialect (accent left border, no who-badge, a "↳ note" label) rather than
 * a full card frame. No long-entry clipping (notes are short by nature) and
 * no "+ note" of its own even when stale — replies don't chain.
 */
function ChildNoteEntry({
  entry,
  serverYear,
  matcher,
  threadSlug,
  onOpenDay,
  editing,
  saving,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onConfirmDelete,
}: ChildNoteEntryProps) {
  const canEdit = entry.editable && entry.who === 'B';
  const bodyHtml = useMemo(
    () => markSelfMentions(highlightEntities(mdToHtml(entry.text), matcher), threadSlug),
    [entry.text, matcher, threadSlug],
  );

  return (
    <div className={`${styles.noteCard} ${editing ? styles.noteCardEditing : ''}`}>
      <div className={styles.noteMeta}>
        <span className={styles.noteLabel}>&#8627; note</span>
        <button type="button" className={styles.noteMetaTime} onClick={() => onOpenDay(entry.date)}>
          {formatDate(entry.date, serverYear)} &middot; {formatTime(entry.ts)}
        </button>
        <span className={styles.metaSpacer} />
        {canEdit && !editing ? (
          <IconButton aria-label="Edit note" onClick={onEdit}>
            &#9998;
          </IconButton>
        ) : null}
      </div>

      {editing ? (
        <EditBlock
          body={entry.text}
          saving={saving}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
          onConfirmDelete={onConfirmDelete}
        />
      ) : (
        <div className={styles.noteBody} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      )}
    </div>
  );
}

function DayRow({
  entry,
  serverYear,
  onOpenDay,
}: {
  entry: ThreadJournalDayEntry;
  serverYear: string | null;
  onOpenDay: (date: string) => void;
}) {
  return (
    <button type="button" className={styles.dayRow} onClick={() => onOpenDay(entry.date)}>
      📅 {formatDate(entry.date, serverYear)}{entry.label ? ` — ${entry.label}` : ''} &rarr;
    </button>
  );
}

/** A day row that HAS excerpts (routes/threads.py's day-blob mention pass):
 * renders like a JournalCardEntry card instead of the dashed placeholder —
 * a meta row (date, non-button here; the citing heading if present), each
 * excerpt as its own highlighted body paragraph, then a full-width footer
 * button to open the whole day. */
function DayExcerptEntry({
  entry,
  serverYear,
  matcher,
  threadSlug,
  onOpenDay,
}: {
  entry: ThreadJournalDayEntry;
  serverYear: string | null;
  matcher: EntityMatcher;
  threadSlug: string;
  onOpenDay: (date: string) => void;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.meta}>
        <span className={styles.metaDate}>📅 {formatDate(entry.date, serverYear)}</span>
        {entry.label ? <span className={styles.metaLabel}>{entry.label}</span> : null}
      </div>
      {entry.excerpts.map((excerpt, i) => (
        <div
          key={i}
          className={`${styles.body} ${i > 0 ? styles.excerptDivider : ''}`}
          dangerouslySetInnerHTML={{
            __html: markSelfMentions(highlightEntities(mdToHtml(excerpt), matcher), threadSlug),
          }}
        />
      ))}
      <button type="button" className={styles.expandBtn} onClick={() => onOpenDay(entry.date)}>
        Open this day &rarr;
      </button>
    </div>
  );
}
