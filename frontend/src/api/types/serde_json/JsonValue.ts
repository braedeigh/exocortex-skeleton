// hand-maintained; formerly ts-rs-generated; re-derive from exo-core if the Rust rewrite resumes.

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;
