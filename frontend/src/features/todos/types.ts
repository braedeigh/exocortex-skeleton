import type {
  CadenceConfig,
  GrowthNote,
  HabitCadenceMap,
  HabitMetaMap,
  HabitSection,
  HabitSettings,
  HabitsLog,
  HabitStarts,
  Streak,
} from '../habits/types';

export interface SubTask {
  id: string;
  text: string;
  done: boolean;
}

/** Who created this to-do (TS twin of todo_provenance.py). `by` is 'owner'
 * or an agent name ('triage', 'cricket:todos'); `conv` is the Observatory
 * conversation it came out of, when there was one. Items from before
 * 2026-08-27 have no origin at all — the UI says "unrecorded", never guesses. */
export interface TodoOrigin {
  by: string;
  at: string;
  conv?: string | null;
}

/** A short, cited line an agent left on a to-do. Never mixed into `notes`
 * (the owner's own words); capped server-side at 240 chars; every note
 * carries at least one `<kind>:<value>` ref the UI turns into a link. */
export interface AgentNote {
  by: string;
  at: string;
  text: string;
  refs: string[];
  conv?: string | null;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  created?: string | null;
  due_by?: string | null;
  due_time?: string | null;
  notes?: string | null;
  place_id?: string | null;
  /** Front ids (fronts.json) — a to-do can sit on several life fronts at
   * once. Absent or empty = untagged. Read via todoHelpers.itemFronts. */
  fronts?: string[] | null;
  duration_min?: number | null;
  /** Auto stamp of when she marked it done, 'YYYY-MM-DDTHH:MM' (minute
   * precision since 2026-07-20); legacy items stay date-only ('YYYY-MM-DD').
   * The day part is always `done_at.slice(0, 10)` — readers that only need
   * the day must slice rather than assume a fixed-length date string. */
  done_at?: string | null;
  /** Assignable "actually done" moment (edit form's Done block) — distinct
   * from `done_at`, which is the auto stamp of when she marked it done. */
  finished_on?: string | null;
  finished_time?: string | null;
  /** Optional free-text note on how it went, staged in the Done block. */
  finished_note?: string | null;
  snoozed_until?: string | null;
  /** "Do after" — hidden until this date arrives (see isWaiting in todoHelpers). */
  after_date?: string | null;
  /** "Do after" — hidden while the referenced to-do (by id) exists and isn't done. */
  after_id?: string | null;
  /** Small checkable items under this to-do. Absent = none (see routes/todos.py subtask endpoints). */
  subtasks?: SubTask[] | null;
  origin?: TodoOrigin | null;
  agent_notes?: AgentNote[] | null;
}

export interface TodoSection {
  name: string;
  items: TodoItem[];
  manual_order: boolean;
}

export interface FrostedStream {
  _frosted: true;
  shape: string;
  count?: number;
}

export type TodosStream = TodoSection[] | FrostedStream;

export function isFrosted(v: unknown): v is FrostedStream {
  return !!v && typeof v === 'object' && (v as FrostedStream)._frosted === true;
}

export interface ActivityEntry {
  date: string;
  type: string;
}

/** One row of server.py's load_health_data() (habits.csv). Only the symptom
 * columns the today page reads are typed; the CSV carries many more. */
export interface HealthDay {
  date: string;
  energy?: number | null;
  nose_congestion?: number | null;
  brain_fog?: number | null;
  abdominal_pain?: number | null;
  hand_pain?: number | null;
  headache?: number | null;
  nose_spray?: number | null;
  [key: string]: unknown;
}

/** symptom column -> level ("0".."3") -> the user's own definition text. */
export type SymptomDefinitions = Record<string, Record<string, string>>;

export type ReminderShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'ring';
export type ReminderSchedule = 'interval' | 'weekly';
export type ReminderMode = 'log' | 'countdown' | 'track';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface ReminderDef {
  id: string;
  type: string;
  label: string;
  emoji?: string | null;
  color?: string | null;
  shape?: ReminderShape | null;
  schedule?: ReminderSchedule | null;
  every_days?: number | null;
  overdue_days?: number | null;
  weekdays?: number[] | null;
  mode?: ReminderMode | null;
  companion?: string | null;
  times?: TimeOfDay[] | null;
  private?: boolean;
  due_text?: string | null;
  snoozed_until?: string | null;
}

/** One visibility window, "HH:MM"–"HH:MM"; start > end wraps past midnight
 * (e.g. 15:00→06:00 = afternoon through early morning). */
export interface GateWindow {
  start: string;
  end: string;
}

/** Context-gating rules (vault's todo_view_rules.json): per-front visibility
 * windows, keyed by front id; "*" is the default for unlisted/untagged. */
export interface TodoViewRules {
  windows?: Record<string, GateWindow>;
}

export interface TodayDataHabitsFields {
  habits?: HabitSection[];
  habit_settings?: HabitSettings;
  habit_starts?: HabitStarts;
  habits_log?: HabitsLog;
  habit_cadence?: HabitCadenceMap;
  habit_meta?: HabitMetaMap;
  cadence_config?: CadenceConfig;
  streaks?: Streak[] | FrostedStream;
  growth_notes?: GrowthNote[];
}

export interface TodayData extends TodayDataHabitsFields {
  server_date: string;
  server_hour: number;
  /** Human-readable date line, e.g. "Wednesday, July 8" (server.py's date_text). */
  date?: string;
  time_of_day: TimeOfDay;
  todos: TodosStream;
  reminders?: ReminderDef[];
  health_data?: HealthDay[];
  activity_log: ActivityEntry[];
  private_act_types: string[];
  todo_view_rules?: TodoViewRules;
  [key: string]: unknown;
}
