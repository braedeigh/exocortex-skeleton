// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.
import type { Reminder } from "./Reminder";

/**
 * The root shape of `data/reminders.json`: `{"reminders": [...]}`.
 */
export type RemindersFile = { reminders: Array<Reminder>, };
