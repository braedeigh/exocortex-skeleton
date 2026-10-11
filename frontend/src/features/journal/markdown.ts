/**
 * markdown.ts — turns the small slice of markdown this app writes into HTML.
 *
 * It covers headings, a horizontal rule, bold and italic, inline code,
 * blockquotes, "- " lists, tables and paragraphs. It is deliberately tiny and
 * is not a full markdown engine: anything else comes out as plain text.
 *
 * Used wherever the app shows written text: the journal and thread pages, the
 * person page, the research reader, the Keeper preview (keeperMarkdown.ts adds
 * wikilinks on top) and the Observatory chat (observatory/replyViews.tsx).
 * A change here changes all of them. Each page styles the HTML itself; the
 * chat's table styles are in observatory/ObservatoryPage.module.css.
 */

// Split one table row into its cells. The outer pipes are dropped, and a pipe
// written as "\|" stays inside its cell as a literal pipe: it is swapped for a
// stand-in character before the split and put back after. (A regex lookbehind
// would be shorter, but older Safari refuses to load a file that contains one.)
const ESCAPED_PIPE = '\u0002';
function tableCells(line: string): string[] {
  const inner = line.trim().split('\\|').join(ESCAPED_PIPE).replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim().split(ESCAPED_PIPE).join('|'));
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

// Turn each markdown table into a real HTML table.
// A table is a row of pipes, then a divider row of dashes, then more rows of
// pipes. Without this, a table reaches the screen as one long paragraph of
// pipes and dashes. The table is written on a single line with a blank line on
// each side, so the paragraph step below treats it as its own block. Runs after
// HTML escaping, so cell text is already safe, and before the bold/italic/code
// steps, so those still apply inside cells.
// Prompt that produced it: "This doesn't print right in my UI" (a table in the
// Observatory chat, shown as raw pipes).
function tablesToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const startsTable =
      TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]);
    if (!startsTable) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const head = tableCells(lines[i]);
    i += 2;
    const rows: string[][] = [];
    while (i < lines.length && TABLE_ROW.test(lines[i])) {
      rows.push(tableCells(lines[i]));
      i += 1;
    }
    const headHtml = head.map((cell) => `<th>${cell}</th>`).join('');
    const bodyHtml = rows
      .map((row) => `<tr>${head.map((_cell, column) => `<td>${row[column] ?? ''}</td>`).join('')}</tr>`)
      .join('');
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    while (i < lines.length && lines[i].trim() === '') i += 1;
    if (out.length) out.push('');
    out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
    if (i < lines.length) out.push('');
  }
  return out.join('\n');
}

/** text -> HTML string. Caller is responsible for handling the "empty" case. */
export function mdToHtml(text: string | null | undefined): string {
  let md = text == null ? '' : text;
  md = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  md = tablesToHtml(md);
  md = md.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  md = md.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  md = md.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  md = md.replace(/^---+$/gm, '<hr>');
  md = md.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  md = md.replace(/\*(.+?)\*/g, '<em>$1</em>');
  md = md.replace(/`([^`]+)`/g, '<code>$1</code>');
  md = md.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  md = md.replace(/^- (.+)$/gm, '<li>$1</li>');
  md = md.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  md = md.replace(/\n\n/g, '</p><p>');
  md = '<p>' + md + '</p>';
  md = md.replace(/<p><(h[123]|hr|ul|blockquote|table)/g, '<$1');
  md = md.replace(/<\/(h[123]|ul|blockquote|table)><\/p>/g, '</$1>');
  return md;
}

/** Deterministic hue per name so each person keeps the same color everywhere. */
export function entityHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
