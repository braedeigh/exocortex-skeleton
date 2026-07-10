/**
 * personalityDoc.ts — pure logic for the goal-personality.md doc, ported
 * verbatim from templates/personality.html (parseSections / the doSave splice
 * / the renderSections empty-check / renderMarkdown).
 *
 * The doc is one markdown file split into sections on `## ` headings. A
 * section may be annotated with a `<!-- summary: ... -->` comment on the line
 * directly above its heading; that comment line belongs to the section's
 * block (so editing a section edits its summary too), and the summary text is
 * what the landing cards show.
 *
 * Renderer choice: personality.html's local renderMarkdown() is byte-for-byte
 * the same pipeline as static/js/md.js (already ported as
 * features/journal/markdown.ts mdToHtml) with exactly one extra step — it
 * strips HTML comments (`<!-- ... -->`) before escaping, so the summary
 * annotation never shows up in the read view. Rather than fork a third copy
 * of the renderer, renderSectionHtml() strips comments and delegates to
 * mdToHtml — output stays byte-identical to the legacy page. (The legacy
 * page's `!md.trim()` → "Empty." special case is handled by the component,
 * which renders a styled empty message instead of injected HTML.)
 */
import { mdToHtml } from '../journal/markdown';

export interface PersonalitySection {
  /** Heading text (the `## ` line without the marker). */
  title: string;
  /** Text of the `<!-- summary: ... -->` annotation, or '' if none. */
  summary: string;
  /** First line of the section's block in the full doc (the summary comment line when present, else the heading line). */
  blockStartIdx: number;
  /** Last line of the block (up to, not including, the next section's summary/heading). */
  blockEndIdx: number;
  /** The block's raw markdown — summary comment + heading + body. */
  block: string;
}

/** Split the doc into `## ` sections. Any preamble before the first heading
 * belongs to no section (exactly like the legacy page — it is preserved by
 * saves but never shown or edited). */
export function parsePersonalitySections(md: string): PersonalitySection[] {
  const lines = md.split('\n');
  const markers: Array<{ headerIdx: number; summaryIdx: number; title: string; summary: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^## (.+)$/);
    if (h2) {
      let summaryIdx = -1;
      let summary = '';
      if (i > 0) {
        const sm = lines[i - 1].match(/^<!--\s*summary:\s*(.+?)\s*-->\s*$/);
        if (sm) {
          summaryIdx = i - 1;
          summary = sm[1];
        }
      }
      markers.push({ headerIdx: i, summaryIdx, title: h2[1], summary });
    }
  }
  const sections: PersonalitySection[] = [];
  for (let m = 0; m < markers.length; m++) {
    const cur = markers[m];
    const next = markers[m + 1];
    const blockEndIdx = next ? (next.summaryIdx >= 0 ? next.summaryIdx : next.headerIdx) - 1 : lines.length - 1;
    const blockStartIdx = cur.summaryIdx >= 0 ? cur.summaryIdx : cur.headerIdx;
    sections.push({
      title: cur.title,
      summary: cur.summary,
      blockStartIdx,
      blockEndIdx,
      block: lines.slice(blockStartIdx, blockEndIdx + 1).join('\n'),
    });
  }
  return sections;
}

/** "Empty — tap to fill": the body (block minus a leading comment and the
 * heading line) is under 20 characters once trimmed. */
export function sectionIsEmpty(section: Pick<PersonalitySection, 'block'>): boolean {
  const bodyOnly = section.block
    .replace(/^<!--[\s\S]*?-->\s*\n?/, '')
    .replace(/^## .+\n?/, '')
    .trim();
  return bodyOnly.length < 20;
}

/** Splice an edited block back into the full doc at the section's line range
 * (the legacy doSave). The caller must pass a section parsed from `fullMd` —
 * indices are only meaningful against the doc they came from. */
export function replaceSectionBlock(
  fullMd: string,
  section: Pick<PersonalitySection, 'blockStartIdx' | 'blockEndIdx'>,
  newBlock: string,
): string {
  const lines = fullMd.split('\n');
  const before = lines.slice(0, section.blockStartIdx);
  const after = lines.slice(section.blockEndIdx + 1);
  return [...before, ...newBlock.split('\n'), ...after].join('\n');
}

/** Section block -> read-view HTML: strip HTML comments (the summary
 * annotation), then the shared md.js pipeline. Returns '' for a
 * whitespace-only block — the component renders the "Empty." message. */
export function renderSectionHtml(block: string): string {
  if (!block.trim()) return '';
  return mdToHtml(block.replace(/<!--[\s\S]*?-->/g, ''));
}
