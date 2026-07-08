/**
 * habitMath.ts — pure port of the cadence/graduation/course logic in
 * static/js/habits.js. Every function takes server_date (or another
 * explicit reference date) as an input; none of them read the wall clock
 * (mirrors reminderMath.ts's contract).
 *
 * One deliberate deviation from the old JS: `recentHabitDone` and
 * `habitStartLabel` there use `new Date()` (client wall clock) instead of
 * the server-derived "today" the rest of the file uses. That's almost
 * certainly an oversight (todayStr() falls back to the client clock only
 * when _serverDate hasn't loaded yet) — here everything is threaded through
 * `todayISO` for consistency and testability.
 */
import type {
  CadenceConfig,
  CadenceStage,
  HabitCadenceEntry,
  HabitCadenceMap,
  HabitMetaEntry,
  HabitMetaMap,
  HabitSection,
  HabitsLog,
} from './types';

export type TimeSegment = 'morning' | 'afternoon' | 'evening';

/** Done-state key for a habit: 'section|text' (mirrors data_helpers.habit_log_key)
 * so the same text can live in Morning AND Evening with independent checkboxes. */
export function habitKey(section: string, text: string): string {
  return (section || '').trim().toLowerCase() + '|' + text;
}

export function habitCadence(
  cadenceMap: HabitCadenceMap | null | undefined,
  section: string,
  item: string,
): HabitCadenceEntry | null {
  return (cadenceMap || {})[habitKey(section, item)] || null;
}

export function isGraduated(c: HabitCadenceEntry | null): boolean {
  return !!c && (c.stage === 'weekly' || c.stage === 'monthly');
}

function dateAtNoon(iso: string): number {
  return new Date(`${iso}T12:00:00`).getTime();
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isHabitDoneOn(log: HabitsLog, section: string, item: string, dateISO: string): boolean {
  return !!(log[dateISO] || {})[habitKey(section, item)];
}

/** Completions in the last `days` days ending at (and including) todayISO —
 * the "still consistent NOW" graduation gate, so a long-dormant habit's
 * stale lifetime count can't keep re-suggesting itself. */
export function recentHabitDone(log: HabitsLog, section: string, item: string, days: number, todayISO: string): number {
  const key = habitKey(section, item);
  const today = new Date(`${todayISO}T12:00:00`);
  let n = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = fmtDate(d);
    if ((log[ds] || {})[key]) n++;
  }
  return n;
}

/** Lifetime completions across the whole log (not just a trailing window). */
export function habitCount(log: HabitsLog, habit: string, section: string): number {
  const key = habitKey(section, habit);
  let count = 0;
  for (const date in log) {
    if (log[date]?.[key]) count++;
  }
  return count;
}

export function habitMeta(metaMap: HabitMetaMap | null | undefined, section: string, item: string): HabitMetaEntry | null {
  return (metaMap || {})[habitKey(section, item)] || null;
}

/** A plain daily habit that's proven AND still consistent -> offer graduation. */
export function readyToGraduate(
  section: string,
  item: string,
  cadenceMap: HabitCadenceMap | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  log: HabitsLog,
  cadenceConfig: CadenceConfig | null | undefined,
  todayISO: string,
): boolean {
  if (habitCadence(cadenceMap, section, item)) return false; // already on the ladder
  if (habitMeta(metaMap, section, item)) return false; // temporary/course habits don't graduate
  const cfg = cadenceConfig || {};
  const need = cfg.graduate_count ?? 60;
  const [rn, rd] = cfg.graduate_recent ?? [24, 30];
  return habitCount(log, item, section) >= need && recentHabitDone(log, section, item, rd, todayISO) >= rn;
}

/** A graduated habit that's passed enough spot-checks -> offer the next rung. */
export function readyToPromote(c: HabitCadenceEntry, cadenceConfig: CadenceConfig | null | undefined): boolean {
  const cfg = cadenceConfig || {};
  if (c.stage === 'weekly') return (c.passes || 0) >= (cfg.weekly_to_monthly ?? 4);
  if (c.stage === 'monthly') return (c.passes || 0) >= (cfg.monthly_to_retire ?? 3);
  return false;
}

