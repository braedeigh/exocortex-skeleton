/**
 * contactMath.ts — pure keep-in-touch logic ported from static/js/contacts.js:
 * manage-panel status coloring, history-by-date grouping for the contact
 * calendar, and the localStorage "snooze until tomorrow" map.
 */
import type { Contact, ContactHistoryEntry } from './types';

/** Method → dot color on the contact calendar + legend. */
export const METHOD_COLORS: Record<string, string> = {
  call: '#3498db',
  text: '#2ecc71',
  facetime: '#9b59b6',
  visit: '#e67e22',
};

export const CONTACT_METHODS = ['Call', 'Text', 'FaceTime', 'Visit'] as const;

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export interface ContactStatus {
  /** CSS color (theme var). */
  color: string;
  statusText: string;
}

/** Manage-panel status line: never → red, today/under a week → green, under
 * threshold → yellow, at/over threshold → red (manageContactsPanelHtml). */
export function contactStatus(c: Contact): ContactStatus {
  const days = c.days_since;
  if (days === null || days === undefined) {
    return { color: 'var(--red)', statusText: 'Never contacted' };
  }
  if (days === 0) return { color: 'var(--green)', statusText: 'Today' };
  if (days < 7) return { color: 'var(--green)', statusText: `${days} day${days !== 1 ? 's' : ''} ago` };
  if (days < c.threshold_days) return { color: 'var(--yellow)', statusText: `${days} days ago` };
  return { color: 'var(--red)', statusText: `${days} days ago` };
}

/** Group history entries by date — keep every method (last one wins for the
 * dot's color, mirrors renderContactCalendar). */
export function historyByDate(history: ContactHistoryEntry[] | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of history || []) {
    if (!out[h.date]) out[h.date] = [];
    out[h.date].push(h.method);
  }
  return out;
}

/** The dot shown for a date: last method logged that day, or null when none. */
export function lastMethodOn(byDate: Record<string, string[]>, date: string): string | null {
  const methods = byDate[date];
  if (!methods || !methods.length) return null;
  return methods[methods.length - 1];
}

// --- "Tomorrow" snoozes (localStorage 'exo-contact-snooze') -------------------

export const CONTACT_SNOOZE_KEY = 'exo-contact-snooze';

/** Drop stale entries: a snooze only counts on the day it was set. */
export function cleanContactSnoozes(raw: Record<string, string> | null | undefined, todayISO: string): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const k of Object.keys(raw || {})) {
    if ((raw as Record<string, string>)[k] === todayISO) cleaned[k] = todayISO;
  }
  return cleaned;
}

export function readContactSnoozes(todayISO: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONTACT_SNOOZE_KEY);
    if (!raw) return {};
    return cleanContactSnoozes(JSON.parse(raw) as Record<string, string>, todayISO);
  } catch {
    return {};
  }
}

export function snoozeContactForToday(name: string, todayISO: string): void {
  const snoozes = readContactSnoozes(todayISO);
  snoozes[name] = todayISO;
  try {
    localStorage.setItem(CONTACT_SNOOZE_KEY, JSON.stringify(snoozes));
  } catch {
    // localStorage unavailable — snooze just won't persist
  }
}
