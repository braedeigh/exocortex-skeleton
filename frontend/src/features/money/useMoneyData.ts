/**
 * useMoneyData.ts — TanStack Query wiring for the Money tab. One cache entry
 * (['data','money'], 5s poll — the old polling.js cadence) plus mutations.
 * Where the old page's edit felt instant (inline category/title/subscription
 * field edits, removals), we write the cache optimistically; everything else
 * settles through invalidate + the poll, mirroring the old loadDashboard().
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { ToastItem } from '../../ui';
import {
  addCategory,
  addExpense,
  getMoneyData,
  addSubscription,
  autoDetectSubscriptions,
  importCsv,
  listCsvFiles,
  logTaxSetaside,
  parseCsv,
  uploadCsv,
  removeCategory,
  removeExpense,
  removeSubscription,
  removeTaxSetaside,
  toggleTabTodo,
  updateBudget,
  updateCategoryKind,
  updateExpense,
  updateSubscription,
  uploadReceipt,
} from './api';
import type {
  AddCategoryPayload,
  AddExpensePayload,
  AddSubscriptionPayload,
  LogTaxPayload,
  UpdateExpensePayload,
} from './api';
import { isFrosted } from './types';
import type { CategoryKind, CsvSelection, Expense, LabelRule, LearnRule, MoneyData, Subscription, TaxSetasideEntry } from './types';

export const MONEY_QUERY_KEY = ['data', 'money'] as const;

export function useMoneyData() {
  return useQuery({
    queryKey: MONEY_QUERY_KEY,
    queryFn: ({ signal }) => getMoneyData(signal),
    refetchInterval: 5000,
  });
}

// --- Toasts (same contract as journal's useToasts: tone + optional action) ---

export interface PushOptions {
  tone?: 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay in ms (default 5000). */
  duration?: number;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, opts?: PushOptions) => {
    const id = nextId.current++;
    setToasts((cur) => [
      ...cur,
      { id, message, tone: opts?.tone ?? 'error', actionLabel: opts?.actionLabel, onAction: opts?.onAction },
    ]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), opts?.duration ?? 5000);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  return err instanceof ApiError ? err.message : fallback;
}

// --- Optimistic plumbing (same shape as todos' useOptimisticMutation) ---

function useOptimisticMutation<TVars>(
  mutationFn: (vars: TVars) => Promise<unknown>,
  updater: (data: MoneyData, vars: TVars) => MoneyData,
  onError: (message: string) => void,
  /** Toast fallback naming the action, for errors without a server message. */
  fallback?: string,
): UseMutationResult<unknown, unknown, TVars, { previous?: MoneyData }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: MONEY_QUERY_KEY });
      const previous = queryClient.getQueryData<MoneyData>(MONEY_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MoneyData>(MONEY_QUERY_KEY, updater(previous, vars));
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(MONEY_QUERY_KEY, context.previous);
      onError(errorMessage(err, fallback));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY });
    },
  });
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

function mapExpenses(data: MoneyData, fn: (items: Expense[]) => Expense[]): MoneyData {
  if (!Array.isArray(data.expenses)) return data;
  return { ...data, expenses: fn(data.expenses) };
}

function mapSubscriptions(data: MoneyData, fn: (items: Subscription[]) => Subscription[]): MoneyData {
  if (!Array.isArray(data.subscriptions)) return data;
  return { ...data, subscriptions: fn(data.subscriptions) };
}

function mapTax(data: MoneyData, fn: (items: TaxSetasideEntry[]) => TaxSetasideEntry[]): MoneyData {
  if (isFrosted(data.tax_setaside)) return data;
  return { ...data, tax_setaside: fn(data.tax_setaside || []) };
}

// --- Expense mutations ---