/** Passes needed at the current stage (for a "2/4 -> monthly" progress label). */
export function promoteTarget(c: HabitCadenceEntry, cadenceConfig: CadenceConfig | null | undefined): number {
  const cfg = cadenceConfig || {};
  if (c.stage === 'weekly') return cfg.weekly_to_monthly ?? 4;
  if (c.stage === 'monthly') return cfg.monthly_to_retire ?? 3;
  return 0;
}

export const STAGE_NEXT_LABEL: Partial<Record<CadenceStage, string>> = { weekly: 'monthly', monthly: 'retire' };

/** Is a graduated habit's spot-check open today? (check day + grace window). */
export function spotCheckDue(
  cadenceMap: HabitCadenceMap | null | undefined,
  section: string,
  item: string,
  todayISO: string,
  cadenceConfig: CadenceConfig | null | undefined,
): boolean {
  const c = habitCadence(cadenceMap, section, item);
  if (!isGraduated(c) || !c?.next_check) return false;
  if (todayISO < c.next_check) return false;
  const grace = (cadenceConfig || {}).grace_days ?? 1;
  const gap = Math.round((dateAtNoon(todayISO) - dateAtNoon(c.next_check)) / 86400000);
  return gap <= grace;
}

export interface CourseInfo {
  start: string;
  days: number;
  dayNum: number;
  expired: boolean;
}

/** Course habits (time-limited, e.g. a 10-day antibiotic). */
export function courseInfo(
  metaMap: HabitMetaMap | null | undefined,
  section: string,
  item: string,
  todayISO: string,
): CourseInfo | null {
  const m = habitMeta(metaMap, section, item);
  if (!m || !m.course_days) return null;
  const start = dateAtNoon(m.course_start);
  const dayNum = Math.floor((dateAtNoon(todayISO) - start) / 86400000) + 1;
  return { start: m.course_start, days: m.course_days, dayNum, expired: dayNum > m.course_days };
}

/** Should this habit appear in today's daily card? Plain daily -> always;
 * graduated -> only on its open spot-check day; retired -> never;
 * finished course -> never. */
export function showsInDaily(
  section: string,
  item: string,
  cadenceMap: HabitCadenceMap | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  todayISO: string,
  cadenceConfig: CadenceConfig | null | undefined,
): boolean {
  const ci = courseInfo(metaMap, section, item, todayISO);
  if (ci && ci.expired) return false;
  const c = habitCadence(cadenceMap, section, item);
  if (!c) return true;
  if (c.stage === 'retired') return false;
  return spotCheckDue(cadenceMap, section, item, todayISO, cadenceConfig);
}

export interface SectionDef {
  label: 'Morning' | 'Midday' | 'Evening';
  /** The actual HABITS.md section name for this slot (falls back to the
   * canonical name when the file has no matching section). */
  name: string;
}

/** Actual HABITS.md section names for the Morning/Midday/Evening slots. */
export function habitSectionDefs(habits: HabitSection[] | null | undefined): SectionDef[] {
  let m = 'Morning';
  let mid = 'Midday';
  let n = 'Evening / Night';
  for (const s of habits || []) {
    const x = s.name.toLowerCase();
    if (x === 'morning') m = s.name;
    else if (x === 'midday') mid = s.name;
    else if (x === 'night' || x === 'evening / night') n = s.name;
  }
  return [
    { label: 'Morning', name: m },
    { label: 'Midday', name: mid },
    { label: 'Evening', name: n },
  ];
}

/** Mirrors server.py's _common_data() time_of_day bucketing exactly, so the
 * default segment is derivable client-side from server_hour alone. */
export function pickTimeSegment(serverHour: number): TimeSegment {
  if (serverHour >= 5 && serverHour < 11) return 'morning';
  if (serverHour >= 11 && serverHour < 18) return 'afternoon';
  return 'evening';
}

