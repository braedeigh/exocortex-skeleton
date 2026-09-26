/**
 * NewTableForm.tsx — making a research table, on TablesPage.tsx behind
 * "+ new table". This is where she directs a table: what it's called, whether
 * it holds numbers or verdicts, which branch of the hazard map runs across the
 * top, which kind of number the cells show, which foods run down the side, and
 * which research topic it belongs to.
 *
 * The branch picker is the hazard map drawn flat (tableMath.mapLines), so a
 * family with members shows them indented under it. Sends one POST through
 * useTablesMutations().addTable; the page opens the new table on success.
 */

import { useState } from 'react';
import { mapLines, MEASURE_WORDS } from './tableMath';
import type { FoodSet, MeasureKind, NewTableBody, TableKind, TablesVocab } from './types';
import { useResearch } from './useResearchData';
import { useHazards } from './useTablesData';
import pageStyles from './ResearchPage.module.css';
import claimStyles from './ClaimsPage.module.css';
import styles from './TablesPage.module.css';

const FOOD_WORDS: Record<FoodSet, string> = {
  all: 'every food',
  recipes: 'foods in my recipes',
  rotation: 'foods on my meal rotation',
};

export function NewTableForm({
  vocab,
  saving,
  onCreate,
  onCancel,
}: {
  vocab: TablesVocab;
  saving: boolean;
  onCreate: (body: NewTableBody) => void;
  onCancel: () => void;
}) {
  const hazards = useHazards().data?.hazards ?? [];
  const topics = useResearch().data?.topics ?? [];
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TableKind>('measures');
  const [branch, setBranch] = useState<number | null>(null);
  const [measure, setMeasure] = useState<MeasureKind | null>(null);
  const [foods, setFoods] = useState<FoodSet>('all');
  const [topic, setTopic] = useState('');

  // Each hazard once in the picker, even one that sits under two families.
  const seen = new Set<number>();
  const branchLines = mapLines(hazards).filter((line) => !seen.has(line.hazard.id) && seen.add(line.hazard.id));

  return (
    <div className={`${claimStyles.claimCard} ${styles.form}`}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={pageStyles.input}
          value={name}
          placeholder="e.g. Contaminants in my food"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Holds</span>
        <div className={claimStyles.pillRow}>
          {vocab.kinds.map((each) => (
            <button
              type="button"
              key={each}
              className={`${pageStyles.chip} ${kind === each ? pageStyles.chipActive : ''}`}
              onClick={() => setKind(each)}
            >
              {each === 'measures' ? '▦ numbers — foods × hazards' : '⚖︎ verdicts — buy organic or not, per lens'}
            </button>
          ))}
        </div>
      </div>

      {kind === 'measures' ? (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Across the top — the members of</span>
            <select
              className={pageStyles.input}
              value={branch ?? ''}
              onChange={(event) => setBranch(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">the top of the hazard map</option>
              {branchLines.map((line) => (
                <option key={line.hazard.id} value={line.hazard.id}>
                  {'\u00a0\u00a0\u00a0'.repeat(line.depth)}
                  {line.depth ? '└ ' : ''}
                  {line.hazard.name}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Cells show</span>
            <div className={claimStyles.pillRow}>
              <button
                type="button"
                className={`${pageStyles.chip} ${measure === null ? pageStyles.chipActive : ''}`}
                onClick={() => setMeasure(null)}
              >
                every kind of number
              </button>
              {vocab.measures.map((each) => (
                <button
                  type="button"
                  key={each}
                  className={`${pageStyles.chip} ${measure === each ? pageStyles.chipActive : ''}`}
                  onClick={() => setMeasure(each)}
                >
                  {MEASURE_WORDS[each]}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className={claimStyles.valueLine}>Columns: {vocab.lenses.join(', ')}.</div>
      )}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Down the side</span>
        <div className={claimStyles.pillRow}>
          {vocab.food_sets.map((each) => (
            <button
              type="button"
              key={each}
              className={`${pageStyles.chip} ${foods === each ? pageStyles.chipActive : ''}`}
              onClick={() => setFoods(each)}
            >
              {FOOD_WORDS[each]}
            </button>
          ))}
        </div>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Research topic</span>
        <select className={pageStyles.input} value={topic} onChange={(event) => setTopic(event.target.value)}>
          <option value="">none</option>
          {topics.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.formButtons}>
        <button
          type="button"
          className={pageStyles.primaryBtn}
          disabled={!name.trim() || saving}
          onClick={() =>
            onCreate({
              name: name.trim(),
              kind,
              topic_id: topic || null,
              hazard: kind === 'measures' ? branch : null,
              measure: kind === 'measures' ? measure : null,
              foods,
            })
          }
        >
          {saving ? 'Making…' : 'Make table'}
        </button>
        <button type="button" className={pageStyles.outlineBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
