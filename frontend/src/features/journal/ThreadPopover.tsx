import { Fragment } from 'react';
import { Sheet } from '../../ui';
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

  if (!id) return null;

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      onClose();
      onNavigateDate(s.val);
    }
  }

  const cards = data?.cards ?? [];
  let lastHeading: string | null = null;

  return (
    <Sheet open={!!id} onClose={onClose} title={`⧉ ${data?.name ?? 'Thread'}`}>
      {isLoading ? (
        <div className={styles.loading}>Loading…</div>
      ) : isError || !data ? (
        <div className={styles.loading}>No thread found.</div>
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
                          <a key={j} className={styles.sourceChip} href={`/keeper#${encodeURIComponent(s.val)}`}>
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

          {data.file ? (
            <a className={styles.openFull} href={`/keeper#${encodeURIComponent(data.file)}`}>
              Open full thread &rarr;
            </a>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
