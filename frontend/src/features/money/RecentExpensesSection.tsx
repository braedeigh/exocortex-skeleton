/**
 * RecentExpensesSection.tsx — the Money page's "Recent expenses" card: the
 * newest 30 expenses, each removable (two-tap confirm, then Undo toast).
 *
 * Each row also carries the "One-time thing" chip (OneTimeFields.tsx). Tapping
 * it on an ordinary expense opens a line under the row: what was bought, which
 * shelf it goes on, and Put in Inventory, which files it
 * (routes/money.py _apply_one_time → routes/inventory.py file_purchase).
 * Tapping it on a one-time thing shows where it was filed and lets her unmark
 * it; the Inventory item stays, since she may still own the thing.
 * Prompt: "i want it as a 'thing' so i can know it was a 'one time purchase'"
 * / "i want it to also add something to my inventory".
 */
import { useState } from 'react';
import { Button, IconButton } from '../../ui';
import { Section } from './Section';
import { OneTimeChip, OneTimeDetail } from './OneTimeFields';
import { formatMoney, isSpendingExpense, recentExpenses } from './moneyMath';
import { useConfirmDelete } from './useDeleteFlow';
import type { UpdateExpensePayload } from './api';
import type { Expense, OneTimeThing } from './types';
import styles from './money.module.css';

export interface RecentExpensesSectionProps {
  expenses: Expense[];
  masked: boolean;
  /** Two-step-confirmed → deferred delete with Undo toast. */
  onRemove: (expense: Expense) => void;
  /** Absent in the public view: no one-time chip there. */
  onUpdate?: (patch: UpdateExpensePayload) => void;
}

const SHELF_NAMES = { durables: 'Durables', consumables: 'Consumables' } as const;

export function RecentExpensesSection({ expenses, masked, onRemove, onUpdate }: RecentExpensesSectionProps) {
  const { confirmKey, tap } = useConfirmDelete();
  // The one row whose one-time line is open, and its draft (not yet filed).
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<OneTimeThing>({ name: '', shelf: 'durables' });
  const { recent, total } = recentExpenses(expenses);
  if (!total) return null;

  function toggle(e: Expense) {
    if (openId === e.id) {
      setOpenId(null);
      return;
    }
    setDraft({ name: '', shelf: 'durables' });
    setOpenId(e.id);
  }

  function file(e: Expense) {
    onUpdate?.({ id: e.id, one_time: { name: draft.name.trim() || e.title || e.comments || '', shelf: draft.shelf } });
    setOpenId(null);
  }

  function unmark(e: Expense) {
    onUpdate?.({ id: e.id, one_time: null });
    setOpenId(null);
  }

  return (
    <Section summary={<span>Recent expenses ({total} total)</span>}>
      <ul className={styles.recentList}>
        {recent.map((e) => (
          <li key={e.id} className={styles.recentItem}>
            <div className={styles.recentRow}>
              <div className={styles.recentWhat}>
                <div className={styles.recentName}>{e.title || e.comments || e.category || 'Expense'}</div>
                <div className={styles.recentMeta}>
                  {[e.date, e.category].filter(Boolean).join(' · ')}
                </div>
              </div>
              <b className={styles.recentAmount}>{formatMoney(e.amount, masked)}</b>
              {/* Spending only: income, transfers and refunds aren't purchases. */}
              {onUpdate && e.amount > 0 && isSpendingExpense(e) ? (
                <OneTimeChip on={!!e.one_time} onToggle={() => toggle(e)} />
              ) : null}
              <IconButton
                aria-label={confirmKey === e.id ? 'Confirm remove expense' : 'Remove expense'}
                title="Remove"
                danger={confirmKey === e.id}
                onClick={() => tap(e.id, () => onRemove(e))}
              >
                {confirmKey === e.id ? <span className={styles.sureBtn}>Sure?</span> : <>&times;</>}
              </IconButton>
            </div>
            {openId === e.id ? (
              <div className={styles.recentOneTime}>
                {e.one_time ? (
                  <div className={styles.oneTimeFiled}>
                    <span>
                      {e.inventory
                        ? <>In Inventory → {SHELF_NAMES[e.inventory.shelf]}: <b>{e.inventory.name}</b></>
                        : 'Marked a one-time thing'}
                    </span>
                    <Button variant="secondary" onClick={() => unmark(e)}>
                      Not one-time
                    </Button>
                  </div>
                ) : (
                  <>
                    <OneTimeDetail
                      value={draft}
                      onChange={(v) => v && setDraft(v)}
                      namePlaceholder={e.title || undefined}
                    />
                    <div className={styles.recentActions}>
                      <Button variant="secondary" onClick={() => setOpenId(null)}>
                        Cancel
                      </Button>
                      <Button onClick={() => file(e)}>Put in Inventory</Button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
