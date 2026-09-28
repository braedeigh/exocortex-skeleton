/**
 * ReviewPage.tsx — /food/review: every suggested source the machine has made
 * and she hasn't approved, grouped by food, busiest food first. A row of
 * filters narrows it by check status; `?food=<id>` narrows it to one food
 * (a food page's "N waiting" chip opens it that way); the Food search box
 * (./foodSearch.ts) narrows it to suggestions for matching foods or recipes,
 * or whose own name or summary matches.
 *
 * Only shows and labels them for now — approving or turning one down comes
 * later. Data: `eco_proposals` and `eco_foods` on /api/data/ecosystem.
 *
 * Touches: ./useEcosystemData.ts, ./proposals.ts, ./foodSearch.ts, ./ProposalList.tsx,
 * ./FoodNav.tsx, ./FoodArea.module.css, ../research/ResearchPage.module.css
 * (the page frame the other Food pages wear).
 *
 * Prompt that produced it: research proposals shown on each food's page "and
 * also a review queue" — both.
 */
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { FoodNav } from './FoodNav';
import { ProposalList } from './ProposalList';
import { matchingFoodIds, normalizeQuery, proposalMatches, useFoodSearch } from './foodSearch';
import { CHECK_WORDS, groupByFood, type ProposalCheck } from './proposals';
import { useEcosystemData } from './useEcosystemData';
import pageStyles from '../research/ResearchPage.module.css';
import styles from './FoodArea.module.css';

type CheckFilter = ProposalCheck | 'all';
const FILTERS: CheckFilter[] = ['all', 'passed', 'unchecked', 'failed'];

export function ReviewPage({ foodId = null }: { foodId?: number | null }) {
  const { data, isLoading, isError } = useEcosystemData();
  const [filter, setFilter] = useState<CheckFilter>('all');
  const [areaSearch] = useFoodSearch();
  const needle = normalizeQuery(areaSearch);

  // Name each food once, for the group headings.
  const foodNames = useMemo(() => new Map((data?.eco_foods ?? []).map((food) => [food.id, food.name])), [data]);
  // Keep the suggestions that pass all three: one food (?food=), check status, and the Food search.
  const proposals = useMemo(() => {
    const searchFoodIds = matchingFoodIds(needle, data?.eco_foods ?? [], data?.eco_recipes ?? []);
    return (data?.eco_proposals ?? []).filter(
      (proposal) =>
        (foodId == null || proposal.food_id === foodId) &&
        (filter === 'all' || proposal.check_status === filter) &&
        proposalMatches(needle, proposal, searchFoodIds),
    );
  }, [data, foodId, filter, needle]);
  const groups = useMemo(() => groupByFood(proposals), [proposals]);

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.pageHead}>
        <h1 className={pageStyles.pageTitle}>Review</h1>
        <span className={pageStyles.pageSub}>where the machine thinks your food comes from · none approved by you yet</span>
      </div>
      <FoodNav current="review" />
      <div className={styles.filterRow}>
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.filterBtn} ${filter === key ? styles.filterBtnOn : ''}`}
            onClick={() => setFilter(key)}
          >
            {key === 'all' ? 'All' : CHECK_WORDS[key]}
          </button>
        ))}
        {foodId != null ? (
          <Link to="/food/review" search={{}} className={styles.filterBtn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
            Every food
          </Link>
        ) : null}
      </div>
      {isLoading ? (
        <div className={pageStyles.loading}>Loading&hellip;</div>
      ) : isError ? (
        <div className={styles.meta}>Could not load the suggestions.</div>
      ) : !groups.length ? (
        <div className={styles.meta}>{needle ? `Nothing waiting matches “${areaSearch.trim()}”.` : 'Nothing waiting here.'}</div>
      ) : (
        groups.map((group) => {
          const name = group.foodId != null ? foodNames.get(group.foodId) : null;
          return (
            <section key={group.foodId ?? 'none'}>
              <div className={styles.groupHead}>
                <span>{name ?? (group.foodId != null ? `Food ${group.foodId}` : 'Products and fixes to your sources')}</span>
                {name ? (
                  <Link to="/food/foods/$name" params={{ name }} className={styles.groupLink}>
                    Its page →
                  </Link>
                ) : null}
              </div>
              <ProposalList proposals={group.proposals} />
            </section>
          );
        })
      )}
    </div>
  );
}
