import { sessionLocation } from '../observatory/sessionLocation';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ToastStack } from '../../ui';
import { entityHue, mdToHtml } from '../journal/markdown';
import { useToasts } from '../journal/useJournalData';
import { FactsSection } from './FactsSection';
import { Heatmap } from './Heatmap';
import { ReceiptsSection } from './ReceiptsSection';
import { monthYear, storyText, type ReceiptNav } from './personLogic';
import { usePerson, useSummarize } from './usePersonData';
import styles from './PersonPage.module.css';

export interface PersonPageProps {
  slug: string;
}

/**
 * The deep single-person view — native port of templates/person.html +
 * static/js/person.js (/person/<slug>): sticky header (name, tags, date
 * range, Open file), inline-editable Facts, the activity heat map,
 * Impression (+ Regenerate), Story, Receipts. One fetch feeds the whole
 * page (/api/person/<slug>, routes/person.py).
 */
export function PersonPage({ slug }: PersonPageProps) {
  const { data, isLoading, isError } = usePerson(slug);
  const { toasts, push, dismiss } = useToasts();
  const navigate = useNavigate();

  const person = data?.person ?? null;

  // The old page set document.title to the person's name; restore on leave
  // since the SPA shares one document across tabs.
  useEffect(() => {
    if (!person?.name) return;
    const prev = document.title;
    document.title = person.name;
    return () => {
      document.title = prev;
    };
  }, [person?.name]);

  const summarize = useSummarize(
    slug,
    (result) => {
      // The impression is drafted in a Reading Room helper session now (no
      // tmux pane to switch to) — go straight to it; the talk-through
      // happens there.
      if (result.conversation_id) {
        void navigate(sessionLocation(result.conversation_id));
      } else {
        push('Claude is drafting — find it under Helpers in the Observatory.', {
          tone: 'info',
          duration: 8000,
        });
      }
    },
    push,
  );

  function goJournal(date: string) {
    void navigate({ to: '/journal', search: { date } });
  }

  function goKeeper(path: string) {
    // Integration contract: the keeper browser (ported concurrently) reads
    // /files?path=<vault-relative path>. Typechecks once that route declares
    // its `path` search param.
    void navigate({ to: '/files', search: { path } });
  }

  function onReceiptNav(nav: ReceiptNav) {
    if (nav.kind === 'journal') goJournal(nav.date);
    else goKeeper(nav.path);
  }

  if (isLoading || (!data && !isError)) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.loading}>Loading&hellip;</div>
        </div>
      </div>
    );
  }

  // Inline error only when there's nothing cached to show — a failed
  // background refetch keeps rendering the last good data.
  if (!data || !person) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.loading}>Couldn&rsquo;t load this person.</div>
        </div>
      </div>
    );
  }

  const stats = data.stats;
  const hue = entityHue(person.id || slug);
  const color = `hsl(${hue} 70% 66%)`;
  const hasDates = !!(stats?.first_date && stats?.last_date);
  const impression = (person.impression || '').trim();
  const story = storyText(person.body);

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <Link to="/journal" className={styles.backLink}>
            &larr; Journal
          </Link>
          <div className={styles.name} style={{ color }}>
            {person.name || slug}
          </div>
          <div className={styles.meta}>
            {person.tags?.map((t) => (
              <span key={t} className={styles.tag}>
                #{t}
              </span>
            ))}
            {person.tags?.length && hasDates ? <span className={styles.metaSep}>&middot;</span> : null}
            {hasDates ? (
              <span className={styles.dates}>
                {monthYear(stats.first_date)} &ndash; {monthYear(stats.last_date)}
              </span>
            ) : null}
          </div>
          {person.file ? (
            <div className={styles.headerActions}>
              <button type="button" className={styles.btn} onClick={() => goKeeper(person.file)}>
                Open file
              </button>
            </div>
          ) : null}
        </div>

        <div className={styles.duo}>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Facts</div>
            <FactsSection slug={slug} facts={person.facts || {}} onError={push} />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>Activity</div>
            <Heatmap days={data.days || []} hue={hue} onSelectDate={goJournal} />
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Impression</div>
          {impression ? (
            <div className={styles.mdBody} dangerouslySetInnerHTML={{ __html: mdToHtml(impression) }} />
          ) : (
            <p className={styles.empty}>No impression written yet.</p>
          )}
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.btn}
              disabled={summarize.isPending}
              onClick={() => summarize.mutate()}
            >
              {summarize.isPending ? 'Regenerating…' : 'Regenerate impression'}
            </button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Story</div>
          {story ? (
            <div className={styles.mdBody} dangerouslySetInnerHTML={{ __html: mdToHtml(story) }} />
          ) : (
            <p className={styles.empty}>Nothing written yet.</p>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Receipts</div>
          <ReceiptsSection
            entries={person.entries || []}
            mentions={data.mentions || []}
            cardView={data.card_view}
            onNav={onReceiptNav}
          />
        </div>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