export function habitStartLabel(starts: Record<string, string> | null | undefined, item: string, todayISO: string): string {
  const d = (starts || {})[item];
  if (!d) return '';
  const days = Math.floor((dateAtNoon(todayISO) - dateAtNoon(d)) / 86400000);
  if (days === 0) return 'today · ';
  if (days === 1) return '1d · ';
  return `${days}d · `;
}

/** Which HABITS.md section (lowercase name) shows in which time segment, and
 * how it's labeled/colored in the daily card — mirrors renderHabits'
 * sectionConfig map in habits.js. */
const SECTION_DISPLAY: Record<string, { time: TimeSegment; label: string; color: string }> = {
  morning: { time: 'morning', label: 'This morning', color: 'var(--morning)' },
  midday: { time: 'afternoon', label: 'Midday', color: 'var(--ongoing)' },
  night: { time: 'evening', label: 'Tonight', color: 'var(--evening)' },
  'evening / night': { time: 'evening', label: 'Tonight', color: 'var(--evening)' },
};

export interface DailySectionView {
  sectionName: string;
  label: string;
  color: string;
  /** Habit text, in HABITS.md order, already filtered to hidden + showsInDaily. */
  items: string[];
  allDone: boolean;
}

/** The habit cards for the selected time segment — one per HABITS.md section
 * that maps to `segment`, skipped entirely when it has no visible items. */
export function dailySectionViews(
  habits: HabitSection[] | null | undefined,
  segment: TimeSegment,
  hidden: string[] | null | undefined,
  cadenceMap: HabitCadenceMap | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  log: HabitsLog,
  cadenceConfig: CadenceConfig | null | undefined,
  todayISO: string,
): DailySectionView[] {
  const hiddenList = hidden || [];
  const todayLog = log[todayISO] || {};
  const out: DailySectionView[] = [];
  for (const section of habits || []) {
    const cfg = SECTION_DISPLAY[section.name.toLowerCase()];
    if (!cfg || cfg.time !== segment) continue;
    const items = section.items
      .map((i) => i.text)
      .filter(
        (item) =>
          !hiddenList.includes(item) && showsInDaily(section.name, item, cadenceMap, metaMap, todayISO, cadenceConfig),
      );
    if (!items.length) continue;
    const allDone = items.every((item) => !!todayLog[habitKey(section.name, item)]);
    out.push({ sectionName: section.name, label: cfg.label, color: cfg.color, items, allDone });
  }
  return out;
}

/** HABITS.md sections that feed the daily cards / graduation nudges — a
 * "Weekly"/"Recurring"/"Trying to add" building-toward section never does. */
const DAILY_SECTION_NAMES = ['morning', 'midday', 'night', 'evening / night'];

export interface GraduationCandidate {
  section: string;
  item: string;
}

/** Proven daily habits ready to graduate, across every daily section — the
 * To-Do page nudge (renderGraduationPrompts in the old JS). Doesn't know
 * about the client-side snooze map or transient "just graduated" state;
 * callers filter those in. */
export function habitsReadyToGraduate(
  habits: HabitSection[] | null | undefined,
  hidden: string[] | null | undefined,
  cadenceMap: HabitCadenceMap | null | undefined,
  metaMap: HabitMetaMap | null | undefined,
  log: HabitsLog,
  cadenceConfig: CadenceConfig | null | undefined,
  todayISO: string,
): GraduationCandidate[] {
  const hiddenList = hidden || [];
  const out: GraduationCandidate[] = [];
  for (const section of habits || []) {
    if (!DAILY_SECTION_NAMES.includes(section.name.toLowerCase())) continue;
    for (const it of section.items) {
      const item = it.text;
      if (hiddenList.includes(item)) continue;
      if (!readyToGraduate(section.name, item, cadenceMap, metaMap, log, cadenceConfig, todayISO)) continue;
      out.push({ section: section.name, item });
    }
  }
  return out;
}

/** "Not now" snooze on a graduate nudge — pure predicate over the
 * localStorage-backed map (see habitStorage.ts for the read/write side). */
export function isGradSnoozed(snoozeMap: Record<string, string> | null | undefined, section: string, item: string, todayISO: string): boolean {
  const until = (snoozeMap || {})[habitKey(section, item)];
  return !!until && until > todayISO;
}
