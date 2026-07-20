import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSessionsContext } from '../../shell/SessionsContext';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import type { EntityMatcher } from '../journal/entityHighlight';
import { buildEntityMatcher, highlightEntities } from '../journal/entityHighlight';
import { mdToHtml } from '../journal/markdown';
import { startThreadTalk, talkLabel, type TalkState } from '../journal/threadTalk';
import type { ThreadJournalCardEntry, ThreadJournalDayEntry } from '../journal/types';
import { usePeople, useServerDate, useThreadJournal, useThreads } from '../journal/useJournalData';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import styles from './ThreadJournalPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
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

export interface ThreadJournalPageProps {
  slug: string;
}

/**
 * The dedicated per-thread journal page (/threads/$slug) — where "Open full
 * thread" from the Threads page / journal's ThreadPopover lands: every
 * journal record tied to the thread (tagged pool cards ∪ cited sources,
 * routes/threads.py thread_journal), oldest first, read-only.
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

  const serverYear = serverDateData?.server_date ? serverDateData.server_date.slice(0, 4) : null;

  const matcher = useMemo(
    () => buildEntityMatcher(peopleData?.people ?? [], threadsData?.threads ?? []),
    [peopleData, threadsData],
  );

  function goToDay(date: string) {
    void navigate({ to: '/journal', search: { date } });
  }

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

  return (
    <div className={styles.page}>
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

          <div className={styles.entries}>
            {entries.length === 0 ? (
              <div className={styles.empty}>No journal entries linked yet.</div>
            ) : (
              entries.map((e) =>
                e.kind === 'card' ? (
                  <JournalCardEntry
                    key={`card-${e.id}`}
                    entry={e}
                    serverYear={serverYear}
                    matcher={matcher}
                    onOpenDay={goToDay}
                  />
                ) : (
                  <DayRow key={`day-${e.date}`} entry={e} serverYear={serverYear} onOpenDay={goToDay} />
                ),
              )
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function JournalCardEntry({
  entry,
  serverYear,
  matcher,
  onOpenDay,
}: {
  entry: ThreadJournalCardEntry;
  serverYear: string | null;
  matcher: EntityMatcher;
  onOpenDay: (date: string) => void;
}) {
  const bodyHtml = useMemo(() => highlightEntities(mdToHtml(entry.text), matcher), [entry.text, matcher]);
  const isK = entry.who === 'K';

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
