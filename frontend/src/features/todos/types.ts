import type {
  CadenceConfig,
  HabitCadenceMap,
  HabitMetaMap,
  HabitSection,
  HabitSettings,
  HabitsLog,
  HabitStarts,
  Streak,
} from '../habits/types';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  created?: string | null;
  due_by?: string | null;
  due_time?: string | null;
  notes?: string | null;
  place_id?: string | null;
  category?: string | null;
  status?: string | null;
  theme?: string | null;
  duration_min?: number | null;
  done_at?: string | null;
  snoozed_until?: string | null;
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

export interface TodayDataHabitsFields {
  habits?: HabitSection[];
  habit_settings?: HabitSettings;
  habit_starts?: HabitStarts;
  habits_log?: HabitsLog;
  habit_cadence?: HabitCadenceMap;
  habit_meta?: HabitMetaMap;
  cadence_config?: CadenceConfig;
  streaks?: Streak[] | FrostedStream;
}

export interface TodayData extends TodayDataHabitsFields {
  server_date: string;
  server_hour: number;
  /** Human-readable date line, e.g. "Wednesday, July 8" (server.py's date_text). */
  date?: string;
  time_of_day: TimeOfDay;
  todos: TodosStream;
  reminders?: ReminderDef[];
  activity_log: ActivityEntry[];
  private_act_types: string[];
  [key: string]: unknown;
}
