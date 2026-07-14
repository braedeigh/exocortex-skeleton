import { Fragment, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { sendThreadToChat, talkLabel, type TalkState } from './threadTalk';
import { useThread } from './useJournalData';
import type { ThreadSource } from './types';
import styles from './ThreadPopover.module.css';

export interface ThreadPopoverProps {
  /** Thread id (slug) to show, or null when closed. */
  id: string | null;
  onClose: () => void;
  /** Navigate the journal to a date — same mechanism as prev/next/calendar. */
  onNavigateDate: (date: string) => void;
}

/**
 * Thread/group popover — port of journal.html's openThreadPopover()/
 * renderThreadPopover(). Fact-cards grouped under their `## Heading`
 * sections, each a ≤3-line statement plus source chips. Chips route the
 * same way the person popover's mentions do: journal sources jump in-app,
 * keeper sources open the Files tab (direct /keeper# link, matching
 * RefCard/PersonPopover rather than the legacy postMessage bridge).
 */
export function ThreadPopover({ id, onClose, onNavigateDate }: ThreadPopoverProps) {
  const { data, isLoading, isError } = useThread(id);
  const navigate = useNavigate();
  const [talkState, setTalkState] = useState<TalkState>('idle');

  if (!id) return null;

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      onClose();
      onNavigateDate(s.val);
    }
  }

  /**
   * Send `/thread <id>` to the Keeper's session (threadTalk.ts). On mobile,
   * jump to the Chat tab; on desktop the terminal is already docked in the
   * split pane (and /chat would bounce to '/'), so stay put and show "sent".
   */
  async function talkAboutThread() {
    if (talkState === 'sending') return;
    setTalkState('sending');
    try {
      await sendThreadToChat(id!);
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        setTalkState('sent');
      } else {
        onClose();
        void navigate({ to: '/chat' });
      }
    } catch {
      setTalkState('error');
    }
  }

  const cards = data?.cards ?? [];
  let lastHeading: string | null = null;

  return (
    <Sheet open={!!id} onClose={onClose} title={`⧉ ${data?.name ?? 'Thread'}`}>
      {isLoading ? (
        <div className={styles.loading}>Loading…</div>
      ) : !data ? (
        // Cached data survives a failed refetch — only a truly empty result
        // shows this (a fetch error without data lands here too).
        <div className={styles.loading}>{isError ? 'Couldn’t load this thread.' : 'No thread found.'}</div>
      ) : (
        <>
          {data.status ? <div className={styles.status}>{data.status}</div> : null}

          {cards.length === 0 ? <div className={styles.empty}>No facts recorded yet.</div> : null}

          {cards.map((c, i) => {
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

          {window.VIEW_MODE !== 'public' ? (
            <button
              type="button"
              className={styles.talkBtn}
              onClick={talkAboutThread}
              disabled={talkState === 'sending'}
            >
              {talkLabel(talkState)}
            </button>
          ) : null}

          {data.file ? (
            <a className={styles.openFull} href={`/files?path=${encodeURIComponent(data.file)}`}>
              Open full thread &rarr;
            </a>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