export function useExpenseActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();

  const add = useOptimisticMutation(
    (vars: AddExpensePayload) => addExpense(vars),
    (data, vars) =>
      mapExpenses(data, (items) => [
        ...items,
        {
          id: tempId(),
          date: vars.date,
          amount: Number(vars.amount) || 0,
          category: vars.category,
          comments: vars.comments,
        },
      ]),
    onError,
    "Couldn't log the expense",
  );

  const remove = useOptimisticMutation(
    (id: string) => removeExpense(id),
    (data, id) => mapExpenses(data, (items) => items.filter((e) => e.id !== id)),
    onError,
    "Couldn't remove the expense — it's back in the list",
  );

  const update = useOptimisticMutation(
    (vars: UpdateExpensePayload) => updateExpense(vars),
    (data, vars) =>
      mapExpenses(data, (items) =>
        items.map((e) =>
          e.id === vars.id
            ? {
                ...e,
                ...(vars.category !== undefined ? { category: vars.category } : {}),
                ...(vars.title !== undefined ? { title: vars.title } : {}),
                ...(vars.one_time !== undefined ? { one_time: !!vars.one_time } : {}),
              }
            : e,
        ),
      ),
    onError,
    "Couldn't update the expense",
  );

  const receipt = useMutation({
    mutationFn: (vars: { id: string; file: File }) => uploadReceipt(vars.id, vars.file),
    onError: (err) => onError(errorMessage(err, 'Upload failed')),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY }),
  });

  return {
    add: (payload: AddExpensePayload) => add.mutate(payload),
    remove: (id: string) => remove.mutate(id),
    update: (payload: UpdateExpensePayload) => update.mutate(payload),
    uploadReceipt: (id: string, file: File) => receipt.mutate({ id, file }),
  };
}

// --- Subscription mutations ---

export function useSubscriptionActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();

  const add = useMutation({
    mutationFn: (payload: AddSubscriptionPayload) => addSubscription(payload),
    onError: (err) => onError(errorMessage(err, 'Failed to add')),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY }),
  });

  const remove = useOptimisticMutation(
    (name: string) => removeSubscription(name),
    (data, name) => mapSubscriptions(data, (items) => items.filter((s) => s.name !== name)),
    onError,
    "Couldn't remove the subscription — it's back in the list",
  );

  const update = useOptimisticMutation(
    (vars: { name: string; patch: Record<string, string | number | null> }) =>
      updateSubscription(vars.name, vars.patch),
    (data, vars) =>
      mapSubscriptions(data, (items) =>
        items.map((s) => (s.name === vars.name ? { ...s, ...vars.patch } : s)),
      ),
    onError,
    "Couldn't update the subscription",
  );

  const autoDetect = useMutation({
    mutationFn: () => autoDetectSubscriptions(),
    onError: () => onError('Detection failed'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY }),
  });

  return {
    add: (payload: AddSubscriptionPayload) => add.mutateAsync(payload),
    remove: (name: string) => remove.mutate(name),
    update: (name: string, patch: Record<string, string | number | null>) => update.mutate({ name, patch }),
    autoDetect: () => autoDetect.mutateAsync(),
  };
}

// --- Budget config mutations ---

