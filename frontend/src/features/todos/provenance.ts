/**
 * provenance.ts — pure helpers for showing WHO wrote a to-do and WHERE an
 * agent's note came from. TS side of todo_provenance.py.
 *
 * Two jobs:
 *  - `agentLabel('cricket:todos')` -> "Todos cricket": a readable name for
 *    the agent names the backend stamps.
 *  - `refTarget('card:2026-08-20.1432a')` -> a place the UI can open. Every
 *    agent note carries at least one `<kind>:<value>` ref; this turns each
 *    kind into either an in-app route, an external URL, or (for `file:`)
 *    plain text — a vault path isn't a page, so it's shown, not linked.
 *
 * Prompt distilled: "the LLMs have been writing too much information that i
 * don't know where it was sourced from" — every agent line now shows its
 * author and a tappable citation.
 */
import type { TodoOrigin } from './types';

const KNOWN: Record<string, string> = {
  owner: 'you',
  triage: 'Triage',
  keeper: 'the Keeper',
};

export function agentLabel(by: string): string {
  if (KNOWN[by]) return KNOWN[by];
  // 'cricket:todos' -> "Todos cricket"; 'session:foo-bar' -> "Foo bar session".
  const [kind, rest] = by.split(':', 2);
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  if (rest) return `${cap(rest.replace(/[-_]+/g, ' '))} ${kind}`;
  return cap(kind.replace(/[-_]+/g, ' '));
}

export type RefTarget =
  | { kind: 'route'; label: string; to: string; search?: Record<string, string> }
  | { kind: 'external'; label: string; href: string }
  | { kind: 'text'; label: string };

/** A short label + where it opens, for one `<kind>:<value>` ref. Unknown or
 * malformed refs render as text rather than a broken link. */
export function refTarget(ref: string): RefTarget {
  const i = ref.indexOf(':');
  const kind = i > 0 ? ref.slice(0, i) : '';
  const value = i > 0 ? ref.slice(i + 1) : ref;
  switch (kind) {
    case 'card':
      return { kind: 'route', label: `journal ${value.slice(0, 10)}`, to: '/journal', search: { date: value.slice(0, 10) } };
    case 'journal':
      return { kind: 'route', label: `journal ${value}`, to: '/journal', search: { date: value } };
    case 'conv':
      return { kind: 'route', label: 'conversation', to: `/observatory/${value}` };
    case 'thread':
      return { kind: 'route', label: `thread ${value}`, to: `/threads/${value}` };
    case 'url': {
      let host = value;
      try {
        host = new URL(value).host;
      } catch {
        /* keep the raw value */
      }
      return { kind: 'external', label: host, href: value };
    }
    case 'file':
      return { kind: 'text', label: value };
    default:
      return { kind: 'text', label: ref };
  }
}

/** "Added by Triage · Aug 26" / "Added Aug 26 · author unrecorded". Items
 * from before 2026-08-27 have no origin, and the line says so — it never
 * guesses 'you'. */
export function originLine(origin: TodoOrigin | null | undefined, created: string | null | undefined, fmt: (d: string) => string): string {
  const when = origin?.at ? fmt(origin.at.slice(0, 10)) : created ? fmt(created) : '';
  if (!origin?.by) return when ? `Added ${when} · author unrecorded` : 'Author unrecorded';
  if (origin.by === 'owner') return `Added by you${when ? ` · ${when}` : ''}`;
  return `Added by ${agentLabel(origin.by)}${when ? ` · ${when}` : ''}`;
}

/** Minute stamp 'YYYY-MM-DDTHH:MM' -> "Aug 26, 14:32" via the caller's date
 * formatter; a bare date just formats. */
export function stampLabel(at: string, fmt: (d: string) => string): string {
  const day = fmt(at.slice(0, 10));
  const time = at.length > 10 ? at.slice(11, 16) : '';
  return time ? `${day}, ${time}` : day;
}
