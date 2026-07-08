// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.

/**
 * A single recurring reminder / habit tracker.
 */
export type Reminder = { id: string, label: string, 
/**
 * The reminder's kind, e.g. `"estradiol"`, `"laundry-sheets"`. Named
 * `kind` on the Rust side because `type` is a keyword; the JSON key is
 * still `"type"`.
 */
type: string, emoji?: string | null, color?: string | null, schedule?: string | null, every_days?: number | null, overdue_days?: number | null, weekdays: Array<string>, mode?: string | null, companion?: string | null, times: Array<string>, private: boolean, due_text?: string | null, shape?: string | null, snoozed_until?: string | null, };
