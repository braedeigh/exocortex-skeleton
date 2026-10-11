/**
 * syntax.test.ts — checks syntax.ts, the terrain's syntax colouring: which
 * grammar a path gets, a placeholder colour turned back into its role, and a
 * real tokenize of a little Python through Shiki.
 */
import { describe, expect, it } from 'vitest';
import { langForPath, roleForColor, tokenizeCode } from './syntax';

describe('langForPath', () => {
  it('reads the last extension only', () => {
    expect(langForPath('frontend/src/x/thing.test.ts')).toBe('typescript');
    expect(langForPath('frontend/src/x/Thing.module.css')).toBe('css');
    expect(langForPath('routes/terrain.py')).toBe('python');
    expect(langForPath('docs/NORTH.md')).toBe('markdown');
  });

  it('is plain for no extension, a dotfile, or an unknown kind', () => {
    expect(langForPath('Makefile')).toBeNull();
    expect(langForPath('.gitignore')).toBeNull();
    expect(langForPath('photo.jpg')).toBeNull();
    expect(langForPath(null)).toBeNull();
  });
});

describe('roleForColor', () => {
  it('maps a placeholder back to its role and ignores anything else', () => {
    expect(roleForColor('#000001')).toBe('keyword');
    // An alpha pair on the end is ignored — only `#rrggbb` is read.
    expect(roleForColor('#000003FF')).toBe('comment');
    expect(roleForColor('#123456')).toBeUndefined();
    expect(roleForColor(undefined)).toBeUndefined();
  });
});

describe('tokenizeCode', () => {
  it('colours python keywords, strings and comments in their roles, one entry per line', async () => {
    const code = 'def hi():\n    return "yo"  # note\n';
    const lines = await tokenizeCode(code, 'python');
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(code.split('\n').length);
    // Look up the role of the first token whose text contains `text`.
    const roleOf = (text: string) =>
      lines!.flat().find((t) => t.content.includes(text))?.role;
    expect(roleOf('def')).toBe('keyword');
    expect(roleOf('return')).toBe('keyword');
    expect(roleOf('yo')).toBe('string');
    expect(roleOf('note')).toBe('comment');
  });

  it('reads a python docstring as a comment, not a string', async () => {
    const lines = await tokenizeCode('"""What this file does."""\nx = 1\n', 'python');
    expect(lines!.flat().find((t) => t.content.includes('What this'))?.role).toBe('comment');
  });

  it('shows plain for an unknown language or an oversized file', async () => {
    expect(await tokenizeCode('x', null)).toBeNull();
    // 200,000 characters — over the size cap (SYNTAX_MAX_CHARS, 160,000).
    expect(await tokenizeCode('x'.repeat(200_000), 'python')).toBeNull();
  });
});
