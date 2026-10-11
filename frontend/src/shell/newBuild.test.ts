import { describe, expect, it } from 'vitest';
import { isNewerBuild, runningBuild } from './newBuild';

/** A stand-in for the page's own document: just the tags that carry a
 * built file's address. */
function pageWith(addresses: { src?: string; href?: string }[]) {
  return {
    querySelectorAll: () =>
      addresses.map((a) => ({
        getAttribute: (name: string) => (name === 'src' ? (a.src ?? null) : (a.href ?? null)),
      })),
  } as unknown as Pick<Document, 'querySelectorAll'>;
}

describe('the reload bar’s build check', () => {
  it('names a build the way the server does: script and stylesheet names, sorted, joined', () => {
    const page = pageWith([{ src: '/assets/index-Zb_9.js' }, { href: '/assets/index-D3Ov9Yb_.css' }]);
    expect(runningBuild(page)).toBe('index-D3Ov9Yb_.css+index-Zb_9.js');
  });

  it('offers a reload only when both builds are known and differ', () => {
    const running = runningBuild(pageWith([{ src: '/assets/index-OLD.js' }]));
    expect(isNewerBuild(running, 'index-NEW.js')).toBe(true);
    expect(isNewerBuild(running, running)).toBe(false);
    // The server is mid-build and has no page to name.
    expect(isNewerBuild(running, '')).toBe(false);
    // The development server: the page loads no built file at all.
    expect(isNewerBuild(runningBuild(pageWith([])), 'index-NEW.js')).toBe(false);
  });
});
