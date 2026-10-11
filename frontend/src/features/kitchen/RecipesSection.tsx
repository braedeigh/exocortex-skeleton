/**
 * RecipesSection.tsx — the Recipes card on the Kitchen tab.
 *
 * What this file does: the parsed-recipes banner, the URL/image parse inputs,
 * search + Name/Added/Time sort, and the tappable recipe cards. For her (not a
 * visitor) it also reads what each recipe gives (./recipeNutrition.ts →
 * GET /api/recipes/nutrition) and adds three filters over the list: hide
 * recipes with a food that hurts her, hide ones with a line the SIGHI list
 * rates high in histamine, and "Good for" one of her day's gap nutrients,
 * which sorts richest serving first. Each card then shows a serving's
 * calories and top gaps, and names what in it she's sensitive to.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { parseRecipeUrl, scanRecipeImage } from './api';
import {
  filterSortRecipes,
  readRecipeSort,
  writeRecipeSort,
  type RecipeSort,
} from './recipeHelpers';
import {
  getRecipeNutritionOverview,
  OVERVIEW_KEY,
  passesFilters,
  readRecipeFilters,
  servingHighlights,
  sortByNutrient,
  writeRecipeFilters,
  type RecipeFilters,
  type RecipeNutritionSummary,
} from './recipeNutrition';
import { Section } from './Section';
import type { ParsedRecipeMeta, Recipe } from './types';
import styles from './kitchen.module.css';

export interface RecipesSectionProps {
  recipes: Recipe[];
  parsedRecipes: ParsedRecipeMeta[];
  onReviewParsed: (filename: string) => void;
  onDiscardParsed: (filename: string) => void;
  onView: (id: string) => void;
  onSendToList: (id: string) => void;
  onError: (message: string) => void;
  refetchParsed: () => void;
  /** logged-out visitor — hide parse-URL/image-upload and "Send to list"
   * (all server writes); browsing/searching/viewing recipes stays live. */
  isPublic?: boolean;
}

/** Port of the Recipes card — parsed-recipes banner, URL/image parse inputs,
 * search + Name/Added/Time sort, and the tappable recipe cards. */
