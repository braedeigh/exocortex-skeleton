import { Fragment, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { api } from '../../api/client';
import { DESKTOP_QUERY } from '../../shell/useMediaQuery';
import { useThread } from './useJournalData';
import type { ThreadSource } from './types';
import styles from './ThreadPopover.module.css';

/** Where the "Talk about this" send lands — the Keeper's session. */
const TALK_SESSION = 'chat';

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
  const [talkState, setTalkState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  if (!id) return null;

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      onClose();
      onNavigateDate(s.val);
    }
  }

  /**
   * Type `/thread <id>` into the Keeper's tmux session — the vault-side
   * slash command (claude-commands/thread.md) has the session read the
   * thread file plus every source it links, then open a conversation.
   * Slash commands are exempt from journal capture (routes/terminal.py),
   * so this boilerplate is never minted as her words. On mobile, jump to
   * the Chat tab; on desktop the terminal is already docked in the split
   * pane (and /chat would bounce to '/'), so stay put and show "sent".
   */
  async function talkAboutThread() {
    if (talkState === 'sending') return;
    setTalkState('sending');
    try {
      await api.post('/api/terminal/send', { text: `/thread ${id}`, enter: true, session: TALK_SESSION });
      if (window.matchMedia(DESKTOP_QUERY).matches) {
        setTalkState('sent');
      } else {
        onClose();
        navigate({ to: '/chat' });
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
              {talkState === 'sending'
                ? 'Sending…'
                : talkState === 'sent'
                  ? 'Sent to chat ✓'
                  : talkState === 'error'
                    ? 'Couldn’t reach the terminal — tap to retry'
                    : '💬 Talk about this thread'}
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
