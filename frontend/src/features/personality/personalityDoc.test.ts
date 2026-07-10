import { describe, expect, it } from 'vitest';
import {
  parsePersonalitySections,
  renderSectionHtml,
  replaceSectionBlock,
  sectionIsEmpty,
} from './personalityDoc';

const DOC = [
  '# Goal Personality', // 0 — preamble, belongs to no section
  '', // 1
  '<!-- summary: Who I want to be -->', // 2
  '## Core', // 3
  'Calm under pressure.', // 4
  '', // 5
  '## Habits', // 6 — no summary comment
  '- morning pages', // 7
  '<!-- summary: How I speak -->', // 8
  '## Voice', // 9
  'Direct, warm.', // 10
].join('\n');

describe('parsePersonalitySections', () => {
  it('splits on ## headings and extracts summary comments from the line above', () => {
    const secs = parsePersonalitySections(DOC);
    expect(secs.map((s) => s.title)).toEqual(['Core', 'Habits', 'Voice']);
    expect(secs.map((s) => s.summary)).toEqual(['Who I want to be', '', 'How I speak']);
  });

  it('starts a block at the summary comment when present, else at the heading', () => {
    const [core, habits, voice] = parsePersonalitySections(DOC);
    expect(core.blockStartIdx).toBe(2);
    expect(habits.blockStartIdx).toBe(6);
    expect(voice.blockStartIdx).toBe(8);
  });

  it("ends a block just before the next section's summary/heading, last one at EOF", () => {
    const [core, habits, voice] = parsePersonalitySections(DOC);
    expect(core.blockEndIdx).toBe(5);
    expect(habits.blockEndIdx).toBe(7); // line 8 is Voice's summary comment
    expect(voice.blockEndIdx).toBe(10);
  });

  it('includes the summary comment and heading in the block text', () => {
    const [core] = parsePersonalitySections(DOC);
    expect(core.block).toBe('<!-- summary: Who I want to be -->\n## Core\nCalm under pressure.\n');
  });

  it('leaves the preamble (before the first ##) outside every block', () => {
    const [core] = parsePersonalitySections(DOC);
    expect(core.blockStartIdx).toBe(2); // lines 0-1 belong to no section
  });

  it('only treats a comment matching the summary shape as a summary', () => {
    const secs = parsePersonalitySections('<!-- just a note -->\n## A\nbody');
    expect(secs[0].summary).toBe('');
    expect(secs[0].blockStartIdx).toBe(1);
  });

  it('does not split on ### or # headings', () => {
    const secs = parsePersonalitySections('## Top\n### Sub\n# Big\nbody');
    expect(secs).toHaveLength(1);
    expect(secs[0].block).toBe('## Top\n### Sub\n# Big\nbody');
  });

  it('returns no sections for a doc without ## headings', () => {
    expect(parsePersonalitySections('just text')).toEqual([]);
    expect(parsePersonalitySections('')).toEqual([]);
  });

  it('handles a summary-annotated heading on the first line pair', () => {
    const secs = parsePersonalitySections('<!-- summary: s -->\n## A\nbody');
    expect(secs[0].summary).toBe('s');
    expect(secs[0].blockStartIdx).toBe(0);
  });
});

describe('sectionIsEmpty', () => {
  it('ignores the summary comment and heading when measuring the body', () => {
    expect(sectionIsEmpty({ block: '<!-- summary: s -->\n## A\nshort' })).toBe(true);
    expect(sectionIsEmpty({ block: '## A\n' })).toBe(true);
  });

  it('is false once the body reaches 20 characters', () => {
    expect(sectionIsEmpty({ block: '## A\nexactly twenty chars!!' })).toBe(false);
  });
});

describe('replaceSectionBlock', () => {
  it('splices the new block over the section lines, keeping everything around it', () => {
    const [, habits] = parsePersonalitySections(DOC);
    const next = replaceSectionBlock(DOC, habits, '## Habits\n- morning pages\n- stretch');
    expect(next).toBe(DOC.replace('## Habits\n- morning pages', '## Habits\n- morning pages\n- stretch'));
  });

  it('handles a block that shrinks', () => {
    const [core] = parsePersonalitySections(DOC);
    const next = replaceSectionBlock(DOC, core, '## Core');
    expect(next.split('\n').slice(0, 4)).toEqual(['# Goal Personality', '', '## Core', '## Habits']);
  });

  it('round-trips: replacing a block with itself is a no-op', () => {
    for (const sec of parsePersonalitySections(DOC)) {
      expect(replaceSectionBlock(DOC, sec, sec.block)).toBe(DOC);
    }
  });

  it('reparse after replace picks up new headings the edit introduced', () => {
    const [core] = parsePersonalitySections(DOC);
    const next = replaceSectionBlock(DOC, core, '## Core\nbody\n## Extra\nmore');
    expect(parsePersonalitySections(next).map((s) => s.title)).toEqual(['Core', 'Extra', 'Habits', 'Voice']);
  });
});

describe('renderSectionHtml', () => {
  it('strips the summary comment before rendering', () => {
    const html = renderSectionHtml('<!-- summary: hidden -->\n## Core\nbody');
    expect(html).not.toContain('hidden');
    expect(html).toContain('<h2>Core</h2>');
  });

  it('strips comments anywhere in the block, including multi-line ones', () => {
    expect(renderSectionHtml('a <!-- x\ny --> b')).not.toContain('x');
  });

  it('matches the md.js dialect (escape, bold, blockquote, list)', () => {
    const html = renderSectionHtml('## T\n**b** <tag>\n\n> q\n\n- item');
    expect(html).toContain('<strong>b</strong> &lt;tag&gt;');
    expect(html).toContain('<blockquote>q</blockquote>');
    expect(html).toContain('<ul><li>item</li>');
  });

  it('returns empty string for a whitespace-only block (component shows "Empty.")', () => {
    expect(renderSectionHtml('  \n ')).toBe('');
  });
});
