import type { AddTodoPayload } from '../../api/endpoints';
import type { GateWindow, TodoItem, TodoSection, TodoViewRules } from './types';

export const LADDER_LABELS = ['Now', 'Up Next', 'Later', 'Someday'] as const;
export const DONE_LABEL = 'Done';

export function isDoneSection(name: string): boolean {
  return name
    .toLowerCase()
    .replace(/\s*—.*/, '')
    .trim()
    .startsWith('done');
}

export function isOverdue(dueBy: string | null | undefined, serverDate: string): boolean {
  return !!dueBy && dueBy < serverDate;
}

export function isSnoozed(item: TodoItem, serverDate: string): boolean {
  return !!item.snoozed_until && item.snoozed_until > serverDate && !item.done;
}

/** id -> item, across every section (ladder + Done) — lets "do after" look
 * up a blocker to-do wherever it lives, including once it's been completed. */
export function buildTodoIndex(sections: TodoSection[]): Map<string, TodoItem> {
  const index = new Map<string, TodoItem>();
  for (const section of sections) {
    for (const item of section.items) {
      index.set(item.id, item);
    }
  }
  return index;
}

/** "Do after": hidden while a date hasn't arrived yet and/or a referenced
 * to-do still exists and isn't done. With both fields set, unblocking is
 * OR — either the date arriving or the blocker finishing frees the item —
 * so it's still waiting only while BOTH conditions are still blocking. */
export function isWaiting(item: TodoItem, serverDate: string, index: Map<string, TodoItem>): boolean {
  if (item.done) return false;
  const hasDate = !!item.after_date;
  const hasBlocker = !!item.after_id;
  if (!hasDate && !hasBlocker) return false;
  const blockedByDate = hasDate && serverDate < (item.after_date as string);
  const blocker = hasBlocker ? index.get(item.after_id as string) : undefined;
  const blockedByTodo = hasBlocker && !!blocker && !blocker.done;
  if (hasDate && hasBlocker) return blockedByDate && blockedByTodo;
  return blockedByDate || blockedByTodo;
}

export function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Human reason a waiting item is still hidden — prefers the blocker to-do's
 * text when that's the thing still holding it back, else the date. */
export function waitingReason(item: TodoItem, index: Map<string, TodoItem>): string {
  if (item.after_id) {
    const blocker = index.get(item.after_id);
    if (blocker && !blocker.done) return `after: ${truncate(blocker.text)}`;
  }
  if (item.after_date) return `after ${fmtAddedDate(item.after_date)}`;
  return '';
}

/** An item's front ids. Absent/empty list = untagged. */
export function itemFronts(item: TodoItem): string[] {
  return Array.isArray(item.fronts) ? item.fronts : [];
}

/** '' matches all; '__none__' matches untagged; a front id matches items
 * whose fronts list includes it (items can sit on several fronts). */
export function focusMatch(item: TodoItem, front: string): boolean {
  if (!front) return true;
  const fronts = itemFronts(item);
  if (front === '__none__') return fronts.length === 0;
  return fronts.includes(front);
}

/**
 * Quick-adds inherit the active focus filter, so a new item lands in the
 * view being looked at instead of vanishing behind it. "All" ('') and
 * "Other" ('__none__') stamp nothing, and explicit fronts win.
 */
export function withFocusFront(payload: AddTodoPayload, focusFront: string): AddTodoPayload {
  if (!focusFront || focusFront === '__none__' || payload.fronts?.length) return payload;
  return { ...payload, fronts: [focusFront] };
}