export function RecipesSection({
  recipes,
  parsedRecipes,
  onReviewParsed,
  onDiscardParsed,
  onView,
  onSendToList,
  onError,
  refetchParsed,
  isPublic = false,
}: RecipesSectionProps) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<RecipeSort>(readRecipeSort);

  const [filters, setFiltersState] = useState<RecipeFilters>(readRecipeFilters);
  // What each recipe gives and what's in it — her own numbers, never fetched for a visitor.
  const nutrition = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: ({ signal }) => getRecipeNutritionOverview(signal),
    enabled: !isPublic,
    staleTime: 60_000,
  });
  const summaries = new Map((nutrition.data?.recipes ?? []).map((summary) => [summary.id, summary]));
  const gaps = nutrition.data?.gaps ?? [];

  // Search and sort as before, then her filters, then "Good for" reorders by that nutrient.
  const searched = filterSortRecipes(recipes, search, sortMode);
  const filtered = isPublic ? searched : searched.filter((r) => passesFilters(summaries.get(r.id), filters));
  const visible = !isPublic && filters.goodFor ? sortByNutrient(filtered, summaries, filters.goodFor) : filtered;
  const hiddenByFilters = searched.length - filtered.length;

  function setFilters(next: RecipeFilters) {
    setFiltersState(next);
    writeRecipeFilters(next);
  }

  const unarchivedCount = recipes.filter((r) => !r.is_archived).length;

  function scheduleParsedRefetches() {
    // Claude parses in the background — poke the banner query a few times.
    setTimeout(refetchParsed, 8000);
    setTimeout(refetchParsed, 20000);
    setTimeout(refetchParsed, 45000);
  }

  async function submitUrl() {
    const trimmed = url.trim();
    if (!trimmed) {
      setStatus('Paste a URL first.');
      return;
    }
    setStatus('Sending to Claude…');
    try {
      const res = await parseRecipeUrl(trimmed);
      if (res?.error) {
        setStatus(`Failed: ${res.error}`);
        onError(`Recipe parse failed: ${res.error}`);
        return;
      }
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : e}`);
      onError(`Recipe parse failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setUrl('');
    setStatus('Claude is parsing it in a Helpers session (Observatory → Helpers). A "Review" banner will appear here when done.');
    scheduleParsedRefetches();
  }

  async function uploadImage(file: File) {
    setStatus('Uploading…');
    try {
      const res = await scanRecipeImage(file);
      if (res?.error) {
        setStatus(`Failed: ${res.error}`);
        onError(`Upload failed: ${res.error}`);
        return;
      }
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : e}`);
      onError(`Upload failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setStatus('Claude is parsing it in a Helpers session (Observatory → Helpers). A "Review" banner will appear here when done.');
    scheduleParsedRefetches();
  }

  function setSort(mode: RecipeSort) {
    setSortMode(mode);
    writeRecipeSort(mode);
  }

  const sortBtn = (mode: RecipeSort, label: string) => (
    <button
      type="button"
      className={`${styles.sortBtn} ${sortMode === mode ? styles.sortBtnActive : ''}`}
      onClick={() => setSort(mode)}
    >
      {label}
    </button>
  );

  return (
    <Section
      title="Recipes"
      badge={recipes.length ? <span className={styles.muted13}>({recipes.length})</span> : undefined}
    >
      {parsedRecipes.length ? (
        <div className={styles.parsedBanner}>
          <div className={styles.parsedBannerTitle}>
            {parsedRecipes.length} parsed recipe{parsedRecipes.length === 1 ? '' : 's'} ready
          </div>
          {parsedRecipes.map((r) => (
            <div className={styles.parsedBannerRow} key={r.filename}>
              <span style={{ flex: 1 }}>
                {r.parse_error ? (
                  <span style={{ color: 'var(--red)' }}>Parse error: {r.parse_error}</span>
                ) : (
                  <>
                    <b>{r.name || '(untitled)'}</b> · {String(r.ingredients_count || 0)} ingredients
                  </>
                )}
              </span>
              {r.parse_error ? (
                <button type="button" className={styles.smallBtn} onClick={() => onDiscardParsed(r.filename)}>
                  Dismiss
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.greenBtn}
                  style={{ minHeight: 40, padding: '5px 12px' }}
                  onClick={() => onReviewParsed(r.filename)}
                >
                  Review
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {!isPublic ? (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
            <input
              type="url"
              className={styles.textInput}
              style={{ flex: 1, minWidth: 200, fontSize: 13 }}
              placeholder="Paste recipe URL…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitUrl();
              }}
            />
            <button type="button" className={styles.ongoingBtn} onClick={() => void submitUrl()}>
              Parse URL
            </button>
            <label className={`${styles.fileLabel} ${styles.smallBtn} ${styles.smallBtnAccent}`}>
              📷 Image
              <input
                type="file"
                accept="image/*,.heic,.heif,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadImage(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <div className={styles.muted12} style={{ minHeight: 18, marginBottom: 10 }}>
            {status}
          </div>
        </>
      ) : null}

      {unarchivedCount ? (
        <>
          <div className={styles.rowFlex} style={{ marginBottom: 10 }}>
            <input
              type="text"
              className={styles.textInput}
              style={{ flex: 1, minWidth: 160 }}
              placeholder="Search recipes or ingredients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span style={{ display: 'inline-flex', gap: 4 }} title="Sort by">
              {sortBtn('name', 'Name')}
              {sortBtn('added', 'Added')}
              {sortBtn('time', 'Time')}
            </span>
          </div>

          {!isPublic ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 10 }}>
              <button
                type="button"
                className={`${styles.sortBtn} ${filters.hideHurts ? styles.sortBtnActive : ''}`}
                title="Hide recipes with a food your food guide or catalog says hurts you"
                onClick={() => setFilters({ ...filters, hideHurts: !filters.hideHurts })}
              >
                Hide what hurts
              </button>
              <button
                type="button"
                className={`${styles.sortBtn} ${filters.lowHistamine ? styles.sortBtnActive : ''}`}
                title="Hide recipes with a line the SIGHI list rates high in histamine or says to avoid. Lines not on the list don't hide a recipe."
                onClick={() => setFilters({ ...filters, lowHistamine: !filters.lowHistamine })}
              >
                Low histamine
              </button>
              {gaps.length ? (
                <select
                  className={styles.sortBtn}
                  aria-label="Sort by a nutrient your day is short of"
                  value={filters.goodFor ?? ''}
                  onChange={(e) => setFilters({ ...filters, goodFor: e.target.value || null })}
                >
                  <option value="">Good for…</option>
                  {gaps.map((gap) => (
                    <option key={gap.key} value={gap.key}>
                      {gap.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {hiddenByFilters ? (
                <span className={styles.muted12}>
                  {hiddenByFilters} hidden by filters
                </span>
              ) : null}
              {nutrition.isLoading ? <span className={styles.muted12}>adding up nutrients…</span> : null}
            </div>
          ) : null}

          {visible.length ? (
            visible.map((r) => {
              const timeBits: string[] = [];
              if (r.prep_min) timeBits.push(`${r.prep_min} min prep`);
              if (r.cook_min) timeBits.push(`${r.cook_min} min cook`);
              if (r.servings) timeBits.push(`${r.servings} servings`);
              return (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onView(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onView(r.id);
                  }}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '12px 14px',
                    marginBottom: 8,
                    background: 'var(--card-bg)',
                    cursor: 'pointer',
                  }}
                >
                  <div className={styles.rowFlex}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{r.name || '(untitled)'}</div>
                      {timeBits.length ? (
                        <div className={styles.muted12} style={{ marginTop: 2 }}>
                          {timeBits.join(' · ')}
                        </div>
                      ) : null}
                      {!isPublic && summaries.get(r.id) ? <ServingLine summary={summaries.get(r.id)!} gaps={gaps} goodFor={filters.goodFor} /> : null}
                      <div style={{ marginTop: 6 }}>
                        {(r.tags || []).map((t) => (
                          <span key={t} className={styles.badge} style={{ marginRight: 4 }}>
                            {t}
                          </span>
                        ))}
                        {r.source_url ? (
                          <a
                            href={r.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: 'var(--ongoing)', fontSize: 12, textDecoration: 'none' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            source ↗
                          </a>
                        ) : null}
                      </div>
                    </div>
                    {!isPublic ? (
                      <button
                        type="button"
                        className={styles.greenBtn}
                        style={{ minHeight: 40, padding: '5px 10px', fontSize: 12 }}
                        title="Pick ingredients (the ones you need are pre-checked) and add to your grocery list"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSendToList(r.id);
                        }}
                      >
                        Send to list
                      </button>
                    ) : null}
                    <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 20, lineHeight: 1, marginLeft: 2 }}>
                      &rsaquo;
                    </span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className={styles.emptyState} style={{ fontStyle: 'italic' }}>
              No recipes match your search.
            </div>
          )}
        </>
      ) : (
        <div className={styles.emptyState} style={{ fontStyle: 'italic' }}>
          No saved recipes yet. Paste a URL above to get started.
        </div>
      )}
    </Section>
  );
}

/** A card's nutrient line — a serving's calories and top gaps — and what in it she's sensitive to. */
function ServingLine({
  summary,
  gaps,
  goodFor,
}: {
  summary: RecipeNutritionSummary;
  gaps: { key: string; label: string }[];
  goodFor: string | null;
}) {
  const bits = servingHighlights(summary, gaps, goodFor);
  const { hurts, histamine_high: high } = summary.flags;
  return (
    <div style={{ fontSize: 12, marginTop: 4 }}>
      {bits.length ? (
        <div className={styles.muted12}>
          {summary.per === 'recipe' ? 'whole recipe' : 'a serving'}: {bits.join(' · ')}
          {summary.counted < summary.lines ? ` (${summary.counted} of ${summary.lines} lines counted)` : ''}
        </div>
      ) : null}
      {hurts.length ? <div style={{ color: 'var(--red)' }}>hurts you: {hurts.join(', ')}</div> : null}
      {high.length ? <div style={{ color: 'var(--orange)' }}>high histamine: {high.join(', ')}</div> : null}
    </div>
  );
}
