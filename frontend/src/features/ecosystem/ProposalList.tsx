/**
 * ProposalList.tsx — draws the machine's suggested sources for where a food
 * comes from. Each one wears two labels: "not approved by you" (always — none
 * of them are hers yet) and its check status (not checked yet / checked by
 * machine, not by you / failed the check, with the checker's reason). Failed
 * ones are shown too, on purpose, so she can see what was tried.
 *
 * Under a fold: the evidence behind it (each piece with its own check), and a
 * multi-ingredient product's parts. Used by the food's page (FoodPage.tsx)
 * and the review list (ReviewPage.tsx).
 *
 * Touches: ./proposals.ts (shape + words), ./FoodArea.module.css.
 *
 * Prompt that produced it: proposals shown "in the research files … just
 * display them for now and show that they're unapproved by me … show no
 * matter what".
 */
import { CHECK_WORDS, type EcoProposal, type ProposalCheck } from './proposals';
import styles from './FoodArea.module.css';

const CHECK_BADGE: Record<ProposalCheck, string> = {
  unchecked: styles.badgeUnchecked,
  passed: styles.badgePassed,
  failed: styles.badgeFailed,
};

export function ProposalList({ proposals }: { proposals: EcoProposal[] }) {
  if (!proposals.length) return null;
  return (
    <div>
      {proposals.map((proposal) => (
        <ProposalItem key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
}

function ProposalItem({ proposal }: { proposal: EcoProposal }) {
  // Say where it is in one line: the region, the country, how many counties.
  const where = [
    proposal.region_name,
    proposal.country,
    proposal.counties.length ? `${proposal.counties.length} USDA count${proposal.counties.length === 1 ? 'y' : 'ies'}` : null,
    proposal.geo_source ? `placed by ${proposal.geo_source}` : null,
  ].filter(Boolean);

  return (
    <div className={`${styles.proposal} ${proposal.check_status === 'failed' ? styles.proposalFailed : ''}`}>
      <div className={styles.proposalHead}>
        <span className={styles.proposalName}>{proposal.name}</span>
        <span className={`${styles.badge} ${styles.badgeUnapproved}`}>not approved by you</span>
        <span className={`${styles.badge} ${CHECK_BADGE[proposal.check_status]}`}>{CHECK_WORDS[proposal.check_status]}</span>
      </div>
      {proposal.amends_source_id ? <div className={styles.meta}>a suggested fix to one of your sources</div> : null}
      {where.length ? <div className={styles.meta}>{where.join(' · ')}</div> : null}
      {proposal.summary ? <p className={styles.proposalText}>{proposal.summary}</p> : null}
      {proposal.check_reason ? <div className={styles.reason}>Checker: {proposal.check_reason}</div> : null}

      {proposal.evidence.length || proposal.parts.length ? (
        <details className={styles.details}>
          <summary>
            {proposal.evidence.length} piece{proposal.evidence.length === 1 ? '' : 's'} of evidence
            {proposal.parts.length ? ` · ${proposal.parts.length} ingredients` : ''}
          </summary>
          {proposal.evidence.length ? (
            <ul className={styles.evidenceList}>
              {proposal.evidence.map((entry) => (
                <li key={entry.entry_id}>
                  <span className={`${styles.badge} ${CHECK_BADGE[entry.check_status]}`}>{entry.role}</span>{' '}
                  {entry.url ? (
                    <a href={entry.url} target="_blank" rel="noopener noreferrer" className={styles.evidenceLink}>
                      {entry.text || entry.url} ↗
                    </a>
                  ) : (
                    entry.text
                  )}
                  {entry.check_reason ? <div className={styles.meta}>{entry.check_reason}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {proposal.parts.length ? (
            <ul className={styles.evidenceList}>
              {proposal.parts.map((part) => (
                <li key={part.seq}>
                  <b>{part.ingredient}</b>
                  {part.place ? ` — ${part.place}` : ''}
                  {part.health_concern ? <div className={styles.meta}>concern: {part.health_concern}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