export function fmtTime(hhmm: string | null | undefined): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ap = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m || 0).padStart(2, '0')}${ap}`;
}

export function fmtDuration(min: number | null | undefined): string {
  const n = Number(min);
  if (!n) return '';
  if (n < 60) return `${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h${m}` : `${h}h`;
}

export function fmtAddedDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(`${iso}T12:00:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface FocusCounts {
  /** Live items, each counted once (multi-front items still count once here). */
  total: number;
  none: number;
  /** front id -> live-item count. A multi-front item increments EVERY front
   * it sits on, so these can sum to more than `total` — that's intended. */
  byFront: Record<string, number>;
}

export function computeFocusCounts(sections: TodoSection[], serverDate: string): FocusCounts {
  const index = buildTodoIndex(sections);
  const byFront: Record<string, number> = {};
  let total = 0;
  let none = 0;
  for (const section of sections) {
    if (isDoneSection(section.name)) continue;
    for (const item of section.items) {
      if (item.done) continue;
      if (isSnoozed(item, serverDate)) continue;
      if (isWaiting(item, serverDate, index)) continue;
      total++;
      const fronts = itemFronts(item);
      if (fronts.length) for (const f of fronts) byFront[f] = (byFront[f] || 0) + 1;
      else none++;
    }
  }
  return { total, none, byFront };
}

export function collectSnoozed(sections: TodoSection[], serverDate: string): TodoItem[] {
  const index = buildTodoIndex(sections);
  const out: TodoItem[] = [];
  for (const section of sections) {
    if (isDoneSection(section.name)) continue;
    for (const item of section.items) {
      // Waiting takes precedence — an item snoozed AND waiting only ever
      // shows in the Waiting card, never both.
      if (isSnoozed(item, serverDate) && !isWaiting(item, serverDate, index)) out.push(item);
    }
  }
  return out.sort((a, b) => (a.snoozed_until || '').localeCompare(b.snoozed_until || ''));
}

export interface WaitingEntry {
  item: TodoItem;
  reason: string;
}

export function collectWaiting(sections: TodoSection[], serverDate: string): WaitingEntry[] {
  const index = buildTodoIndex(sections);
  const out: WaitingEntry[] = [];
  for (const section of sections) {
    if (isDoneSection(section.name)) continue;
    for (const item of section.items) {
      if (isWaiting(item, serverDate, index)) out.push({ item, reason: waitingReason(item, index) });
    }
  }
  return out.sort((a, b) => (a.item.after_date || '').localeCompare(b.item.after_date || ''));
}

export function visibleSectionItems(
  section: TodoSection,
  serverDate: string,
  front: string,
  index: Map<string, TodoItem>,
): TodoItem[] {
  return section.items.filter(
    (item) => focusMatch(item, front) && !isSnoozed(item, serverDate) && !isWaiting(item, serverDate, index),
  );
}

export function inWindow(win: GateWindow, hhmm: string): boolean {
  if (!win.start || !win.end || win.start === win.end) return true;
  if (win.start < win.end) return hhmm >= win.start && hhmm < win.end;
  // start > end wraps past midnight (e.g. 15:00→06:00)
  return hhmm >= win.start || hhmm < win.end;
}

/**
 * Context gating: does the current time hide this item? An item's front
 * picks its window (falling back to "*"); outside the window it sinks into
 * the "Not now" group. Exempt — so they always punch through the gates:
 * the hand-picked Now section, anything overdue or due today, and done
 * items (Done has its own card). No rules or no matching window = never
 * hidden.
 */
export function gateHides(
  item: TodoItem,
  sectionName: string,
  rules: TodoViewRules | undefined,
  hhmm: string,
  serverDate: string,
): boolean {
  const windows = rules?.windows;
  if (!windows || item.done || sectionName === LADDER_LABELS[0]) return false;
  if (item.due_by && item.due_by <= serverDate) return false;
  // Multi-front items show if ANY of their fronts' windows is active; a
  // front with no window (and no "*") is ungated, so the item never hides.
  const fronts = itemFronts(item);
  const keys = fronts.length ? fronts : [''];
  let sawWindow = false;
  for (const key of keys) {
    const win = windows[key] ?? windows['*'];
    if (!win) return false;
    sawWindow = true;
    if (inWindow(win, hhmm)) return false;
  }
  return sawWindow;
}

/** The "Up now" strip: overdue + due-today items across the ladder (not
 * done/snoozed/waiting), soonest due date first. */
export function collectUpNow(sections: TodoSection[], serverDate: string): TodoItem[] {
  const index = buildTodoIndex(sections);
  const out: TodoItem[] = [];
  for (const section of sections) {
    if (isDoneSection(section.name)) continue;
    for (const item of section.items) {
      if (item.done || isSnoozed(item, serverDate) || isWaiting(item, serverDate, index)) continue;
      if (item.due_by && item.due_by <= serverDate) out.push(item);
    }
  }
  return out.sort((a, b) => (a.due_by || '').localeCompare(b.due_by || ''));
}

/** Shift an ISO date by n days, parsing at local midnight so DST/UTC can't
 * skew the calendar day. */
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The "Tomorrow" strip: items due tomorrow across the ladder (not
 * done/snoozed/waiting) — a look-ahead digest in the same spirit as Up now.
 * Items stay in their ladder sections; this is a view, not a move. */
export function collectTomorrow(sections: TodoSection[], serverDate: string): TodoItem[] {
  const index = buildTodoIndex(sections);
  const tomorrow = addDaysISO(serverDate, 1);
  const out: TodoItem[] = [];
  for (const section of sections) {
    if (isDoneSection(section.name)) continue;
    for (const item of section.items) {
      if (item.done || isSnoozed(item, serverDate) || isWaiting(item, serverDate, index)) continue;
      if (item.due_by === tomorrow) out.push(item);
    }
  }
  return out;
}
