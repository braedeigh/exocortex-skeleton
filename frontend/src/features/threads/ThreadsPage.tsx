import { Fragment, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { useThread, useThreads } from '../journal/useJournalData';
import { sendThreadToChat, talkLabel, type TalkState } from '../journal/threadTalk';
import type { ThreadSource } from '../journal/types';
import styles from './ThreadsPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * The dedicated Threads page (/threads) — the journal rail's Threads button
 * lands here. Every thread from tulku/Threads/*.md as an expandable card;
 * the expanded body is the same fact-card view the ThreadPopover shows
 * (sections, ≤3-line statements, routable source chips), plus the talk /
 * open-file actions. One thread expanded at a time, first one open on
 * arrival so the page never greets her blank.
 */
export function ThreadsPage() {
  const { data, isLoading, isError } = useThreads();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Until she taps, the first thread starts open; after a tap her choice wins.
  const [touched, setTouched] = useState(false);

  const threads = (data?.threads ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const openId = touched ? expanded : (expanded ?? threads[0]?.id ?? null);

  function toggle(id: string) {
    setTouched(true);
    setExpanded((cur) => (cur === id ? null : id));
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Threads</h1>
      {isLoading ? <div className={styles.empty}>Loading…</div> : null}
      {isError && !data ? <div className={styles.empty}>Couldn’t load threads.</div> : null}
      {!isLoading && !threads.length && !isError ? <div className={styles.empty}>No threads yet.</div> : null}

      {threads.map((t) => {
        const open = openId === t.id;
        return (
          <section key={t.id} className={styles.threadCard}>
            <button
              type="button"
              className={styles.threadHeader}
              aria-expanded={open}
              onClick={() => toggle(t.id)}
            >
              <span className={styles.threadName}>⧉ {t.name}</span>
              <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
            </button>
            {open ? <ThreadBody id={t.id} /> : null}
          </section>
        );
      })}
    </div>
  );
}

/** The expanded body of one thread — fetched on first expand via useThread. */
function ThreadBody({ id }: { id: string }) {
  const { data, isLoading, isError } = useThread(id);
  const navigate = useNavigate();
  const [talkState, setTalkState] = useState<TalkState>('idle');

  async function talk() {
    if (talkState === 'sending') return;
    setTalkState('sending');
    try {
      await sendThreadToChat(id);
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        setTalkState('sent');
      } else {
        void navigate({ to: '/chat' });
      }
    } catch {
      setTalkState('error');
    }
  }

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      void navigate({ to: '/journal', search: { date: s.val } });
    }
  }

  if (isLoading) return <div className={styles.bodyNote}>Loading…</div>;
  if (!data) return <div className={styles.bodyNote}>{isError ? 'Couldn’t load this thread.' : 'No thread found.'}</div>;

  let lastHeading: string | null = null;

  return (
    <div className={styles.body}>
      {data.status ? <div className={styles.status}>{data.status}</div> : null}
      {data.cards.length === 0 ? <div className={styles.bodyNote}>No facts recorded yet.</div> : null}

      {data.cards.map((c, i) => {
        const showHeading = !!c.heading && c.heading !== lastHeading;
        lastHeading = c.heading || lastHeading;
        return (
          <Fragment key={i}>
            {showHeading ? <div className={styles.section}>{c.heading}</div> : null}
            <div className={styles.factCard}>
              {c.text ? <div className={styles.factText}>{c.text}</div> : null}
              {c.sources.length > 0 ? (
                <div className={styles.sources}>
                  {c.sources.map((s, j) =>
                    s.kind === 'keeper' ? (
                      <a key={j} className={styles.sourceChip} href={`/files?path=${encodeURIComponent(s.val)}`}>
                        {s.label} &rarr;
                      </a>
                    ) : (
                      <button key={j} type="button" className={styles.sourceChip} onClick={() => sourceClick(s)}>
                        {s.label} &rarr;
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </Fragment>
        );
      })}

      {!isPublicMode() ? (
        <button type="button" className={styles.talkBtn} onClick={talk} disabled={talkState === 'sending'}>
          {talkLabel(talkState)}
        </button>
      ) : null}

      {data.file ? (
        <a className={styles.openFull} href={`/files?path=${encodeURIComponent(data.file)}`}>
          Open full thread &rarr;
        </a>
      ) : null}
    </div>
  );
}
