/**
 * Money tab payload types — shape of GET /api/data/money (server.py
 * get_data_money) plus the request/response bodies of routes/money.py.
 * Hand-written to match the JSON the Flask side actually emits.
 */
import type { FrostedStream } from '../todos/types';

export { isFrosted } from '../todos/types';
export type { FrostedStream };

export interface BudgetCategory {
  name: string;
  planned: number;
  /** variable | fixed | savings */
  type?: string;
  /** What its spending is like: a need that comes back every month,
   * something she could spend less on, or not recurring (left out of the
   * month's total in Spending by month). Missing / "" = not sorted yet. */
  kind?: CategoryKind;
}

export type CategoryKind = 'recurring' | 'cut_back' | 'one_time' | '';

/** Which Inventory shelf a one-time purchase goes on: a thing she keeps
 * (archivals catalog) or a thing that gets used up (active inventory). */
export type InventoryShelf = 'durables' | 'consumables';

/** Marking something a one-time thing: what she bought and where it goes. */
export interface OneTimeThing {
  name: string;
  shelf: InventoryShelf;
}

export interface Budget {
  income_monthly: number;
  categories: BudgetCategory[];
  /** Bank deep-link for downloading a fresh CSV. Stripped server-side in public mode. */
  bank_csv_url?: string;
}

export interface Expense {
  id: string;
  date?: string;
  amount: number;
  category?: string;
  comments?: string;
  /** Short human label, editable in the breakdown drill-down. */
  title?: string;
  /** 'receipt_import' rows get merged with bank rows on CSV import. */
  source?: string;
  bank_matched?: boolean;
  /** A one-time purchase (a mattress), not everyday spending in its category. */
  one_time?: boolean;
  /** Where the one-time thing was filed in Inventory (routes/inventory.py file_purchase). */
  inventory?: { shelf: InventoryShelf; name: string; id?: string };
}

export interface Subscription {
  name: string;
  /** Presentation-only override; `name` stays the transaction-match key. */
  display_name?: string;
  amount: number;
  /** monthly | yearly */
  frequency?: string;
  next_renewal?: string;
  cancel_url?: string;
  notes?: string;
  bill_day?: number | null;
}

export interface TaxSetasideEntry {
  id: string;
  date?: string;
  amount: number;
  notes?: string;
}

export interface ReceiptEntry {
  filename: string;
  uploaded?: string;
  parsed?: boolean;
}

/** To-dos category-tagged 'money' (D.tab_todos) — the strip at the top of the page. */
export interface TabTodo {
  id?: string;
  text: string;
  due_by?: string | null;
}

export interface MoneyData {
  server_date?: string;
  budget?: Budget | FrostedStream;
  expenses?: Expense[] | FrostedStream;
  subscriptions?: Subscription[] | FrostedStream;
  receipts_map?: Record<string, ReceiptEntry>;
  tax_setaside?: TaxSetasideEntry[] | FrostedStream;
  tab_todos?: TabTodo[] | FrostedStream;
  [key: string]: unknown;
}

// --- CSV import (POST /api/csv/parse response rows) ---

export interface CsvRow {
  date: string;
  desc: string;
  /** Signed: negative = expense, positive = income/credit. */
  amount: number;
  category: string;
  include: boolean;
  already_imported?: boolean;
  /** What the thing is ("Cosmic Coffee"): from a learned merchant label, else
   * the preview's own guess (statementMerchant.ts); she can rename it. */
  title?: string;
  /** The name a learned label gave this row when it arrived, if any. */
  learned_title?: string;
  /** She has confirmed this row — tapped it or changed anything on it. */
  user_touched?: boolean;
  /** Marked a one-time thing: filed into Inventory on import. */
  one_time?: OneTimeThing | null;
}

export interface CsvParseResponse {
  rows: CsvRow[];
  categories: string[];
  /** Every merchant name she has taught, offered as suggestions. */
  titles?: string[];
}

export interface CsvSelection {
  date: string;
  desc: string;
  amount: number;
  category: string;
  title: string;
  one_time?: OneTimeThing;
}

/** A learned merchant→name label (merchant_labels on the server). */
export interface LabelRule {
  match: string;
  title: string;
}

export interface LearnRule {
  match: string;
  category: string;
}

export interface CsvImportResult {
  ok: true;
  added: number;
  merged_with_receipt: number;
  rules_learned: number;
  labels_learned: number;
  categories_added: number;
}

export interface AutoDetectResult {
  added: number;
  skipped: number;
}
