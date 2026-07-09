import { IconButton } from '../../ui';
import { Section } from './Section';
import { formatMoney, recentExpenses } from './moneyMath';
import { useConfirmDelete } from './useDeleteFlow';
import type { Expense } from './types';
import styles from './money.module.css';

export interface RecentExpensesSectionProps {
  expenses: Expense[];
  masked: boolean;
  /** Two-step-confirmed → deferred delete with Undo toast. */
  onRemove: (expense: Expense) => void;
}

/** "Recent expenses (N total)" — newest 30, with × remove (renderRecentExpenses). */
export function RecentExpensesSection({ expenses, masked, onRemove }: RecentExpensesSectionProps) {
  const { confirmKey, tap } = useConfirmDelete();
  const { recent, total } = recentExpenses(expenses);
  if (!total) return null;

  return (
    <Section summary={<span>Recent expenses ({total} total)</span>}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <tbody>
            {recent.map((e) => (
              <tr key={e.id}>
                <td className={styles.tdDate}>{e.date || ''}</td>
                <td className={styles.tdAmount}>
                  <b>{formatMoney(e.amount, masked)}</b>
                </td>
                <td style={{ fontSize: 13 }}>{e.category || ''}</td>
                <td className={styles.tdComments}>{e.comments || ''}</td>
                <td className={styles.tdRight}>
                  <IconButton
                    aria-label={confirmKey === e.id ? 'Confirm remove expense' : 'Remove expense'}
                    title="Remove"
                    danger={confirmKey === e.id}
                    onClick={() => tap(e.id, () => onRemove(e))}
                  >
                    {confirmKey === e.id ? <span className={styles.sureBtn}>Sure?</span> : <>&times;</>}
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
