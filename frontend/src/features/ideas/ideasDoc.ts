/**
 * ideasDoc.ts — pure logic for the IDEAS.md vision doc, ported verbatim from
 * static/js/ideas.js (_ideasParseSections / _ideasMdInline / _ideasMdBlock and
 * the preamble/bullet-count bits of renderIdeasDoc).
 *
 * Note: this is deliberately NOT features/journal/markdown.ts (the md.js
 * port). The Ideas tab always had its own tiny renderer with a different
 * dialect — links, `*` bullets, ordered lists, multi-line blockquotes joined
 * with <br> — and the doc is split into ## section cards *before* rendering,
 * so `##` headings never reach the block renderer. Keeping the ideas.js
 * renderer keeps the output byte-identical to the legacy tab.
 */

export interface IdeaSection {
  /** null for the preamble (everything before the first `## `). */
  title: string | null;
  lines: string[];
}

/** Split the doc on `## ` headings. `[0]` is always the preamble (title:
 * null, possibly empty); the rest are titled sections in document order. */
export function parseIdeaSections(md: string): IdeaSection[] {
  const sections: IdeaSection[] = [];
  let cur: IdeaSection = { title: null, lines: [] };
  for (const line of md.split('\n')) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      sections.push(cur);
      cur = { title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections;
}

/** Inline markdown -> HTML: escapes, then links / bold / italic / code. */
export function ideasMdInline(s: string): string {
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

/** Block markdown -> HTML: `- `/`* `/`1. ` lists, `> ` quotes (consecutive
 * lines joined with <br>), `### ` headings, `---` rules, paragraphs. */
export function ideasMdBlock(md: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let quote: string[] | null = null;
  const flushList = () => {
    if (list) {
      out.push('<ul>' + list.join('') + '</ul>');
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote) {
      out.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
      quote = null;
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const li = line.match(/^\s*[-*] (.+)$/);
    const oli = line.match(/^\s*\d+\. (.+)$/);
    const q = line.match(/^> ?(.*)$/);
    const h3 = line.match(/^### (.+)$/);
    if (li || oli) {
      flushQuote();
      (list = list || []).push('<li>' + ideasMdInline(li ? li[1] : oli![1]) + '</li>');
    } else if (q) {
      flushList();
      (quote = quote || []).push(ideasMdInline(q[1]));
    } else if (h3) {
      flushList();
      flushQuote();
      out.push('<h3>' + ideasMdInline(h3[1]) + '</h3>');
    } else if (/^---+$/.test(line)) {
      flushList();
      flushQuote();
      out.push('<hr>');
    } else if (!line.trim()) {
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      out.push('<p>' + ideasMdInline(line) + '</p>');
    }
  }
  flushList();
  flushQuote();
  return out.join('\n');
}

/** The preamble as renderable markdown: drop the `# ` doc title (the page
 * header already says where we are) and any `---` rules, then trim. Empty
 * string means "render nothing". */
export function preambleBody(pre: IdeaSection): string {
  const lines = pre.lines.slice();
  const tIdx = lines.findIndex((l) => /^# (.+)$/.test(l));
  if (tIdx !== -1) lines.splice(tIdx, 1);
  return lines.join('\n').replace(/^-{3,}$/gm, '').trim();
}

/** Bullet count shown as the section-card badge. */
export function countBullets(lines: readonly string[]): number {
  return lines.filter((l) => /^\s*[-*] /.test(l)).length;
}
