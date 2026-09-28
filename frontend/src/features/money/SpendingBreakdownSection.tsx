/**
 * SpendingBreakdownSection.tsx — the Money page's "Spending by month" card.
 * Each month opens to an earned-vs-spent gauge, then a split by kind
 * (Recurring / Can cut back / One-time / Not sorted), then one bar per
 * category. Tapping a category bar drills into its transactions, where each
 * can be renamed, recategorized, or given a receipt photo.
 *
 * The math lives in moneyMath.ts (groupByMonth, incomeGauge, monthKindSplit,
 * monthBars). A category's kind is set in Budget setup (BudgetConfigSection.tsx);
 * one-time things are marked in the statement preview or Recent expenses.
 */
import { useState } from 'react';
import { Section } from './Section';
import {
  drillTransactions,
  formatMoney,
  grandTotals,
  groupByMonth,
  incomeGauge,
  monthBars,
  monthKindSplit,
  monthLabel,
} from './moneyMath';
import type { BudgetCategory, Expense, ReceiptEntry } from './types';
import styles from './money.module.css';

export interface SpendingBreakdownSectionProps {
  expenses: Expense[];
  receiptsMap: Record<string, ReceiptEntry>;
  masked: boolean;
  /** Sorted list for the drill-down recategorize dropdowns. */
  knownCategories: string[];
  /** Budget categories, for each one's kind in the month split. */
  categories: BudgetCategory[];
  onUpdateExpense: (patch: { id: string; category?: string; title?: string; learn_label_rule?: boolean }) => void;
  onUploadReceipt: (id: string, file: File) => void;
}

interface Drill {
  monthKey: string;
  category: string;
}

/** Inline title editor — commits on blur, learning a merchant→title rule
 * (updateExpenseTitle(..., true)). */
function TitleCell({ expense, onUpdateExpense }: { expense: Expense; onUpdateExpense: SpendingBreakdownSectionProps['onUpdateExpense'] }) {
  const orig = expense.title || '';
  return (
    <input
      type="text"
      className={styles.titleInput}
      defaultValue={orig}
      placeholder={orig ? undefined : '+ title'}
      style={orig ? undefined : { width: 120, fontWeight: 400 }}
      aria-label="Expense title"
      onBlur={(e) => {
        const v = e.target.value;
        if (orig ? v !== orig : !!v) {
          onUpdateExpense({ id: expense.id, title: v, learn_label_rule: true });
        }
      }}
    />
  );
}

