/**
 * usageHeat.ts — the "usage heat view": when the Settings toggle is on and
 * the current tab is /journal or /todos, tint every `[data-track]` control by
 * how often it's actually been tapped (all-time totals from GET /api/usage).
 *
 * Mechanics: fetch once per activation (and per tab change while active),
 * bucket each control's share of the page max into `data-heat="0".."5"`, and
 * let usageHeat.css paint translucent overlays (background-image + outline —
 * nothing that affects layout or blocks interaction). A throttled
 * MutationObserver re-applies as cards render/change; everything is torn
 * down (attributes removed) when toggled off or navigating elsewhere.
 *
 * Theme: the sky-theme engine applies palettes as inline CSS custom
 * properties (src/theme/engine.ts) — there's no light/dark class to hook. So
 * this module reads the effective `--bg` luminance and stamps
 * `data-heat-theme="light"|"dark"` on <html>; usageHeat.css carries color
 * variants for both (postDawn-light / twilight-dark), re-checked on theme
 * commits (subscribeTheme) and on a slow interval for the engine's silent
 * 2-minute auto refresh.
 *
 * The raw fetch (not api.get) is deliberate — same reason as usageBeacon.ts:
 * a decorative overlay must never redirect to /login or surface errors.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { hexToRgb, subscribeTheme } from '../theme';
import { tabFromPathname } from '../api/usageBeacon';
import './usageHeat.css';

/** Settings toggle persistence — '1' = on (see SettingsPage). */
export const USAGE_HEAT_STORAGE_KEY = 'exoUsageHeat';
/** Dispatched on window by the Settings toggle so open pages react live. */
export const USAGE_HEAT_EVENT = 'exo:usage-heat';

const HEAT_PAGES = new Set(['journal', 'todos']);
/** On <html> while active — usageTracker pauses click counting under it. */
const ACTIVE_ATTR = 'data-heat-view';
const THEME_ATTR = 'data-heat-theme';
const APPLY_THROTTLE_MS = 300;
const THEME_RECHECK_MS = 60_000;

interface UsageDay {
  tabs?: Record<string, number>;
  time?: Record<string, number>;
  clicks?: Record<string, Record<string, number>>;
}
interface UsageResponse {
  days?: Record<string, UsageDay>;
}

interface PageHeat {
  counts: Record<string, number>;
  max: number;
  taps: number;
  seconds: number;
  visits: number;
}

function aggregate(data: UsageResponse | null, page: string): PageHeat {
  const heat: PageHeat = { counts: {}, max: 0, taps: 0, seconds: 0, visits: 0 };
  for (const day of Object.values(data?.days ?? {})) {
    heat.seconds += day.time?.[page] ?? 0;
    heat.visits += day.tabs?.[page] ?? 0;
    for (const [control, n] of Object.entries(day.clicks?.[page] ?? {})) {
      if (typeof n !== 'number') continue;
      heat.counts[control] = (heat.counts[control] ?? 0) + n;
      heat.taps += n;
    }
  }
  for (const n of Object.values(heat.counts)) heat.max = Math.max(heat.max, n);
  return heat;
}

/** Cool→warm buckets: 0 = tagged-but-never-used, 1–5 = share of the page max. */
function bucketFor(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r <= 0.15) return 1;
  if (r <= 0.35) return 2;
  if (r <= 0.6) return 3;
  if (r <= 0.85) return 4;
  return 5;
}

/** Effective background luminance → which color variant set to use. */
function isDarkTheme(): boolean {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(bg)) return false;
  const [r, g, b] = hexToRgb(bg);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

/**
 * Install once from main.tsx. Listens to the Settings toggle event and
 * router navigation; active only on /journal and /todos with the toggle on.
 */
export function installUsageHeat(router: AnyRouter): void {
  if (typeof window === 'undefined') return;

  let active = false;
  let currentPage: string | null = null;
  let heat: PageHeat | null = null;
  let pill: HTMLButtonElement | null = null;
  let pillDismissed = false;
  let observer: MutationObserver | null = null;
  let applyTimer: number | null = null;
  let themeTimer: number | null = null;
  let fetchSeq = 0;

  function enabled(): boolean {
    try {
      return localStorage.getItem(USAGE_HEAT_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function applyThemeAttr(): void {
    document.documentElement.setAttribute(THEME_ATTR, isDarkTheme() ? 'dark' : 'light');
  }

  function apply(): void {
    if (!active || !heat) return;
    applyThemeAttr();
    const { counts, max } = heat;
    for (const el of document.querySelectorAll('[data-track]')) {
      const name = el.getAttribute('data-track') ?? '';
      const bucket = String(bucketFor(counts[name] ?? 0, max));
      if (el.getAttribute('data-heat') !== bucket) el.setAttribute('data-heat', bucket);
    }
  }

  function scheduleApply(): void {
    if (applyTimer !== null) return;
    applyTimer = window.setTimeout(() => {
      applyTimer = null;
      apply();
    }, APPLY_THROTTLE_MS);
  }

  function showPill(page: string, h: PageHeat): void {
    pill?.remove();
    pill = null;
    if (pillDismissed) return;
    const hours = (h.seconds / 3600).toFixed(1);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'usage-heat-pill';
    btn.title = 'Usage heat — tap to dismiss';
    btn.setAttribute('aria-label', 'Dismiss usage heat summary');
    btn.textContent = `${page} · ${h.taps} taps · ${hours}h · ${h.visits} visits`;
    btn.addEventListener('click', () => {
      pillDismissed = true;
      btn.remove();
      if (pill === btn) pill = null;
    });
    document.body.appendChild(btn);
    pill = btn;
  }

  function activate(page: string): void {
    if (active && currentPage === page) return;
    active = true;
    currentPage = page;
    pillDismissed = false;
    document.documentElement.setAttribute(ACTIVE_ATTR, '');
    applyThemeAttr();

    if (!observer) {
      // childList/subtree only — our own setAttribute('data-heat') is an
      // attribute mutation and must not feed back into the observer.
      observer = new MutationObserver(scheduleApply);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    if (themeTimer === null) {
      themeTimer = window.setInterval(applyThemeAttr, THEME_RECHECK_MS);
    }

    // One fetch per activation / tab change while active.
    const seq = ++fetchSeq;
    fetch('/api/usage', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<UsageResponse>) : null))
      .catch(() => null)
      .then((data) => {
        if (seq !== fetchSeq || !active || currentPage !== page) return;
        heat = aggregate(data, page);
        apply();
        showPill(page, heat);
      });
  }

  function deactivate(): void {
    if (!active) return;
    active = false;
    currentPage = null;
    heat = null;
    fetchSeq++;
    observer?.disconnect();
    observer = null;
    if (applyTimer !== null) {
      window.clearTimeout(applyTimer);
      applyTimer = null;
    }
    if (themeTimer !== null) {
      window.clearInterval(themeTimer);
      themeTimer = null;
    }
    pill?.remove();
    pill = null;
    document.documentElement.removeAttribute(ACTIVE_ATTR);
    document.documentElement.removeAttribute(THEME_ATTR);
    for (const el of document.querySelectorAll('[data-heat]')) {
      el.removeAttribute('data-heat');
    }
  }

  function evaluate(): void {
    const page = tabFromPathname(router.state.location.pathname);
    if (enabled() && HEAT_PAGES.has(page)) activate(page);
    else deactivate();
  }

  window.addEventListener(USAGE_HEAT_EVENT, evaluate);
  router.subscribe('onResolved', evaluate);
  subscribeTheme(() => {
    if (active) applyThemeAttr();
  });
  evaluate();
}
