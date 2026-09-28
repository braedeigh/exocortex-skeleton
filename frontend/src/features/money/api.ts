/**
 * Money-tab API helpers over the shared client — the exact endpoints
 * static/js/money.js called (routes/money.py + server.py get_data_money).
 */
import { api, ApiError } from '../../api/client';
import type {
  AutoDetectResult,
  CsvImportResult,
  CsvParseResponse,
  CsvSelection,
  LabelRule,
  LearnRule,
  MoneyData,
} from './types';

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

/** GET /api/data/money — the whole tab payload, polled every 5s. */
export function getMoneyData(signal?: AbortSignal): Promise<MoneyData> {
  return api.get('/api/data/money', signal);
}

// --- Expenses ---

export interface AddExpensePayload {
  amount: string | number;
  category: string;
  comments: string;
  date: string;
}

export function addExpense(payload: AddExpensePayload): Promise<OkResponse> {
  return api.post('/api/expense/add', payload);
}

export function removeExpense(id: string): Promise<OkResponse> {
  return api.post('/api/expense/remove', { id });
}

export interface UpdateExpensePayload {
  id: string;
  category?: string;
  title?: string;
  /** With `title`: also save a merchant→title rule for future imports. */
  learn_label_rule?: boolean;
}

export function updateExpense(payload: UpdateExpensePayload): Promise<OkResponse> {
  return api.post('/api/expense/update', payload);
}

/** Send one file as a multipart upload. It bypasses the JSON client, but
 * mirrors its 401→/login and {error} handling. */
async function postFile<T>(url: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) {
    let message = res.statusText || `Upload failed (${res.status})`;
    try {
      const data: unknown = await res.clone().json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // not JSON — keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** POST /api/expense/<id>/receipt — attach a receipt photo or PDF. */
export function uploadReceipt(expenseId: string, file: File): Promise<{ ok: true; filename: string }> {
  return postFile(`/api/expense/${encodeURIComponent(expenseId)}/receipt`, file);
}

// --- Subscriptions ---

export interface AddSubscriptionPayload {
  name: string;
  amount: string | number;
  frequency: string;
  next_renewal: string;
  cancel_url: string;
  notes?: string;
}

export function addSubscription(payload: AddSubscriptionPayload): Promise<OkResponse> {
  return api.post('/api/subscription/add', payload);
}

/** Field patch keyed by subscription name (the identity key). */
export function updateSubscription(
  name: string,
  patch: Record<string, string | number | null>,
): Promise<OkResponse> {
  return api.post('/api/subscription/update', { name, ...patch });
}

export function removeSubscription(name: string): Promise<OkResponse> {
  return api.post('/api/subscription/remove', { name });
}

export function autoDetectSubscriptions(): Promise<AutoDetectResult> {
  return api.post('/api/subscription/auto-detect', {});
}

// --- Budget config ---

export function updateBudget(patch: {
  income_monthly?: string | number;
  bank_csv_url?: string;
}): Promise<OkResponse> {
  return api.post('/api/budget/update', patch);
}

export interface AddCategoryPayload {
  name: string;
  planned: string | number;
  type: string;
}

export function addCategory(payload: AddCategoryPayload): Promise<OkResponse> {
  return api.post('/api/budget/category/add', payload);
}

export function removeCategory(name: string): Promise<OkResponse> {
  return api.post('/api/budget/category/remove', { name });
}

// --- CSV import ---

export function listCsvFiles(signal?: AbortSignal): Promise<{ files: string[] }> {
  return api.get('/api/csv/list', signal);
}

/** POST /api/csv/upload — save a bank CSV from the browser into bank_csvs/. */
export function uploadCsv(file: File): Promise<{ ok: true; filename: string }> {
  return postFile('/api/csv/upload', file);
}

export function parseCsv(filename: string): Promise<CsvParseResponse> {
  return api.post('/api/csv/parse', { filename });
}

export function importCsv(
  selections: CsvSelection[],
  learnRules: LearnRule[],
  learnLabels: LabelRule[],
): Promise<CsvImportResult> {
  return api.post('/api/csv/import', { selections, learn_rules: learnRules, learn_labels: learnLabels });
}

// --- Tax setaside ---

export interface LogTaxPayload {
  amount: string | number;
  date: string;
  notes: string;
}

export function logTaxSetaside(payload: LogTaxPayload): Promise<OkResponse> {
  return api.post('/api/tax/log', payload);
}

export function removeTaxSetaside(id: string): Promise<OkResponse> {
  return api.post('/api/tax/remove', { id });
}

// --- Tab to-dos strip (shared todos route) ---

export function toggleTabTodo(id: string): Promise<OkResponse> {
  return api.post('/api/todos/toggle', { id });
}