function ReceiptCell({
  expense,
  receipt,
  onUploadReceipt,
}: {
  expense: Expense;
  receipt?: ReceiptEntry;
  onUploadReceipt: SpendingBreakdownSectionProps['onUploadReceipt'];
}) {
  if (receipt) {
    return (
      <a
        className={styles.receiptLink}
        href={`/receipts/${receipt.filename}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`View receipt (${receipt.filename})`}
      >
        📷
      </a>
    );
  }
  return (
    <label className={styles.receiptAttach} title="Attach receipt">
      📷
      <input
        type="file"
        accept="image/*,.pdf,.heic"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUploadReceipt(expense.id, f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function DrillTable({
  items,
  category,
  receiptsMap,
  masked,
  knownCategories,
  onUpdateExpense,
  onUploadReceipt,
}: {
  items: Expense[];
  category: string;
} & Omit<SpendingBreakdownSectionProps, 'expenses' | 'categories'>) {
  const matching = drillTransactions(items, category);
  if (!matching.length) {
    return <div className={styles.drillEmpty}>No transactions.</div>;
  }
  return (
    <div className={styles.drillWrap}>
      <div className={styles.tableWrap}>
        <table className={styles.drillTable}>
          <tbody>
            {matching.map((e) => (
              <tr key={e.id}>
                <td className={styles.mutedText} style={{ whiteSpace: 'nowrap' }}>
                  {e.date || ''}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <b>{formatMoney(e.amount, masked)}</b>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <TitleCell key={`${e.id}:${e.title || ''}`} expense={e} onUpdateExpense={onUpdateExpense} />
                </td>
                <td className={styles.mutedText}>
                  {e.comments || ''}
                  {e.one_time ? <span className={styles.dupTag}>one-time</span> : null}
                </td>
                <td style={{ textAlign: 'center' }}>
                  <ReceiptCell expense={e} receipt={receiptsMap[e.id]} onUploadReceipt={onUploadReceipt} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <select
                    className={styles.drillSelect}
                    value={e.category || 'Uncategorized'}
                    aria-label="Category"
                    onChange={(ev) => onUpdateExpense({ id: e.id, category: ev.target.value })}
                  >
                    <option value="Uncategorized">— Uncategorized —</option>
                    {knownCategories
                      .filter((c) => c !== 'Uncategorized')
                      .map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IncomeGaugeBar({ items, masked }: { items: Expense[]; masked: boolean }) {
  const g = incomeGauge(items);
  if (g.empty) return null;

  let leftoverLabel: React.ReactNode;
  if (g.income === 0) {
    leftoverLabel = <span className={styles.mutedText}>no income logged this month</span>;
  } else if (g.leftover >= 0) {
    leftoverLabel = <span className={styles.green}>{formatMoney(g.leftover, masked)} unspent</span>;
  } else {
    leftoverLabel = <span className={styles.red}>OVER by {formatMoney(Math.abs(g.leftover), masked)}</span>;
  }

  return (
    <div className={styles.gaugeWrap}>
      <div className={styles.gaugeLabels}>
        <span className={styles.mutedText}>
          Earned {formatMoney(g.income, masked)} &middot; Spent {formatMoney(g.spent, masked)}
        </span>
        <span>
          <b>{leftoverLabel}</b>
        </span>
      </div>
      <div className={styles.gaugeBar}>
        {g.segments.map((seg) => (
          <div
            key={seg.category}
            className={styles.gaugeSeg}
            title={`${seg.category} — ${formatMoney(seg.amount, masked)}`}
            style={{ width: `${seg.pct}%`, background: seg.color }}
          />
        ))}
        {g.unspentPct > 0 ? (
          <div
            className={styles.gaugeUnspent}
            title={`Unspent — ${formatMoney(g.leftover, masked)}`}
            style={{ width: `${g.unspentPct}%` }}
          />
        ) : null}
        {g.incomeMarkerPct !== null ? (
          <div
            className={styles.gaugeMarker}
            title={`Income ${formatMoney(g.income, masked)}`}
            style={{ left: `${g.incomeMarkerPct}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The month's spending by kind, as a row of small figures: a label over
 * an amount. No colour on purpose: the gauge and category bars right around
 * it already use the palette, and matching hues would read as the same thing.
 * Hidden when nothing is sorted yet, since a lone "Not sorted" says nothing. */
function KindSplit({ items, categories, masked }: { items: Expense[]; categories: BudgetCategory[]; masked: boolean }) {
  const split = monthKindSplit(items, categories);
  if (!split.length || (split.length === 1 && split[0].kind === 'unsorted')) return null;
  return (
    <dl className={styles.kindSplit}>
      {split.map((k) => (
        <div key={k.kind} className={styles.kindFigure}>
          <dt>{k.label}</dt>
          <dd>
            {formatMoney(k.amount, masked)} <span className={styles.kindPct}>{Math.round(k.pct)}%</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "Spending by month" — per-month income gauge + category bars with
 * click-to-drill transaction tables (renderSpendingBreakdown & co). */
export function SpendingBreakdownSection({
  expenses,
  receiptsMap,
  masked,
  knownCategories,
  categories,
  onUpdateExpense,
  onUploadReceipt,
}: SpendingBreakdownSectionProps) {
  const [drill, setDrill] = useState<Drill | null>(null);
  if (!expenses.length) return null;

  const months = groupByMonth(expenses);
  const { grandSpent, grandIncome } = grandTotals(expenses);

  function toggleDrill(monthKey: string, category: string) {
    setDrill((cur) =>
      cur && cur.monthKey === monthKey && cur.category === category ? null : { monthKey, category },
    );
  }

  return (
    <Section
      defaultOpen
      summary={
        <span>
          Spending by month &mdash;{' '}
          {grandIncome > 0 ? <span className={styles.green}>+{formatMoney(grandIncome, masked)} in &middot; </span> : null}
          <span>−{formatMoney(grandSpent, masked)} out</span> across {months.length} month
          {months.length === 1 ? '' : 's'}
        </span>
      }
    >
      {months.map((m, idx) => (
        <details className={styles.monthDetails} key={m.monthKey} open={idx === 0 ? true : undefined}>
          <summary className={styles.monthSummary}>
            {monthLabel(m.monthKey)}{' '}
            <span className={styles.monthSummaryTotals}>
              &mdash;{' '}
              {m.totalIncome > 0 ? (
                <span className={styles.green}>+{formatMoney(m.totalIncome, masked)} in &middot; </span>
              ) : null}
              <span className={styles.mutedText}>−{formatMoney(m.totalSpent, masked)} out</span>
            </span>
          </summary>
          <div className={styles.monthBody}>
            <IncomeGaugeBar items={m.items} masked={masked} />
            <KindSplit items={m.spendingOnly} categories={categories} masked={masked} />
            {monthBars(m.spendingOnly).map((bar) => {
              const isActive =
                drill !== null && drill.monthKey === m.monthKey && drill.category === bar.category;
              return (
                <div className={styles.catRow} key={bar.category}>
                  <button
                    type="button"
                    className={styles.catHead}
                    onClick={() => toggleDrill(m.monthKey, bar.category)}
                    aria-expanded={isActive}
                  >
                    <div className={styles.catLabels}>
                      <span>
                        <span className={styles.catArrow}>{isActive ? '▾' : '▸'}</span>
                        <b>{bar.category}</b>{' '}
                        <span className={styles.catShare}>· {bar.sharePct.toFixed(1)}%</span>
                      </span>
                      <span>{formatMoney(bar.amount, masked)}</span>
                    </div>
                    <div className={styles.catBar}>
                      <div
                        className={styles.catFill}
                        style={{ width: `${bar.pct}%`, background: bar.color }}
                      />
                    </div>
                  </button>
                  {isActive ? (
                    <DrillTable
                      items={m.spendingOnly}
                      category={bar.category}
                      receiptsMap={receiptsMap}
                      masked={masked}
                      knownCategories={knownCategories}
                      onUpdateExpense={onUpdateExpense}
                      onUploadReceipt={onUploadReceipt}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </Section>
  );
}
