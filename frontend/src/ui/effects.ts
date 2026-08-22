/**
 * effects.ts — the "reduced effects" switch: one attribute on <html> that
 * turns the app's frosted glass off.
 *
 * Why it exists: `backdrop-filter` is the most expensive paint in the app, and
 * unlike an animation it isn't free when nothing is moving — anything
 * repainting near a frosted surface makes the browser re-read and re-blur what
 * sits behind it, and the layer can't be cached. Cost scales with the blurred
 * AREA, so it lands hardest on a big screen (or three), and hardest of all on
 * an integrated GPU sharing system memory bandwidth. On hardware that can't
 * spend it, the glass is the difference between the UI feeling immediate and
 * feeling like it's dragging.
 *
 * Mechanics: stamp `data-effects="reduced"` on documentElement, and theme.css
 * answers by setting every --frost-* token to `none`. That's the whole switch
 * — no component knows about it, because no site writes a raw blur() of its
 * own. `none` rather than blur(0) on purpose: zero-radius blur still builds a
 * backdrop root and still costs, for nothing visible.
 *
 * Precedence: an explicit choice in Settings wins and persists. With nothing
 * stored we follow the OS hint (`prefers-reduced-transparency`), so a machine
 * already asking for less of this gets it without being told twice.
 *
 * Installed once from main.tsx; the Settings toggle writes localStorage and
 * fires EFFECTS_EVENT so open pages change over without a reload.
 */

/** Settings toggle persistence — '1' = reduced, '0' = full (see SettingsPage). */
export const EFFECTS_STORAGE_KEY = 'exoEffects';
/** Dispatched on window by the Settings toggle so open pages react live. */
export const EFFECTS_EVENT = 'exo:effects';

const ATTR = 'data-effects';
const REDUCED = 'reduced';
const OS_HINT = '(prefers-reduced-transparency: reduce)';

/** Stored choice, or null when she hasn't made one. */
function stored(): boolean | null {
  try {
    const v = localStorage.getItem(EFFECTS_STORAGE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // storage denied — fall through to the OS hint
  }
  return null;
}

/** What the switch is actually set to right now: her choice, else the OS hint. */
export function effectsReduced(): boolean {
  const choice = stored();
  if (choice !== null) return choice;
  try {
    return window.matchMedia(OS_HINT).matches;
  } catch {
    return false;
  }
}

/** Write the choice and tell any open page to change over. */
export function setEffectsReduced(on: boolean): void {
  try {
    localStorage.setItem(EFFECTS_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // storage denied — the switch still applies for this page via the event
  }
  window.dispatchEvent(new CustomEvent(EFFECTS_EVENT, { detail: { reduced: on } }));
}

function apply(): void {
  const root = document.documentElement;
  if (effectsReduced()) root.setAttribute(ATTR, REDUCED);
  else root.removeAttribute(ATTR);
}

/**
 * Install once from main.tsx, before first paint — so a reduced session never
 * pays for one frame of glass on the way in.
 */
export function installEffects(): void {
  if (typeof window === 'undefined') return;
  apply();
  window.addEventListener(EFFECTS_EVENT, apply);
  // Only meaningful while nothing is stored; harmless once it is, since
  // effectsReduced() checks the stored choice first.
  try {
    window.matchMedia(OS_HINT).addEventListener('change', apply);
  } catch {
    // older engine with no matchMedia listener support — the boot call stands
  }
}
