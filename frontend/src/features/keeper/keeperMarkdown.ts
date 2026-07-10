/**
 * keeperMarkdown.ts — the keeper preview pipeline from templates/keeper.html
 * (renderPreview/parseFrontmatter/renderChips), on top of the shared
 * journal renderer (mdToHtml) for the base markdown.
 *
 * Extensions over mdToHtml, matching the legacy page:
 *  - a leading YAML frontmatter block whose tags/aliases become chips instead
 *    of rendering as a stray <hr> + "tags: [...]" text;
 *  - [[wikilinks]] resolved to clickable spans (people/ wins name collisions
 *    via the caller's resolver), dead links rendered muted;
 *  - "* item" bullets accepted alongside "- item" (mdToHtml only knows "-";
 *    legacy keeper matched /^[-*] /).
 *
 * Two deliberate micro-divergences from the legacy string pipeline, both
 * confined to pathological inputs: wikilinks are matched on the raw text
 * (legacy matched after HTML-escaping, so a name containing & or < resolved
 * against its escaped form), and "* " bullets are normalized before the
 * italic pass (legacy could pair a bullet's own asterisk with a later * on
 * the same line and eat the bullet). Real vault content renders identically.
 */
import { mdToHtml } from '../journal/markdown';

export type WikilinkResolver = (name: string) => string | undefined;

export type FrontmatterMeta = Record<string, string[]>;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Line-based "key: value" parse; [bracketed] lists and quoted items handled.
 * Values always become string arrays (exact port of legacy parseFrontmatter). */
export function parseFrontmatter(block: string): FrontmatterMeta {
  const meta: FrontmatterMeta = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    let val = line.slice(i + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) val = val.slice(1, -1);
    const items = val
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    if (items.length) meta[key] = items;
  }
  return meta;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Pull a leading YAML frontmatter block out of the document — but only when
 * it carries tags or aliases (the chips we know how to show). Any other
 * frontmatter is left in place and renders however the markdown pass renders
 * it, exactly like the legacy page.
 */
export function extractFrontmatter(md: string): { meta: FrontmatterMeta | null; body: string } {
  const fm = md.match(FRONTMATTER_RE);
  if (fm) {
    const meta = parseFrontmatter(fm[1]);
    if (meta.tags || meta.aliases) return { meta, body: md.slice(fm[0].length) };
  }
  return { meta: null, body: md };
}

/** Frontmatter chips (people files: #tags + "also known as" aliases). */
export function renderChips(meta: FrontmatterMeta): string {
  let h = '';
  if (meta.tags) {
    h += `<div class="fm-tags">${meta.tags.map((t) => `<span class="fm-tag">#${esc(t)}</span>`).join('')}</div>`;
  }
  if (meta.aliases) {
    h += `<div class="fm-aliases">also known as: ${meta.aliases.map(esc).join(', ')}</div>`;
  }
  return h ? `<div class="fm-block">${h}</div>` : '';
}

/** One [[wikilink]] as HTML — clickable span with data-target when the name
 * resolves to a real file, muted "dead" span otherwise. */
export function wikilinkHtml(name: string, resolve: WikilinkResolver): string {
  const target = resolve(name);
  return target
    ? `<span class="wikilink" data-target="${esc(target)}">${esc(name)}</span>`
    : `<span class="wikilink dead" title="no file yet">${esc(name)}</span>`;
}

// Wikilink spans must survive mdToHtml's escaping + regex passes, so they are
// swapped for U+0001-delimited index tokens first and substituted back after
// eslint-disable-next-line no-control-regex
const TOKEN_RE = /\u0001(\d+)\u0001/g;

/** Markdown body (frontmatter already extracted) -> preview HTML. */
export function renderKeeperBody(md: string, resolve: WikilinkResolver): string {
  const links: string[] = [];
  const tokenized = md
    .replace(/\[\[([^\]]+)\]\]/g, (_m, name: string) => {
      links.push(wikilinkHtml(name, resolve));
      return `\u0001${links.length - 1}\u0001`;
    })
    // legacy keeper accepted "* " bullets too (/^[-*] /); mdToHtml only knows "- "
    .replace(/^\* (.+)$/gm, '- $1');
  return mdToHtml(tokenized).replace(TOKEN_RE, (_m, i: string) => links[Number(i)]);
}

export const EMPTY_FILE_HTML = '<p style="color:var(--text-muted);font-style:italic">Empty file.</p>';

/** Whole-file preview: chips block (if any) + rendered body. */
export function renderKeeperPreview(md: string, resolve: WikilinkResolver): string {
  if (!md.trim()) return EMPTY_FILE_HTML;
  const { meta, body } = extractFrontmatter(md);
  return (meta ? renderChips(meta) : '') + renderKeeperBody(body, resolve);
}
