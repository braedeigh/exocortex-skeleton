import { describe, expect, it } from 'vitest';
import { fitMenu } from './menuFit';

/** A panel-shaped clip box: the tiled desktop's half-height panel, which is
 *  the case the whole module exists for. */
const PANEL = { clipTop: 500, clipBottom: 1000 };

describe('fitMenu', () => {
  it('sizes to the clipping box, not the window', () => {
    // Anchor at the top of a 500px panel that starts halfway down a 1000px
    // window. The old `70vh` answer was 700; the room actually available is
    // ~455, and anything past it was being cut off unreachably.
    const fit = fitMenu({ anchorTop: 500, anchorBottom: 537, ...PANEL });
    expect(fit.flipUp).toBe(false);
    expect(fit.maxHeight).toBe(1000 - 537 - 8);
  });

  it('opens downward whenever downward is usable', () => {
    // More than twice the room above, but below is still comfortable — staying
    // put beats a menu that changes sides between openings.
    const fit = fitMenu({ anchorTop: 700, anchorBottom: 737, clipTop: 0, clipBottom: 1000 });
    expect(fit.flipUp).toBe(false);
    expect(fit.maxHeight).toBe(1000 - 737 - 8);
  });

  it('flips up when below is cramped and above is roomier', () => {
    const fit = fitMenu({ anchorTop: 900, anchorBottom: 937, ...PANEL });
    expect(fit.flipUp).toBe(true);
    expect(fit.maxHeight).toBe(900 - 500 - 8);
  });

  it('stays down when both directions are cramped', () => {
    // Nothing to gain by moving — a flip here would just be motion.
    const fit = fitMenu({ anchorTop: 560, anchorBottom: 597, clipTop: 500, clipBottom: 700 });
    expect(fit.flipUp).toBe(false);
  });

  it('never returns a negative height for an anchor scrolled out of its box', () => {
    const fit = fitMenu({ anchorTop: 1200, anchorBottom: 1237, ...PANEL });
    expect(fit.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
