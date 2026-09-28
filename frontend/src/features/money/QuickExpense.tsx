/**
 * QuickExpense.tsx — the Money page's "Log expense" card: amount, what it was,
 * category, date; Enter logs it. As she types what it was ("coffee"), the
 * category fills itself in from how she filed similar expenses before
 * (quickCategory.ts); picking a category by hand turns that off until the next
 * expense. Also carries the "Download CSV from bank" link. Posts through
 * api.ts addExpense (routes/money.py /api/expense/add).
 */
import { useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import type { AddExpensePayload } from './api';
import { suggestCategory } from './quickCategory';
import type { Budget, Expense } from './types';
import styles from './money.module.css';

export interface QuickExpenseProps {
  budget: Budget;
  /** Server date (YYYY-MM-DD) — the date input's default, like todayStr(). */
  todayStr: string;
  /** Past expenses — what the category guess learns from. */
  expenses: Expense[];
  onAdd: (payload: AddExpensePayload) => void;
}

export function QuickExpense({ budget, todayStr, expenses, onAdd }: QuickExpenseProps) {
  const [amount, setAmount] = useState('');
  const [pickedCategory, setPickedCategory] = useState('');
  const [comments, setComments] = useState('');
  const [date, setDate] = useState(todayStr);
  const amountRef = useRef<HTMLInputElement>(null);

  const bankUrl = (budget.bank_csv_url || '').trim();

  // Fill the category in from what she typed, unless she picked one herself.
  // Prompt: "auto fill expense type on each expense entry" — e.g. "coffee" or "drinks"
  const offered = useMemo(() => (budget.categories || []).map((c) => c.name), [budget.categories]);
  const guess = useMemo(
    () => (pickedCategory ? null : suggestCategory(comments, expenses, offered)),
    [pickedCategory, comments, expenses, offered],
  );
  const category = pickedCategory || guess?.category || '';

  function submit() {
    if (!amount) {
      amountRef.current?.focus();
      return;
    }
    onAdd({ amount, category, comments: comments.trim(), date: date || todayStr });
    setAmount('');
    setComments('');
    setPickedCategory('');
  }

  function onEnter(e: React.KeyboardEvent) {
    if (e.key === 'Enter') submit();
  }

  return (
    <div className={styles.cardPlain}>
      <div className={styles.cardHead}>
        <div className={styles.miniLabel}>Log expense</div>
        {bankUrl ? (
          <a className={styles.bankChip} href={bankUrl} target="_blank" rel="noopener noreferrer">
            ↗ Download CSV from bank
          </a>
        ) : null}
      </div>
      <div className={styles.formRow}>
        <input
          ref={amountRef}
          type="number"
          step="0.01"
          inputMode="decimal"
          placeholder="$"
          aria-label="Amount"
          className={styles.input}
          style={{ width: 100 }}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={onEnter}
        />
        <input
          type="text"
          placeholder="what was it? (coffee, drinks…)"
          aria-label="What was it?"
          className={`${styles.input} ${styles.grow}`}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          onKeyDown={onEnter}
        />
        <select
          aria-label="Category"
          className={guess ? `${styles.select} ${styles.selectGuessed}` : styles.select}
          style={{ minWidth: 140 }}
          value={category}
          onChange={(e) => setPickedCategory(e.target.value)}
        >
          <option value="">— pick category —</option>
          {(budget.categories || []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Date"
          className={styles.input}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Button onClick={submit}>Log</Button>
      </div>
    </div>
  );
}
