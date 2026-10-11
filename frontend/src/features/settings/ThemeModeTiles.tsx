/**
 * ThemeModeTiles.tsx — the only theme control most people ever need: pick
 * Auto / Light / Dark / Color runway. Four tiles instead of a dropdown, each
 * showing a miniature of the screen that mode actually produces (page
 * background, a card on it, two text bars), so the choice is made by looking
 * rather than by reading. Auto comes first and is the default.
 *
 * The miniatures are drawn from the *live* draft — edit a phase colour in
 * Advanced colours and the tile updates with it, so the preview never lies.
 *
 * Touches: SettingsPage.tsx (owns the draft + fires the live preview),
 * settingsHelpers.effectiveColor, theme/palettes.ts (phase names).
 *
 * Prompt behind this file: "in settings there is not a good colour theme
 * setting — I want auto colour theme, advanced colour settings accessible
 * with a click, and otherwise only theme mode."
 */
import type { ThemeMode, PhaseName } from '../../theme';
import { effectiveColor, type ThemeDraft } from './settingsHelpers';
import styles from './ThemeModeTiles.module.css';

/** Day-cycle order, used for the runway tile's gradient. */
const RUNWAY_PHASES: PhaseName[] = [
  'night', 'dawn', 'postDawn', 'morning', 'day', 'golden', 'twilight',
];

interface ModeOption {
  value: ThemeMode;
  label: string;
  desc: string;
  /** Which phase palette the miniature draws; 'auto' draws two, 'sky' a gradient. */
  kind: 'single' | 'split' | 'runway';
  phase: PhaseName;
  /** Second palette, split tiles only. */
  phaseB?: PhaseName;
}

const MODES: readonly ModeOption[] = [
  { value: 'auto', label: 'Auto', desc: 'Lavender by day, indigo at night', kind: 'split', phase: 'postDawn', phaseB: 'twilight' },
  { value: 'light', label: 'Light', desc: 'Lavender-grey, always', kind: 'single', phase: 'postDawn' },
  { value: 'dark', label: 'Dark', desc: 'Indigo, always', kind: 'single', phase: 'twilight' },
  { value: 'sky', label: 'Color runway', desc: 'Drifts through all seven day phases', kind: 'runway', phase: 'day' },
];

/** One miniature screen: page bg, a card floating on it, two lines of "text". */
function Mini({ draft, phase }: { draft: ThemeDraft; phase: PhaseName }) {
  return (
    <span className={styles.mini} style={{ background: effectiveColor(draft, phase, 'bg') }}>
      <span
        className={styles.miniCard}
        style={{
          background: effectiveColor(draft, phase, 'cardBg'),
          borderColor: effectiveColor(draft, phase, 'border'),
        }}
      >
        <span className={styles.miniLine} style={{ background: effectiveColor(draft, phase, 'text') }} />
        <span
          className={`${styles.miniLine} ${styles.miniLineShort}`}
          style={{ background: effectiveColor(draft, phase, 'textMuted') }}
        />
      </span>
    </span>
  );
}

function Preview({ draft, opt }: { draft: ThemeDraft; opt: ModeOption }) {
  if (opt.kind === 'runway') {
    // The whole day, left to right — the one tile where the point is the drift,
    // not any single screen, so it shows the sequence of page backgrounds.
    const stops = RUNWAY_PHASES.map((p) => effectiveColor(draft, p, 'bg')).join(', ');
    return (
      <span className={styles.preview}>
        <span className={styles.runway} style={{ backgroundImage: `linear-gradient(90deg, ${stops})` }} />
      </span>
    );
  }
  if (opt.kind === 'split' && opt.phaseB) {
    // Auto is two screens, so the tile is two screens — day on the left,
    // night on the right, cut on a diagonal.
    return (
      <span className={styles.preview}>
        <span className={styles.splitHalf}>
          <Mini draft={draft} phase={opt.phase} />
        </span>
        <span className={`${styles.splitHalf} ${styles.splitHalfB}`}>
          <Mini draft={draft} phase={opt.phaseB} />
        </span>
      </span>
    );
  }
  return (
    <span className={styles.preview}>
      <Mini draft={draft} phase={opt.phase} />
    </span>
  );
}

export interface ThemeModeTilesProps {
  draft: ThemeDraft;
  onChange: (mode: ThemeMode) => void;
}

export function ThemeModeTiles({ draft, onChange }: ThemeModeTilesProps) {
  return (
    <div className={styles.grid} role="radiogroup" aria-label="Theme mode">
      {MODES.map((opt) => {
        const selected = draft.mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <Preview draft={draft} opt={opt} />
            <span className={styles.label}>{opt.label}</span>
            <span className={styles.desc}>{opt.desc}</span>
          </button>
        );
      })}
    </div>
  );
}
