//! The parent DAG. Mandatory cycle detection — `a → b → c → a` must be
//! refused at write time, and `lint` must catch one that snuck onto disk.

use std::collections::{HashMap, HashSet};

pub type Graph = HashMap<String, Vec<String>>;

/// Would giving `slug` the parent list `new_parents` (replacing whatever
/// `graph` currently says `slug`'s parents are, or adding `slug` fresh if
/// it's not in `graph` yet) create a cycle? Returns the offending path
/// (`slug`, ..., `slug`) if so.
pub fn would_create_cycle(graph: &Graph, slug: &str, new_parents: &[String]) -> Option<Vec<String>> {
    let mut path = vec![slug.to_string()];
    let mut visited: HashSet<String> = HashSet::new();
    walk(slug, slug, graph, new_parents, &mut visited, &mut path)
}

fn parents_of<'a>(node: &str, target: &str, graph: &'a Graph, override_parents: &'a [String]) -> std::borrow::Cow<'a, [String]> {
    if node == target {
        std::borrow::Cow::Borrowed(override_parents)
    } else {
        match graph.get(node) {
            Some(p) => std::borrow::Cow::Borrowed(p.as_slice()),
            None => std::borrow::Cow::Owned(Vec::new()),
        }
    }
}

fn walk(
    current: &str,
    target: &str,
    graph: &Graph,
    override_parents: &[String],
    visited: &mut HashSet<String>,
    path: &mut Vec<String>,
) -> Option<Vec<String>> {
    let parents = parents_of(current, target, graph, override_parents).into_owned();
    for p in parents {
        if p == target {
            let mut result = path.clone();
            result.push(p);
            return Some(result);
        }
        if visited.contains(&p) {
            continue;
        }
        visited.insert(p.clone());
        path.push(p.clone());
        if let Some(r) = walk(&p, target, graph, override_parents, visited, path) {
            return Some(r);
        }
        path.pop();
    }
    None
}

/// Every cycle already present in `graph` (used by `lint`, which must catch
/// a cycle that reached disk some other way). Returns one path per distinct
/// cycle found; a thread can appear in more than one reported path if it
/// sits at the join of two loops, which is fine — lint just needs to fail.
pub fn find_all_cycles(graph: &Graph) -> Vec<Vec<String>> {
    let mut cycles = Vec::new();
    let mut globally_done: HashSet<String> = HashSet::new();
    let mut slugs: Vec<&String> = graph.keys().collect();
    slugs.sort();
    for start in slugs {
        if globally_done.contains(start) {
            continue;
        }
        let empty: Vec<String> = Vec::new();
        if let Some(cyc) = would_create_cycle(graph, start, graph.get(start).unwrap_or(&empty)) {
            cycles.push(cyc);
        }
        globally_done.insert(start.clone());
    }
    cycles
}
