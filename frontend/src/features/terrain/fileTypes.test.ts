import { describe, expect, it } from 'vitest';
import { fileTypeCounts, fileTypeOf, OTHER_FILE_TYPE } from './fileTypes';
import { typeDotColor } from './terrainCanvas';

/**
 * fileTypes.test.ts — the path → type lookup behind the terrain's "Types"
 * toggle (fileTypes.ts), the counting that orders its legend, and the lift
 * that keeps GitHub's darker colours visible on a dark sky (typeDotColor in
 * terrainCanvas.ts).
 */

describe('fileTypeOf', () => {
  it('reads the type from the extension, wherever the file sits', () => {
    expect(fileTypeOf('routes/todos.py').label).toBe('Python');
    expect(fileTypeOf('frontend/src/features/terrain/TerrainPage.tsx').label).toBe('TypeScript');
  });

  it('ignores the case of the extension', () => {
    expect(fileTypeOf('docs/README.MD').label).toBe('Markdown');
  });

  it('uses the last dot, so a CSS module is CSS', () => {
    expect(fileTypeOf('TerrainPage.module.css').label).toBe('CSS');
  });

  it('recognises files GitHub knows by their whole name', () => {
    expect(fileTypeOf('deploy/Dockerfile').label).toBe('Dockerfile');
  });

  it('treats a dotfile as Other, not as an extension', () => {
    expect(fileTypeOf('.gitignore')).toBe(OTHER_FILE_TYPE);
  });

  it('treats unknown and extensionless files as Other', () => {
    expect(fileTypeOf('photos/cat.heic')).toBe(OTHER_FILE_TYPE);
    expect(fileTypeOf('LICENSE')).toBe(OTHER_FILE_TYPE);
  });
});

describe('fileTypeCounts', () => {
  it('orders the most common type first', () => {
    const counts = fileTypeCounts(['a.md', 'b.md', 'c.py']);
    expect(counts.map((c) => [c.type.label, c.count])).toEqual([
      ['Markdown', 2],
      ['Python', 1],
    ]);
  });

  it('keeps Other last even when it is the most common', () => {
    const counts = fileTypeCounts(['a.heic', 'b.heic', 'c.heic', 'd.py']);
    expect(counts.map((c) => c.type.label)).toEqual(['Python', 'Other']);
  });
});

describe('typeDotColor', () => {
  const DARK_SKY = '#1a1a3a';
  const LIGHT_INK = '#e8e8f0';

  it('leaves a colour alone when it already reads on the surface', () => {
    const javascript = fileTypeOf('a.js').color;
    expect(typeDotColor(javascript, DARK_SKY, LIGHT_INK)).toBe(javascript.toLowerCase());
  });

  it('lifts a colour that would vanish into a dark sky', () => {
    const json = fileTypeOf('a.json').color; // near-black
    const lifted = typeDotColor(json, DARK_SKY, LIGHT_INK);
    expect(lifted).not.toBe(json);
    // Lifted toward the light ink, so every channel got brighter.
    expect(parseInt(lifted.slice(1, 3), 16)).toBeGreaterThan(parseInt(json.slice(1, 3), 16));
  });

  it('hands the colour back untouched when the surface is not a hex colour', () => {
    expect(typeDotColor('#292929', 'rgba(0,0,0,0.5)', LIGHT_INK)).toBe('#292929');
  });
});
