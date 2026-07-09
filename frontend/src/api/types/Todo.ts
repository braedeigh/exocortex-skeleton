// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.

/**
 * A single life to-do item.
 *
 * Only `id` and `text` are guaranteed present on every historical row;
 * everything else is optional because the JSON file has accreted fields
 * organically over time rather than from a fixed schema.
 */
export type Todo = { id: string, text: string, done: boolean, created?: string | null, due_by?: string | null, due_time?: string | null, notes?: string | null, snoozed_until?: string | null, theme?: string | null, 
/**
 * Legacy completion-date field. Newer rows use `done_at` instead; both
 * are kept because live data still has both in different rows.
 */
completed?: string | null, done_at?: string | null, category?: string | null, status?: string | null, duration_min?: number | null, after_date?: string | null, after_id?: string | null, };
