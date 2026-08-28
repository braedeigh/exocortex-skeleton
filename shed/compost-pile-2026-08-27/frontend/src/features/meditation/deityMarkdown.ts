/**
 * deityMarkdown.ts — the Meditation tab's OWN markdown renderer, ported
 * line-for-line from static/js/meditation.js `mdToHtml` (NOT from md.js —
 * the old tab never used md.js; it shipped a richer line-based renderer).
 *
 * It handles everything the shared features/journal/markdown.ts port of
 * md.js does not: GFM tables (with blank-padding-row skipping and ragged
 * rows), markdown + bare-URL links, ordered lists, multi-line blockquotes
 * and `---`/`===`/`***` rules — so deity bodies keep rendering identically.
 * Kept local to this feature per the migration rule ("extend locally if the
 * old code rendered tables").
 *
 * One deliberate difference from the old code: it emitted inline styles;
 * this port emits semantic tags (h1–h6, table, blockquote, …) plus two
 * marker classes (mdTableWrap, mdAuto) and lets the component's CSS Module
 * (.mdBody in DeitiesView.module.css) reproduce the exact old styling with
 * theme custom properties.
 */

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline spans — input is already HTML-escaped. */
function inline(s: string): string {
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Auto-link bare URLs (not the ones already inside a markdown link's href/text)
  s = s.replace(
    /(^|[^"(>\]])(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener" class="mdAuto">$2</a>',
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function isHr(l: string): boolean {
  return /^\s*([-=*_])\1{2,}\s*$/.test(l);
}

function isTableSep(l: string): boolean {
  return l.includes('|') && /-/.test(l) && /^\s*\|?[\s|:-]+$/.test(l);
}

function cells(l: string): string[] {
  return l
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Markdown source -> HTML string (render with dangerouslySetInnerHTML inside .mdBody). */
export function deityMdToHtml(src: string | null | undefined): string {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (isHr(line)) {
      html += '<hr>';
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      html += `<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`;
      i++;
      continue;
    }

    // Table: current row + separator on next line
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = cells(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i]);
        i++;
        if (row.every((c) => !c)) continue; // skip blank padding rows
        rows.push(row);
      }
      let t = '<div class="mdTableWrap"><table>';
      t += '<thead><tr>' + header.map((c) => `<th>${inline(esc(c))}</th>`).join('') + '</tr></thead>';
      t +=
        '<tbody>' +
        rows
          .map((r) => '<tr>' + header.map((_, ci) => `<td>${inline(esc(r[ci] || ''))}</td>`).join('') + '</tr>')
          .join('') +
        '</tbody>';
      t += '</table></div>';
      html += t;
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html += `<blockquote>${inline(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
      continue;
    }

    // List (unordered or ordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}>` + items.map((it) => `<li>${inline(esc(it))}</li>`).join('') + `</${tag}>`;
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHr(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${inline(esc(para.join('\n'))).replace(/\n/g, '<br>')}</p>`;
  }
  return html;
}
