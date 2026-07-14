import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ToastStack } from '../../ui';
import { BlobEditor } from './BlobEditor';
import { CalendarOverlay } from './CalendarOverlay';
import type { CalendarMonth } from './calendarMath';
import { CardStream } from './CardStream';
import { DevNotesPanel } from './DevNotesPanel';
import './entities.css';
import { buildEntityMatcher } from './entityHighlight';
import { FindBar } from './FindBar';
import { JournalHeader } from './JournalHeader';
import { JournalRail } from './JournalRail';
import { PersonPopover } from './PersonPopover';
import { ThreadPopover } from './ThreadPopover';
import { resolveDayMode } from './types';
import {
  useAddCard,
  useDeleteCard,
  useJournalDates,
  useJournalDay,
  usePeople,
  useSaveJournalBlob,
  useServerDate,
  useThreads,
  useToasts,
  useUpdateCard,
} from './useJournalData';
import styles from './JournalPage.module.css';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PendingFind {
  date: string;
  slug: string;
}

interface FindState {
  slug: string;
  name: string;
  current: number;
  total: number;
}

export function JournalPage() {
  const search = useSearch({ from: '/journal' });
  const navigate = useNavigate({ from: '/journal' });

  const serverDateQuery = useServerDate();
  const serverDate = serverDateQuery.data?.server_date ?? null;

  const currentDate = search.date && DATE_RE.test(search.date) ? search.date : serverDate;

  // No ?date in the URL yet — once we know "today" (server timezone is truth), reflect it.
  useEffect(() => {
    if (!search.date && serverDate) {
      void navigate({ search: { date: serverDate }, replace: true });
    }
  }, [search.date, serverDate, navigate]);

  function goTo(date: string) {
    void navigate({ search: { date } });
  }

  const { toasts, push, dismiss } = useToasts();

  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [blobFocused, setBlobFocused] = useState(false);
  // Mirrors the bottom composer's focused-or-has-draft state (reported via
  // CardStream's onBottomActiveChange) — it's always mounted, so it can't be
  // tracked with open/closed state like an editing card.
  const [bottomComposerActive, setBottomComposerActive] = useState(false);
  // Cards mid "removed · Undo" toast — hidden from the stream immediately but
  // not actually deleted server-side until the toast's timer fires (or the
  // whole page unmounts). Undo just clears the pending id; nothing was ever
  // sent to the server.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const deleteTimers = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; wasLastCard: boolean }>>({});
  const pausePolling = editingCardId !== null || blobFocused || bottomComposerActive;

  const dayQuery = useJournalDay(currentDate, pausePolling);
  const datesQuery = useJournalDates();
  const peopleQuery = usePeople();
  const threadsQuery = useThreads();

  const matcher = useMemo(
    () => buildEntityMatcher(peopleQuery.data?.people ?? [], threadsQuery.data?.threads ?? []),
    [peopleQuery.data, threadsQuery.data],
  );
  const journalDates = useMemo(() => new Set(datesQuery.data?.dates ?? []), [datesQuery.data]);

  const updateCard = useUpdateCard(currentDate ?? '', push);
  const deleteCard = useDeleteCard(currentDate ?? '', push);
  const addCard = useAddCard(currentDate ?? '', push);
  const saveBlobMutation = useSaveJournalBlob(currentDate ?? '', push);

  const UNDO_DELETE_MS = 5000;

  /** Delete confirmed — hide the card immediately, but don't actually call the
   * API yet. A "Removed · Undo" toast gives her UNDO_DELETE_MS to change her
   * mind; only once that elapses (or Undo isn't tapped) does the real
   * deleteCard mutation fire. */
  function requestDeleteCard(id: string, wasLastCard: boolean) {
    setPendingDeleteIds((cur) => new Set(cur).add(id));
    setEditingCardId((cur) => (cur === id ? null : cur));
    deleteTimers.current[id] = { timer: setTimeout(() => finalizeDelete(id), UNDO_DELETE_MS), wasLastCard };
    push('Entry removed', {
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => cancelPendingDelete(id),
      duration: UNDO_DELETE_MS,
    });
  }

  function finalizeDelete(id: string) {
    const pending = deleteTimers.current[id];
    delete deleteTimers.current[id];
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    deleteCard.mutate({ id, wasLastCard: pending?.wasLastCard ?? false });
  }

  function cancelPendingDelete(id: string) {
    const pending = deleteTimers.current[id];
    if (pending) {
      clearTimeout(pending.timer);
      delete deleteTimers.current[id];
    }
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  }

  // Page unmounting (navigating away from the journal entirely) — commit any
  // still-pending deletes rather than silently dropping them; the undo
  // window only makes sense while she can still see the toast.
  useEffect(() => {
    return () => {
      for (const id of Object.keys(deleteTimers.current)) finalizeDelete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<CalendarMonth | null>(null);
  const [devNotesOpen, setDevNotesOpen] = useState(false);
  const [popoverSlug, setPopoverSlug] = useState<string | null>(null);
  const [threadPopoverId, setThreadPopoverId] = useState<string | null>(null);
  // Day just seeded via "Start today's page" — mount its BlobEditor in edit
  // mode with the cursor ready (legacy startToday() switched to Edit + focused).
  const [seededDate, setSeededDate] = useState<string | null>(null);

  const [pendingFind, setPendingFind] = useState<PendingFind | null>(null);
  const [findState, setFindState] = useState<FindState | null>(null);
  const findMatchesRef = useRef<HTMLElement[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const bundle = dayQuery.data;
  const mode = bundle ? resolveDayMode(bundle) : null;

  function openCalendar() {
    if (currentDate) {
      const [y, m] = currentDate.split('-').map(Number);
      setCalendarMonth({ year: y, month: m - 1 });
    }
    setCalendarOpen(true);
  }

  function closeFind() {
    for (const el of findMatchesRef.current) el.classList.remove('find-current');
    findMatchesRef.current = [];
    setFindState(null);
  }

  function showFindMatch(i: number) {
    const matches = findMatchesRef.current;
    matches.forEach((el) => el.classList.remove('find-current'));
    const el = matches[i];
    if (!el) return;
    el.classList.add('find-current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function runFind(slug: string) {
    closeFind();
    if (!bodyRef.current) return;
    const matches = Array.from(bodyRef.current.querySelectorAll<HTMLElement>(`.entity[data-slug="${slug}"]`));
    if (!matches.length) return; // referenced by role only (e.g. "my landlord") — nothing to land on
    findMatchesRef.current = matches;
    showFindMatch(0);
    setFindState({ slug, name: matches[0].textContent || slug, current: 1, total: matches.length });
  }

  function findNext(dir: number) {
    const matches = findMatchesRef.current;
    if (!matches.length || !findState) return;
    const next = (findState.current - 1 + dir + matches.length) % matches.length;
    showFindMatch(next);
    setFindState({ ...findState, current: next + 1 });
  }

  // Land on the first mention once the target day has rendered.
  useEffect(() => {
    if (!pendingFind || !bundle || currentDate !== pendingFind.date || dayQuery.isFetching) return;
    const slug = pendingFind.slug;
    setPendingFind(null);
    requestAnimationFrame(() => runFind(slug));
  }, [pendingFind, bundle, currentDate, dayQuery.isFetching]);

  function onJournalMention(date: string, slug: string) {
    closeFind();
    setPendingFind({ date, slug });
    goTo(date);
  }

  function onBodyClick(e: MouseEvent<HTMLDivElement>) {
    // Threads first (their spans are .entity.entity-thread, so a plain
    // .entity check would swallow them) — same order as the legacy handler.
    const threadEl = (e.target as HTMLElement).closest<HTMLElement>('.entity-thread');
    const threadId = threadEl?.dataset.thread;
    if (threadId) {
      setThreadPopoverId(threadId);
      return;
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>('.entity');
    const slug = target?.dataset.slug;
    if (slug) setPopoverSlug(slug);
  }

  /** Seed today's page with the standard header (what the keeper would write)
   * so a journal day can start without a keeper session — port of legacy
   * startToday(). The save invalidates the day query; the refetched content
   * flips the day into blob mode, where `seededDate` mounts it in edit mode. */
  function startToday() {
    if (!currentDate) return;
    const seed = `# ${currentDate}\n\n\`B = Bradie | K = Keeper\`\n\n---\n\n`;
    saveBlobMutation.mutate(seed, { onSuccess: () => setSeededDate(currentDate) });
  }

  if (!currentDate) {
    // No ?date and the server-date fetch failed — say so instead of a
    // permanent "Loading…".
    return (
      <div className={styles.page}>
        {serverDateQuery.isError ? (
          <div className={styles.error}>Couldn&apos;t load the journal.</div>
        ) : (
          <div className={styles.loading}>Loading…</div>
        )}
      </div>
    );
  }

  const savingCardId = updateCard.isPending
    ? (updateCard.variables?.id ?? null)
    : deleteCard.isPending
      ? (deleteCard.variables?.id ?? null)
      : null;

  // Cards not currently sitting behind a pending "Removed · Undo" toast.
  const visibleCards = bundle ? bundle.cards.cards.filter((c) => !pendingDeleteIds.has(c.id)) : [];

  return (
    <div className={styles.page}>
      <JournalHeader
        date={currentDate}
        prev={bundle?.journal.prev ?? null}
        next={bundle?.journal.next ?? null}
        isToday={!!serverDate && currentDate === serverDate}
        onPrev={() => bundle?.journal.prev && goTo(bundle.journal.prev)}
        onNext={() => bundle?.journal.next && goTo(bundle.journal.next)}
        onToday={() => serverDate && goTo(serverDate)}
        onOpenCalendar={openCalendar}
        onOpenDevNotes={() => setDevNotesOpen(true)}
      />

      <JournalRail onOpenPerson={setPopoverSlug} onOpenThread={setThreadPopoverId} onError={push} />

      <div className={styles.body} ref={bodyRef} onClick={onBodyClick}>
        {dayQuery.isLoading ? (
          <div className={styles.loading}>Loading…</div>
        ) : !bundle ? (
          // Error only when there's nothing to show — a failed background poll
          // (dayQuery.isError with data still cached) must not blank a working day.
          <div className={styles.error}>Couldn&apos;t load this day.</div>
        ) : mode === 'cards' ? (
          <CardStream
            cards={visibleCards}
            editingCardId={editingCardId}
            savingCardId={savingCardId}
            matcher={matcher}
            onEdit={setEditingCardId}
            onCancel={() => setEditingCardId(null)}
            onSave={(id, body) => updateCard.mutate({ id, body }, { onSuccess: () => setEditingCardId(null) })}
            onConfirmDelete={(id) => requestDeleteCard(id, visibleCards.length === 1)}
            onNavigateDate={goTo}
            onPersonClick={setPopoverSlug}
            addSaving={addCard.isPending}
            onComposeSave={async (body) => {
              try {
                await addCard.mutateAsync({ position: 'bottom', body });
                return true;
              } catch {
                return false;
              }
            }}
            onBottomActiveChange={setBottomComposerActive}
          />
        ) : mode === 'empty' ? (
          <div className={styles.empty}>
            No entries yet.
            {serverDate && currentDate === serverDate ? (
              <button
                type="button"
                className={styles.startDay}
                onClick={startToday}
                disabled={saveBlobMutation.isPending}
              >
                &#9999;&#65039; Start today&apos;s page
              </button>
            ) : null}
          </div>
        ) : (
          <BlobEditor
            key={currentDate}
            initialContent={bundle.journal.content}
            matcher={matcher}
            save={(content) => saveBlobMutation.mutateAsync(content)}
            onFocusChange={setBlobFocused}
            initialMode={seededDate === currentDate ? 'edit' : 'read'}
          />
        )}
      </div>

      {calendarMonth ? (
        <CalendarOverlay
          open={calendarOpen}
          onClose={() => setCalendarOpen(false)}
          month={calendarMonth}
          onMonthChange={setCalendarMonth}
          journalDates={journalDates}
          today={serverDate ?? currentDate}
          selected={currentDate}
          onSelect={(date) => {
            setCalendarOpen(false);
            goTo(date);
          }}
        />
      ) : null}

      <DevNotesPanel open={devNotesOpen} onClose={() => setDevNotesOpen(false)} onError={push} />

      <PersonPopover slug={popoverSlug} onClose={() => setPopoverSlug(null)} onJournalMention={onJournalMention} />

      <ThreadPopover id={threadPopoverId} onClose={() => setThreadPopoverId(null)} onNavigateDate={goTo} />

      {findState ? (
        <FindBar
          name={findState.name}
          current={findState.current}
          total={findState.total}
          onPrev={() => findNext(-1)}
          onNext={() => findNext(1)}
          onClose={closeFind}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
