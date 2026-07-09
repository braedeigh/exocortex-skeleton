/**
 * types.ts — shapes for GET /api/data/car (server.py get_data_car) and the
 * car_maintenance.json store (routes/car.py). Mirrors the legacy globals the
 * old car.js read off `D` (D.car_maintenance, D.car_notes).
 */

export interface CarEntry {
  id: string;
  /** Maintenance kind — one of the known keys (oil_change, brake_pads,
   * registration) or any custom snake_case string ("other" fallback). */
  type: string;
  /** ISO date the work happened, or null. */
  date: string | null;
  /** Odometer reading — the server stores whatever JSON value was posted
   * (string from the old form, number from other writers), null if blank. */
  mileage: number | string | null;
  notes: string;
  /** ISO date the next round is due, or null (sorts last). */
  next_due: string | null;
}

export interface CarMaintenance {
  entries?: CarEntry[];
}

export interface CarNotes {
  text?: string;
}

/** The slice of /api/data/car this page reads. The endpoint also ships the
 * _common_data() extras (streaks, dev_notes, tab_todos…) — typed loosely here
 * since the native page doesn't render them (tab-todos strip is a known
 * todos-feature gap, see MIGRATION_NOTES.md). */
export interface CarData {
  server_date?: string;
  car_maintenance?: CarMaintenance | null;
  car_notes?: CarNotes | null;
  [key: string]: unknown;
}
