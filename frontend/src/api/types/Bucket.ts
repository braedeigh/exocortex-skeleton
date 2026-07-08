// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.

/**
 * The priority-ladder bucket a [`Todo`] currently lives in.
 *
 * Serializes/deserializes as the lowercase `snake_case` key used in
 * `todos.json` (e.g. `Bucket::UpNext` <-> `"up_next"`).
 */
export type Bucket = "now" | "up_next" | "today" | "tomorrow" | "later" | "someday" | "done";
