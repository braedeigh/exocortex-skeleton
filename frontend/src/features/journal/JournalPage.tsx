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
import { PersonPopover } from './PersonPopover';
import { resolveDayMode } from './types';
import {
  useDeleteCard,
  useJournalDates,
  useJournalDay,
  usePeople,
  useSaveJournalBlob,
  useServerDate,
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
  const pausePolling = editingCardId !== null || blobFocused;

  const dayQuery = useJournalDay(currentDate, pausePolling);
  const datesQuery = useJournalDates();
  const peopleQuery = usePeople();

  const matcher = useMemo(() => buildEntityMatcher(peopleQuery.data?.people ?? []), [peopleQuery.data]);
  const journalDates = useMemo(() => new Set(datesQuery.data?.dates ?? []), [datesQuery.data]);

  const updateCard = useUpdateCard(currentDate ?? '', push);
  const deleteCard = useDeleteCard(currentDate ?? '', push);
  const saveBlobMutation = useSaveJournalBlob(currentDate ?? '', push);

  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<CalendarMonth | null>(null);
  const [devNotesOpen, setDevNotesOpen] = useState(false);
  const [popoverSlug, setPopoverSlug] = useState<string | null>(null);

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
    const target = (e.target as HTMLElement).closest<HTMLElement>('.entity');
    const slug = target?.dataset.slug;
    if (slug) setPopoverSlug(slug);
  }

  if (!currentDate) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading…</div>
      </div>
    );
  }

  const savingCardId = updateCard.isPending
    ? (updateCard.variables?.id ?? null)
    : deleteCard.isPending
      ? (deleteCard.variables?.id ?? null)
      : null;

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

      <div className={styles.body} ref={bodyRef} onClick={onBodyClick}>
        {dayQuery.isLoading ? (
          <div className={styles.loading}>Loading…</div>
        ) : dayQuery.isError || !bundle ? (
          <div className={styles.error}>Couldn&apos;t load this day.</div>
        ) : mode === 'cards' ? (
          <CardStream
            cards={bundle.cards.cards}
            editingCardId={editingCardId}
            savingCardId={savingCardId}
            matcher={matcher}
            onEdit={setEditingCardId}
            onCancel={() => setEditingCardId(null)}
            onSave={(id, body) => updateCard.mutate({ id, body }, { onSuccess: () => setEditingCardId(null) })}
            onConfirmDelete={(id) => {
              const wasLastCard = bundle.cards.cards.length === 1;
              deleteCard.mutate({ id, wasLastCard }, { onSuccess: () => setEditingCardId(null) });
            }}
          />
        ) : mode === 'empty' ? (
          <div className={styles.empty}>No entries yet.</div>
        ) : (
          <BlobEditor
            key={currentDate}
            initialContent={bundle.journal.content}
            matcher={matcher}
            save={(content) => saveBlobMutation.mutateAsync(content)}
            onFocusChange={setBlobFocused}
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
