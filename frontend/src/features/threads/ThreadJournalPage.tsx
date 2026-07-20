import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSessionsContext } from '../../shell/SessionsContext';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { Button, ToastStack } from '../../ui';
import type { EntityMatcher } from '../journal/entityHighlight';
import { buildEntityMatcher, highlightEntities } from '../journal/entityHighlight';
import { mdToHtml } from '../journal/markdown';
import { startThreadTalk, talkLabel, type TalkState } from '../journal/threadTalk';
import type { ThreadJournalCardEntry, ThreadJournalDayEntry, ThreadJournalEntry } from '../journal/types';
import {
  useAddThreadEntry,
  usePeople,
  useServerDate,
  useThreadJournal,
  useThreads,
  useToasts,
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

  const today = serverDateData?.server_date ?? null;
  const serverYear = today ? today.slice(0, 4) : null;
  const addEntry = useAddThreadEntry(slug, today, push);

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
        window.dispatchEvent(new CustomEvent('exo:set-session', { detail: res.session }));
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

  async function handleComposerSave(body: string): Promise<boolean> {
    try {
      await addEntry.mutateAsync(body);
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
              displayedEntries.map((e) =>
                e.kind === 'card' ? (
                  <JournalCardEntry
                    key={`card-${e.id}`}
                    entry={e}
                    serverYear={serverYear}
                    matcher={matcher}
                    mentionRegex={mentionRegex}
                    threadSlug={slug}
                    onOpenDay={goToDay}
                  />
                ) : e.excerpts.length > 0 ? (
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
              )
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
            💬 Add &amp; talk
          </Button>
        </div>
      </div>
    </div>
  );
}

function JournalCardEntry({
  entry,
  serverYear,
  matcher,
  mentionRegex,
  threadSlug,
  onOpenDay,
}: {
  entry: ThreadJournalCardEntry;
  serverYear: string | null;
  matcher: EntityMatcher;
  mentionRegex: RegExp | null;
  threadSlug: string;
  onOpenDay: (date: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isK = entry.who === 'K';

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
    <div className={styles.card}>
      <div className={styles.meta}>
        <span className={`${styles.who} ${isK ? styles.who_K : styles.who_B}`}>{entry.who}</span>
        <button type="button" className={styles.metaTime} onClick={() => onOpenDay(entry.date)}>
          {formatDate(entry.date, serverYear)} &middot; {formatTime(entry.ts)}
        </button>
      </div>
      <div
        className={`${styles.body} ${isK ? styles.body_K : ''}`}
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
      {clipped ? (
        <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less ▴' : 'Show full entry ▾'}
        </button>
      ) : null}
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
