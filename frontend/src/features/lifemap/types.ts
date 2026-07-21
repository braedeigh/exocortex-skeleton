/**
 * Life Map domain types — the payload of GET /api/data/map (server.py
 * get_data_map). Habit shapes are shared with features/habits/types.
 */
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
import type { ActivityEntry, HealthDay, ReminderDef, TimeOfDay } from '../todos/types';

export interface RunEntry {
  date: string;
  minutes?: number | null;
  notes?: string | null;
}

export interface RunsData {
  target_per_week?: number;
  runs: RunEntry[];
}

export interface KitchenTrip {
  date: string;
}

export interface ContactHistoryEntry {
  date: string;
  method: string;
}

export interface Contact {
  name: string;
  threshold_days: number;
  last_contact?: string | null;
  method?: string | null;
  /** Computed server-side (days since last_contact); null = never contacted. */
  days_since?: number | null;
  history?: ContactHistoryEntry[];
}

export interface MapData {
  server_date: string;
  server_hour: number;
  time_of_day: TimeOfDay;
  habits?: HabitSection[];
  habit_settings?: HabitSettings;
  habit_starts?: HabitStarts;
  habits_log?: HabitsLog;
  habit_cadence?: HabitCadenceMap;
  habit_meta?: HabitMetaMap;
  cadence_config?: CadenceConfig;
  health_data?: HealthDay[];
  runs?: RunsData;
  kitchen_trips?: KitchenTrip[];
  activity_log: ActivityEntry[];
  contacts?: Contact[];
  reminders?: ReminderDef[];
  private_act_types?: string[];
  /** Retired day counters (routes/streaks.py) — the Retired card. Frosted
   * (non-array) in public view, same as the Today tab's streaks. */
  retired_streaks?: Streak[] | unknown;
  [key: string]: unknown;
}

export type { ActivityEntry, ReminderDef, TimeOfDay };
