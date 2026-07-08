import { Sheet } from '../../ui';
import { entityHue } from './markdown';
import { useBacklinks } from './useJournalData';
import type { Mention } from './types';
import styles from './PersonPopover.module.css';

export interface PersonPopoverProps {
  slug: string | null;
  onClose: () => void;
  onJournalMention: (date: string, slug: string) => void;
}

const FACT_SEEDS = ['relationship', 'age', 'lives', 'work'] as const;

function monthYear(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function PersonPopover({ slug, onClose, onJournalMention }: PersonPopoverProps) {
  const { data, isLoading } = useBacklinks(slug);

  if (!slug) return null;

  const person = data?.person ?? null;
  const stats = data?.stats ?? null;
  const hue = entityHue(person?.id || slug);
  const color = `hsl(${hue} 70% 66%)`;

  const rows: [string, string][] = [];
  if (person) {
    const facts = person.facts || {};
    for (const k of FACT_SEEDS) rows.push([k, (facts[k] || '').trim()]);
    for (const [k, v] of Object.entries(facts)) {
      if (!(FACT_SEEDS as readonly string[]).includes(k) && v && v.trim()) rows.push([k, v.trim()]);
    }
  }

  function mentionNav(m: Mention): void {
    if (m.file.startsWith('Journal/Daily/') && m.date) {
      onJournalMention(m.date, slug as string);
      onClose();
    }
  }

  return (
    <Sheet open={!!slug} onClose={onClose} title={data?.name || slug}>
      {isLoading ? (
        <div className={styles.loading}>Loading…</div>
      ) : (
        <>
          <div className={styles.headLine} style={{ color }}>
            {person?.aliases?.length ? <span className={styles.aliases}>{person.aliases.join(', ')}</span> : null}
            {stats?.first_date && stats?.last_date ? (
              <span className={styles.range}>
                {monthYear(stats.first_date)} &ndash; {monthYear(stats.last_date)}
                {typeof stats.days === 'number' ? ` · ${stats.days} days` : ''}
              </span>
            ) : null}
          </div>

          {person?.blurb ? <p className={styles.blurb}>{person.blurb}</p> : null}

          {person ? (
            <div className={styles.facts}>
              {rows.map(([k, v]) => (
                <div className={styles.factRow} key={k}>
                  <span className={styles.factLabel}>{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                  <span className={v ? styles.factVal : styles.factEmpty}>{v || '—'}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className={styles.mentions}>
            {(data?.mentions || []).slice(0, 3).map((m, i) => {
              const isJournal = m.file.startsWith('Journal/Daily/') && !!m.date;
              const content = (
                <>
                  <span className={styles.mentionDate}>{m.label || m.date}</span>
                  {m.snippet ? <span className={styles.mentionSnip}>{m.snippet}</span> : null}
                </>
              );
              return isJournal ? (
                <button type="button" key={i} className={styles.mentionRow} onClick={() => mentionNav(m)}>
                  {content}
                </button>
              ) : (
                <a key={i} className={styles.mentionRow} href={`/keeper#${encodeURIComponent(m.file)}`}>
                  {content}
                </a>
              );
            })}
            {!data?.mentions?.length ? <div className={styles.emptyMentions}>No references recorded yet.</div> : null}
            {!person ? <div className={styles.emptyMentions}>No file yet.</div> : null}
          </div>

          {person ? (
            <a className={styles.openPerson} href={`/person/${person.id}`}>
              Open person page &rarr;
            </a>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
