import { describe, expect, it } from 'vitest';
import { fileTypeCounts, fileTypeOf, OTHER_FILE_TYPE } from './fileTypes';
import { staleTypeColor, typeDotColor } from './terrainCanvas';

/**
 * fileTypes.test.ts — the path → type lookup behind the terrain's "Types"
 * toggle (fileTypes.ts), the counting that orders its legend, and the lift
 * that keeps a too-dark or too-pale colour visible on the sky without
 * changing its hue (typeDotColor in terrainCanvas.ts), plus the fade that
 * sinks a stale dot back into the sky (staleTypeColor, same file).
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
  const DARK_SKY = '#14101e';
  const DARK_SKY_INK = '#ddd0e8';
  const LIGHT_SKY = '#aba3b2';
  const LIGHT_SKY_INK = '#1a1815';
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  it('leaves a colour alone when it already reads on the surface', () => {
    const javascript = fileTypeOf('a.js').color;
    expect(typeDotColor(javascript, DARK_SKY, DARK_SKY_INK)).toBe(javascript.toLowerCase());
  });

  it('lightens a colour that would vanish into a dark sky', () => {
    const navy = '#083fa1';
    const lifted = typeDotColor(navy, DARK_SKY, DARK_SKY_INK);
    expect(lifted).not.toBe(navy);
    expect(Math.max(...channels(lifted))).toBeGreaterThan(Math.max(...channels(navy)));
  });

  it('keeps the hue when it lifts, so a lifted blue is still blue', () => {
    const [red, green, blue] = channels(typeDotColor('#083fa1', DARK_SKY, DARK_SKY_INK));
    expect(blue).toBeGreaterThan(red);
    expect(blue).toBeGreaterThan(green);
  });

  it('darkens a pale colour on a light sky', () => {
    const yellow = fileTypeOf('a.js').color;
    const lifted = typeDotColor(yellow, LIGHT_SKY, LIGHT_SKY_INK);
    expect(Math.max(...channels(lifted))).toBeLessThan(Math.max(...channels(yellow)));
  });

  it('hands the colour back untouched when the surface is not a hex colour', () => {
    expect(typeDotColor('#292929', 'rgba(0,0,0,0.5)', DARK_SKY_INK)).toBe('#292929');
  });
});

describe('staleTypeColor', () => {
  const SKY = '#14101e';
  const TEAL = '#1fa08c';
  const brightness = (hex: string) =>
    [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);

  it('wears the full type colour when the file is freshly touched', () => {
    expect(staleTypeColor(TEAL, SKY, 1, 0)).toBe(TEAL);
  });

  it('wears the full type colour when the file has only just run', () => {
    expect(staleTypeColor(TEAL, SKY, 0, 1)).toBe(TEAL);
  });

  it('disappears into the sky when nothing has touched the file', () => {
    expect(staleTypeColor(TEAL, SKY, 0, 0)).toBe(SKY);
  });

  it('fades further the staler the file gets', () => {
    const warm = staleTypeColor(TEAL, SKY, 0.6, 0);
    const cooling = staleTypeColor(TEAL, SKY, 0.3, 0);
    const cold = staleTypeColor(TEAL, SKY, 0.05, 0);
    expect(brightness(warm)).toBeGreaterThan(brightness(cooling));
    expect(brightness(cooling)).toBeGreaterThan(brightness(cold));
    expect(brightness(cold)).toBeGreaterThan(brightness(SKY));
  });
});

/**
 * The reason three colours here are not GitHub's: the kinds of file that make
 * up most of the map have to be tellable apart as small dots, on both skies.
 * Distance is measured in OKLab; 0.06 is roughly three times the smallest
 * difference the eye can see, and is what the tight light sky can afford.
 */
describe('the common types stay tellable apart', () => {
  const SKIES = [
    { name: 'dark', bg: '#14101e', ink: '#ddd0e8' },
    { name: 'light', bg: '#aba3b2', ink: '#1a1815' },
  ];
  const COMMON = ['a.py', 'a.ts', 'a.md', 'a.css', 'a.json', 'a.sh'];

  function oklab(hex: string): number[] {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  for (const sky of SKIES) {
    it(`on the ${sky.name} sky`, () => {
      const dots = COMMON.map((path) => ({
        label: fileTypeOf(path).label,
        lab: oklab(typeDotColor(fileTypeOf(path).color, sky.bg, sky.ink)),
      }));
      const tooClose: string[] = [];
      for (let i = 0; i < dots.length; i += 1) {
        for (let j = i + 1; j < dots.length; j += 1) {
          const distance = Math.hypot(...dots[i].lab.map((v, k) => v - dots[j].lab[k]));
          if (distance < 0.06) tooClose.push(`${dots[i].label} ~ ${dots[j].label} (${distance.toFixed(3)})`);
        }
      }
      expect(tooClose).toEqual([]);
    });
  }
});
