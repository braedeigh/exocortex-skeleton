//! Tiny JSON-payload accessors for `propose` — loud, specific errors instead
//! of serde's generic "missing field" noise, since these payloads come from
//! crickets and the error is what tells them what to fix.

use serde_json::Value;

pub fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

pub fn require_str<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    match get_str(v, key) {
        Some(s) if !s.trim().is_empty() => Ok(s),
        Some(_) => Err(format!("`{}` is present but empty", key)),
        None => Err(format!("`{}` is required", key)),
    }
}

pub fn get_str_list(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub fn get_array<'a>(v: &'a Value, key: &str) -> Vec<&'a Value> {
    match v.get(key) {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}
