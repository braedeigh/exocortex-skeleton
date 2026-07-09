import { useRef, useState } from 'react';
import { Button } from '../../ui';
import type { AddExpensePayload } from './api';
import type { Budget } from './types';
import styles from './money.module.css';

export interface QuickExpenseProps {
  budget: Budget;
  /** Server date (YYYY-MM-DD) — the date input's default, like todayStr(). */
  todayStr: string;
  onAdd: (payload: AddExpensePayload) => void;
}

/** "Log expense" card (renderQuickExpense/addExpense): amount + category +
 * comment + date, Enter submits, plus the bank CSV deep-link chip. */
export function QuickExpense({ budget, todayStr, onAdd }: QuickExpenseProps) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [comments, setComments] = useState('');
  const [date, setDate] = useState(todayStr);
  const amountRef = useRef<HTMLInputElement>(null);

  const bankUrl = (budget.bank_csv_url || '').trim();

  function submit() {
    if (!amount) {
      amountRef.current?.focus();
      return;
    }
    onAdd({ amount, category, comments: comments.trim(), date: date || todayStr });
    setAmount('');
    setComments('');
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
        <select
          aria-label="Category"
          className={styles.select}
          style={{ minWidth: 140 }}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">— pick category —</option>
          {(budget.categories || []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="comment (optional)"
          aria-label="Comment"
          className={`${styles.input} ${styles.grow}`}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          onKeyDown={onEnter}
        />
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
