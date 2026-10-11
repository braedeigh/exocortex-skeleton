import { useMemo } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { BudgetConfigSection } from './BudgetConfigSection';
import { CsvImportSection } from './CsvImportSection';
import { QuickExpense } from './QuickExpense';
import { RecentExpensesSection } from './RecentExpensesSection';
import { SetAsideSection } from './SetAsideSection';
import { SpendingBreakdownSection } from './SpendingBreakdownSection';
import { SubscriptionsSection } from './SubscriptionsSection';
import { TabTodosCard } from './TabTodosCard';
import { ThisMonthSection } from './ThisMonthSection';
import { allKnownCategories } from './moneyMath';
import { isFrosted } from './types';
import type { Budget, Expense, Subscription, TabTodo, TaxSetasideEntry } from './types';
import { usePendingDeletes } from './useDeleteFlow';
import {
  useBudgetActions,
  useExpenseActions,
  useMoneyData,
  useSubscriptionActions,
  useTabTodoActions,
  useTaxActions,
  useToasts,
} from './useMoneyData';
import styles from './money.module.css';

/** Old money.js masked every dollar figure unless VIEW_MODE === 'authed'. */
function isPublicMode(): boolean {
  return typeof window !== 'undefined' && !!window.VIEW_MODE && window.VIEW_MODE !== 'authed';
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EMPTY_BUDGET: Budget = { income_monthly: 0, categories: [] };

/**
 * Money tab — React port of templates/index.html #tab-money +
 * static/js/money.js. Section order matches the old markup: tab to-dos,
 * quick expense, CSV import, set aside, spending breakdown, this month,
 * recent expenses, subscriptions, budget setup. Public visitors see only the
 * non-auth sections with every amount masked as $•••.
 */
export function MoneyPage() {
  const { data, isLoading, isError, error, refetch } = useMoneyData();
  const { toasts, push, dismiss } = useToasts();
  const onError = (m: string) => void push(m);

  const expenseActions = useExpenseActions(onError);
  const subscriptionActions = useSubscriptionActions(onError);
  const budgetActions = useBudgetActions(onError);
  const taxActions = useTaxActions(onError);
  const tabTodoActions = useTabTodoActions(onError);
  const { pending, request: requestDelete } = usePendingDeletes(push);

  const masked = isPublicMode();
  const isPublic = masked;

  // --- unwrap the payload (frosted streams → safe empties, like core.js) ---
  const budget: Budget = data && data.budget && !isFrosted(data.budget) ? data.budget : EMPTY_BUDGET;
  const allExpenses: Expense[] = Array.isArray(data?.expenses) ? data.expenses : [];
  const allSubs: Subscription[] = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
  const taxSetasideRaw = data?.tax_setaside;
  const allTax: TaxSetasideEntry[] = Array.isArray(taxSetasideRaw) ? taxSetasideRaw : [];
  const receiptsMap = data?.receipts_map ?? {};
  const tabTodos: TabTodo[] = Array.isArray(data?.tab_todos) ? data.tab_todos : [];
  const todayStr = data?.server_date || localToday();

  // Rows mid "Removed · Undo" toast are hidden but not yet deleted server-side.
  const expenses = useMemo(() => allExpenses.filter((e) => !pending.has(`expense:${e.id}`)), [allExpenses, pending]);
  const subscriptions = useMemo(() => allSubs.filter((s) => !pending.has(`sub:${s.name}`)), [allSubs, pending]);
  const taxSetaside = useMemo(() => allTax.filter((t) => !pending.has(`tax:${t.id}`)), [allTax, pending]);
  const budgetView: Budget = useMemo(
    () => ({ ...budget, categories: (budget.categories || []).filter((c) => !pending.has(`cat:${c.name}`)) }),
    [budget, pending],
  );

  const knownCategories = useMemo(
    () => allKnownCategories(budgetView.categories || [], expenses),
    [budgetView, expenses],
  );

  if (isLoading && !data) {
    return (
      <div className={styles.page}>
        <div className={styles.pageInner}>
          <div className={styles.banner}>Loading…</div>
        </div>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className={styles.page}>
        <div className={styles.pageInner}>
          <div className={`${styles.banner} ${styles.bannerError}`}>
            <span>{error instanceof Error ? error.message : "Couldn't load data."}</span>
            <button type="button" className={styles.outlineBtn} onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        {!isPublic ? <TabTodosCard items={tabTodos} onToggle={tabTodoActions.toggle} /> : null}

        <div className={styles.sectionTitle}>Money</div>

        {!isPublic ? <QuickExpense budget={budgetView} todayStr={todayStr} expenses={expenses} onAdd={expenseActions.add} onAddCategory={budgetActions.addCategory} /> : null}

        {!isPublic ? <CsvImportSection push={push} /> : null}

        {!isPublic ? (
          <SetAsideSection
            expenses={expenses}
            taxSetaside={taxSetaside}
            todayStr={todayStr}
            onLogTax={taxActions.log}
            onRemoveTax={(t) => requestDelete(`tax:${t.id}`, 'Setaside entry removed', () => taxActions.remove(t.id))}
          />
        ) : null}

        <SpendingBreakdownSection
          expenses={expenses}
          receiptsMap={receiptsMap}
          masked={masked}
          knownCategories={knownCategories}
          categories={budgetView.categories || []}
          onUpdateExpense={expenseActions.update}
          onUploadReceipt={expenseActions.uploadReceipt}
          onAddCategory={budgetActions.addCategory}
        />

        <ThisMonthSection budget={budgetView} expenses={expenses} masked={masked} />

        <RecentExpensesSection
          expenses={expenses}
          masked={masked}
          onRemove={(e) => requestDelete(`expense:${e.id}`, 'Expense removed', () => expenseActions.remove(e.id))}
          onUpdate={isPublic ? undefined : expenseActions.update}
        />

        <SubscriptionsSection
          subscriptions={subscriptions}
          masked={masked}
          onUpdateField={subscriptionActions.update}
          onRemove={(s) =>
            requestDelete(`sub:${s.name}`, `Subscription "${s.display_name || s.name}" removed`, () =>
              subscriptionActions.remove(s.name),
            )
          }
          onAdd={subscriptionActions.add}
          onAutoDetect={subscriptionActions.autoDetect}
          push={push}
        />

        {!isPublic ? (
          <BudgetConfigSection
            budget={budgetView}
            onSaveIncome={budgetActions.saveIncome}
            onSaveBankUrl={budgetActions.saveBankUrl}
            onAddCategory={budgetActions.addCategory}
            onSetKind={budgetActions.setCategoryKind}
            onRemoveCategory={(c) =>
              requestDelete(`cat:${c.name}`, `Category "${c.name}" removed`, () => budgetActions.removeCategory(c.name))
            }
          />
        ) : null}
      </div>

      {!isPublic ? <NotesPill onError={onError} tab="money" /> : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
