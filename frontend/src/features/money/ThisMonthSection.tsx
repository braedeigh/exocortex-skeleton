import { Section } from './Section';
import { expensesInMonth, formatMoney, thisMonthKey, thisMonthSummary } from './moneyMath';
import type { Budget, Expense } from './types';
import styles from './money.module.css';

export interface ThisMonthSectionProps {
  budget: Budget;
  expenses: Expense[];
  masked: boolean;
}

/** "July 2026 — $X of $Y" budget-vs-spent bars (renderThisMonth). */
export function ThisMonthSection({ budget, expenses, masked }: ThisMonthSectionProps) {
  const cats = (budget.categories || []).filter((c) => c.type !== 'savings');
  if (!cats.length) return null;

  const monthKey = thisMonthKey();
  const { rows, totalSpent, totalPlanned } = thisMonthSummary(budget, expensesInMonth(expenses, monthKey));
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <Section
      defaultOpen
      summary={
        <span>
          {monthName} &mdash; {formatMoney(totalSpent, masked)} of {formatMoney(totalPlanned, masked)}
        </span>
      }
    >
      {rows.map((r) => (
        <div className={styles.budgetRow} key={r.name}>
          <div className={styles.budgetRowHead}>
            <span>
              <b>{r.name}</b>
            </span>
            <span className={r.over ? styles.red : styles.mutedText}>
              {formatMoney(r.spent, masked)}
              {r.planned > 0 ? ` / ${formatMoney(r.planned, masked)}` : ''}
            </span>
          </div>
          <div className={styles.budgetBar}>
            <div className={styles.budgetFill} style={{ background: r.barColor, width: `${r.pct}%` }} />
          </div>
        </div>
      ))}
    </Section>
  );
}
