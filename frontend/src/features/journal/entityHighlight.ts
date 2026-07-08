/**
 * entityHighlight.ts — port of journal.html's loadEntities()/highlightEntities()
 * (static/js/md.js + inline script). The legacy version walks the live DOM
 * with a TreeWalker; this version operates on the rendered HTML *string*
 * instead (a small tag/text tokenizer), which keeps it usable both from
 * React (dangerouslySetInnerHTML) and from plain unit tests with no DOM.
 *
 * Behavior kept identical to the legacy walk:
 *  - terms = each person's first name + every alias, first person to claim a
 *    term wins, longest-first so multi-word aliases beat shorter ones,
 *    case-insensitive word-boundary match.
 *  - matches inside <code>, <h1>/<h2>/<h3>, or an already-wrapped .entity
 *    span are left alone.
 *  - each match gets wrapped in <span class="entity" data-slug="...">,
 *    colored via entityHue(slug) (same hash -> hue -> hsl() as legacy).
 */
import { entityHue } from './markdown';
import type { Person } from './types';

export interface EntityMatcher {
  regex: RegExp | null;
  matchToSlug: Map<string, string>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the one big matcher from the /api/people roster. */
export function buildEntityMatcher(people: Person[]): EntityMatcher {
  const matchToSlug = new Map<string, string>();
  const terms: string[] = [];

  const addTerm = (term: string | undefined | null, slug: string) => {
    const t = (term || '').trim();
    const k = t.toLowerCase();
    if (!k || matchToSlug.has(k)) return; // first person to claim a term wins
    matchToSlug.set(k, slug);
    terms.push(t);
  };

  for (const p of people) {
    addTerm(p.name.split(' ')[0], p.id); // first name as written in prose
    for (const a of p.aliases || []) addTerm(a, p.id); // "my landlord" -> sally
  }

  if (!terms.length) return { regex: null, matchToSlug };

  terms.sort((a, b) => b.length - a.length);
  const regex = new RegExp('\\b(' + terms.map(escapeRe).join('|') + ')\\b', 'gi');
  return { regex, matchToSlug };
}

const SKIP_TAGS = new Set(['code', 'h1', 'h2', 'h3']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/**
 * Wrap known-person matches in `html` (already-rendered markdown) with
 * `<span class="entity" data-slug="...">`. Skips text inside <code>,
 * headings, or an existing .entity span (defensive — the html this is fed
 * in practice never already contains one, since it's applied once per
 * render, but this matches the legacy walk's guard).
 */
export function highlightEntities(html: string, matcher: EntityMatcher): string {
  if (!matcher.regex || !html) return html;
  const regex = matcher.regex;

  const tokens = html.split(/(<[^>]+>)/g);
  const stack: string[] = [];
  let out = '';

  for (const token of tokens) {
    if (!token) continue;

    if (token[0] === '<') {
      out += token;
      const closeMatch = /^<\/\s*([a-zA-Z0-9]+)/.exec(token);
      if (closeMatch) {
        const name = closeMatch[1].toLowerCase();
        const idx = stack.lastIndexOf(name);
        if (idx !== -1) stack.splice(idx, 1);
        continue;
      }
      const openMatch = /^<\s*([a-zA-Z0-9]+)([^>]*)>/.exec(token);
      if (openMatch) {
        const name = openMatch[1].toLowerCase();
        const attrs = openMatch[2] || '';
        const selfClosing = /\/\s*$/.test(token) || VOID_TAGS.has(name);
        const isEntitySpan = name === 'span' && /class\s*=\s*"[^"]*\bentity\b/.test(attrs);
        if (!selfClosing) stack.push(isEntitySpan ? 'entity' : name);
      }
      continue;
    }

    const inSkip = stack.some((t) => SKIP_TAGS.has(t) || t === 'entity');
    if (inSkip) {
      out += token;
      continue;
    }

    out += token.replace(regex, (match) => {
      const slug = matcher.matchToSlug.get(match.toLowerCase());
      if (!slug) return match;
      const hue = entityHue(slug);
      const color = `hsl(${hue} 70% 66%)`;
      return `<span class="entity" data-slug="${slug}" style="color:${color};border-bottom-color:${color}">${match}</span>`;
    });
  }

  return out;
}
