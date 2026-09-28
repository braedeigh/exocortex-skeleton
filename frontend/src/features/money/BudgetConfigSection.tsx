/**
 * BudgetConfigSection.tsx — the Money page's "Budget setup" card: monthly
 * income, the bank's CSV download link, and the budget categories.
 *
 * Each category has a planned amount, a type (variable / fixed / savings;
 * savings stays out of the monthly budget), and a kind: "Recurring" (a need
 * that comes back every month, like Rent) or "Can cut back" (like Eating Out).
 * The kind drives the recurring / cut-back / one-time split in Spending by
 * month (moneyMath.ts monthKindSplit). Saves go through useMoneyData.ts.
 * Prompt: "kitty litter is a recurring spend category … coffee which is
 * something i can cut back on or beer".
 */
import { useRef, useState } from 'react';
import { Button, IconButton } from '../../ui';
import { Section } from './Section';
import { dollars } from './moneyMath';
import { useConfirmDelete } from './useDeleteFlow';
import type { AddCategoryPayload } from './api';
import type { Budget, BudgetCategory, CategoryKind } from './types';
import styles from './money.module.css';

export interface BudgetConfigSectionProps {
  budget: Budget;
  onSaveIncome: (income: string) => Promise<unknown>;
  onSaveBankUrl: (url: string) => Promise<unknown>;
  onAddCategory: (payload: AddCategoryPayload) => Promise<unknown>;
  onRemoveCategory: (cat: BudgetCategory) => void;
  onSetKind: (name: string, kind: CategoryKind) => void;
}

/** "Budget setup" — income, bank CSV deep-link, planned categories
 * (renderBudgetConfig & co). Auth-only, so amounts print unmasked. */
export function BudgetConfigSection({
  budget,
  onSaveIncome,
  onSaveBankUrl,
  onAddCategory,
  onRemoveCategory,
  onSetKind,
}: BudgetConfigSectionProps) {
  const { confirmKey, tap } = useConfirmDelete();
  const cats = budget.categories || [];
  const totalPlanned = cats.reduce((s, c) => s + (c.planned || 0), 0);

  const [income, setIncome] = useState(String(budget.income_monthly || 0));
  const [bankUrl, setBankUrl] = useState(budget.bank_csv_url || '');
  const [catName, setCatName] = useState('');
  const [catPlanned, setCatPlanned] = useState('');
  const [catType, setCatType] = useState('variable');
  const catNameRef = useRef<HTMLInputElement>(null);

  async function addCategory() {
    const name = catName.trim();
    if (!name) {
      catNameRef.current?.focus();
      return;
    }
    try {
      await onAddCategory({ name, planned: catPlanned || 0, type: catType });
      setCatName('');
      setCatPlanned('');
    } catch {
      // failure already toasted
    }
  }

  return (
    <Section
      summary={
        <span>
          Budget setup &mdash; income {dollars(budget.income_monthly)}/mo, allocated {dollars(totalPlanned)}
        </span>
      }
    >
      <div className={styles.formRow} style={{ marginBottom: 8 }}>
        <label className={styles.miniLabel} htmlFor="bud-income">
          Income/mo
        </label>
        <input
          id="bud-income"
          type="number"
          step="0.01"
          inputMode="decimal"
          className={`${styles.input} ${styles.wShort}`}
          value={income}
          onChange={(e) => setIncome(e.target.value)}
        />
        <Button onClick={() => void onSaveIncome(income).catch(() => {/* failure already toasted */})}>Save</Button>
      </div>

      <div className={styles.formRow} style={{ marginBottom: 12 }}>
        <label className={styles.miniLabel} htmlFor="bud-bank-url" style={{ whiteSpace: 'nowrap' }}>
          Bank CSV URL
        </label>
        <input
          id="bud-bank-url"
          type="url"
          placeholder="paste your BoA download deep-link"
          className={`${styles.input} ${styles.grow}`}
          style={{ minWidth: 240, fontSize: 13 }}
          value={bankUrl}
          onChange={(e) => setBankUrl(e.target.value)}
        />
        <Button onClick={() => void onSaveBankUrl(bankUrl.trim()).catch(() => {/* failure already toasted */})}>Save</Button>
      </div>

      {cats.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Category</th>
                <th>Kind</th>
                <th>Type</th>
                <th>Planned/mo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.name}>
                  <td>
                    <b>{c.name}</b>
                  </td>
                  <td>
                    <select
                      aria-label={`Kind of ${c.name}`}
                      className={styles.select}
                      value={c.kind || ''}
                      onChange={(e) => onSetKind(c.name, e.target.value as CategoryKind)}
                    >
                      <option value="">— not sorted —</option>
                      <option value="recurring">Recurring</option>
                      <option value="cut_back">Can cut back</option>
                    </select>
                  </td>
                  <td className={styles.tdComments}>{c.type || 'variable'}</td>
                  <td className={styles.nowrap}>{dollars(c.planned)}</td>
                  <td className={styles.tdRight}>
                    <IconButton
                      aria-label={confirmKey === c.name ? 'Confirm remove category' : `Remove ${c.name}`}
                      title="Remove"
                      danger={confirmKey === c.name}
                      onClick={() => tap(c.name, () => onRemoveCategory(c))}
                    >
                      {confirmKey === c.name ? <span className={styles.sureBtn}>Sure?</span> : <>&times;</>}
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyNote} style={{ fontSize: 13 }}>
          No categories yet — add some below.
        </div>
      )}

      <div className={`${styles.formRow} ${styles.formRowTop}`}>
        <input
          ref={catNameRef}
          type="text"
          placeholder="Category name (e.g. Groceries)"
          aria-label="Category name"
          className={`${styles.input} ${styles.grow}`}
          style={{ minWidth: 140 }}
          value={catName}
          onChange={(e) => setCatName(e.target.value)}
        />
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="Planned/mo"
          aria-label="Planned per month"
          className={`${styles.input} ${styles.wAmount}`}
          style={{ width: 120 }}
          value={catPlanned}
          onChange={(e) => setCatPlanned(e.target.value)}
        />
        <select aria-label="Type" className={styles.select} value={catType} onChange={(e) => setCatType(e.target.value)}>
          <option value="variable">variable</option>
          <option value="fixed">fixed</option>
          <option value="savings">savings</option>
        </select>
        <Button onClick={addCategory}>Add</Button>
      </div>
    </Section>
  );
}