export function useBudgetActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY });

  const save = useMutation({
    mutationFn: (patch: { income_monthly?: string | number; bank_csv_url?: string }) => updateBudget(patch),
    onError: (err) => onError(errorMessage(err, 'Save failed')),
    onSettled: invalidate,
  });

  const addCat = useMutation({
    mutationFn: (payload: AddCategoryPayload) => addCategory(payload),
    onError: (err) => onError(errorMessage(err, 'Failed to add')),
    onSettled: invalidate,
  });

  const removeCat = useOptimisticMutation(
    (name: string) => removeCategory(name),
    (data, name) => {
      if (!data.budget || isFrosted(data.budget)) return data;
      return {
        ...data,
        budget: { ...data.budget, categories: data.budget.categories.filter((c) => c.name !== name) },
      };
    },
    onError,
    "Couldn't remove the category — it's back in the list",
  );

  const setKind = useOptimisticMutation(
    (vars: { name: string; kind: CategoryKind }) => updateCategoryKind(vars.name, vars.kind),
    (data, vars) => {
      if (!data.budget || isFrosted(data.budget)) return data;
      return {
        ...data,
        budget: {
          ...data.budget,
          categories: data.budget.categories.map((c) => (c.name === vars.name ? { ...c, kind: vars.kind } : c)),
        },
      };
    },
    onError,
    "Couldn't change the category's kind",
  );

  return {
    saveIncome: (income_monthly: string | number) => save.mutateAsync({ income_monthly }),
    saveBankUrl: (bank_csv_url: string) => save.mutateAsync({ bank_csv_url }),
    addCategory: (payload: AddCategoryPayload) => addCat.mutateAsync(payload),
    removeCategory: (name: string) => removeCat.mutate(name),
    setCategoryKind: (name: string, kind: CategoryKind) => setKind.mutate({ name, kind }),
  };
}

// --- Tax setaside mutations ---

export function useTaxActions(onError: (message: string) => void) {
  const log = useOptimisticMutation(
    (vars: LogTaxPayload) => logTaxSetaside(vars),
    (data, vars) =>
      mapTax(data, (items) => [
        ...items,
        { id: tempId(), date: vars.date, amount: Number(vars.amount) || 0, notes: vars.notes },
      ]),
    onError,
    "Couldn't log the tax setaside",
  );

  const remove = useOptimisticMutation(
    (id: string) => removeTaxSetaside(id),
    (data, id) => mapTax(data, (items) => items.filter((t) => t.id !== id)),
    onError,
    "Couldn't remove the setaside entry — it's back in the list",
  );

  return {
    log: (payload: LogTaxPayload) => log.mutate(payload),
    remove: (id: string) => remove.mutate(id),
  };
}

// --- Tab to-dos strip ---

export function useTabTodoActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (id: string) => toggleTabTodo(id),
    onError: (err) => onError(errorMessage(err, "Couldn't toggle the to-do")),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY }),
  });
  return { toggle: (id: string) => toggle.mutate(id) };
}

// --- CSV import ---

export const CSV_FILES_QUERY_KEY = ['money', 'csvFiles'] as const;

/** File list loads lazily and sticks for the session (old _csvFiles cache);
 * a successful import invalidates it, like `_csvFiles = null` did. */
export function useCsvFiles() {
  return useQuery({
    queryKey: CSV_FILES_QUERY_KEY,
    queryFn: ({ signal }) => listCsvFiles(signal),
    staleTime: Infinity,
  });
}

export function useCsvActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();

  const parse = useMutation({
    mutationFn: (filename: string) => parseCsv(filename),
    onError: () => onError('Parse failed'),
  });

  // Upload a CSV, then refresh the file list so it shows up there too. The
  // server's own reason is toasted, because a wrong-bank file needs saying why.
  const upload = useMutation({
    mutationFn: (file: File) => uploadCsv(file),
    onError: (error) => onError(error instanceof Error && error.message ? error.message : 'Upload failed'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CSV_FILES_QUERY_KEY });
    },
  });

  const doImport = useMutation({
    mutationFn: (vars: { selections: CsvSelection[]; learnRules: LearnRule[]; learnLabels: LabelRule[] }) =>
      importCsv(vars.selections, vars.learnRules, vars.learnLabels),
    onError: () => onError('Import failed'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CSV_FILES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MONEY_QUERY_KEY });
    },
  });

  return {
    parse: (filename: string) => parse.mutateAsync(filename),
    upload: (file: File) => upload.mutateAsync(file),
    uploading: upload.isPending,
    import: (selections: CsvSelection[], learnRules: LearnRule[], learnLabels: LabelRule[]) =>
      doImport.mutateAsync({ selections, learnRules, learnLabels }),
  };
}
