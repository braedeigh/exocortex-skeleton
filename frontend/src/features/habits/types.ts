/**
 * Habits domain types — mirror the shapes served by /api/data/today
 * (see routes/habits.py, server.py _load_habit_* helpers, data_helpers.parse_md_sections).
 */

export interface HabitItem {
  text: string;
  /** Raw HABITS.md checkbox state — NOT "done today". Today's completion
   * lives in `habits_log` keyed by habitKey(section, text). Old core.js
   * (loadDashboard) discards this field entirely after load; we keep it
   * typed for fidelity but never read it. */
  done: boolean;
}

export interface HabitSection {
  name: string;
  items: HabitItem[];
}

export type CadenceStage = 'weekly' | 'monthly' | 'retired';

export interface HabitCadenceEntry {
  stage: CadenceStage;
  /** YYYY-MM-DD — next spot-check date for weekly/monthly stages. */
  next_check?: string | null;
  /** Spot-checks passed at the current stage (toward the next rung). */
  passes?: number;
  [key: string]: unknown;
}

/** Keyed by habitKey(section, text) — see habit_log_key in data_helpers.py. */
export type HabitCadenceMap = Record<string, HabitCadenceEntry>;

export interface HabitMetaEntry {
  course_start: string;
  course_days: number;
}

/** Keyed by habitKey(section, text). */
export type HabitMetaMap = Record<string, HabitMetaEntry>;

export interface CadenceConfig {
  graduate_count?: number;
  graduate_recent?: [number, number];
  weekly_to_monthly?: number;
  monthly_to_retire?: number;
  grace_days?: number;
  [key: string]: unknown;
}

/** date (YYYY-MM-DD) -> habitKey(section, text) -> true */
export type HabitsLog = Record<string, Record<string, boolean>>;

export interface HabitSettings {
  hidden: string[];
}

/** habit text (bare, not section-qualified) -> YYYY-MM-DD it was first tracked. */
export type HabitStarts = Record<string, string>;

export interface Streak {
  label: string;
  days: number;
  since: string;
  notes?: string;
}

/** "Working On" aspirations tracker — port of growth_notes.json (see
 * routes/habits.py _load_growth/_save_growth). Not a to-do and not a daily
 * habit yet; a holding pen for habits she's still trying on before they earn
 * a spot in the daily habit sections. Identified by `text` (no id). */
export interface GrowthNote {
  text: string;
  /** YYYY-MM-DD it was added. */
  added: string;
  status: 'active' | 'incorporated';
  /** YYYY-MM-DD it was marked incorporated, else null/absent. */
  incorporated?: string | null;
  notes?: string;
}
