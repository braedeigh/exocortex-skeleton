import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '../../ui';
import type { ColorKey, PhaseName } from '../../theme';
import { ColorField } from './ColorField';
import {
  contrastRatio,
  formatRatio,
  wcagLevel,
  worstRatio,
  type ContrastLevel,
} from '../../theme/contrast';
import { effectiveColor, type ThemeDraft } from './settingsHelpers';
import styles from './PhaseCard.module.css';

const PHASE_LABELS: Record<PhaseName, string> = {
  night: 'Night', dawn: 'Dawn', postDawn: 'Post-dawn', morning: 'Morning',
  day: 'Day', golden: 'Golden hour', twilight: 'Twilight',
};

const COLOR_KEYS: ReadonlyArray<[ColorKey, string]> = [
  ['bg', 'Background'],
  ['cardBg', 'Card bg'],
  ['text', 'Text'],
  ['textSecondary', 'Text 2°'],
  ['textMuted', 'Text muted'],
  ['border', 'Border'],
];

/** The three colors that carry words, so the three worth checking. bg/cardBg
 * are the surfaces they're checked against, and border isn't text. */
const CONTRAST_KEYS: ReadonlyArray<[ColorKey, string]> = [
  ['text', 'Text'],
  ['textSecondary', 'Text 2°'],
  ['textMuted', 'Text muted'],
];

/** AAA/AA read as a pass, "AA Large" as a warning (fine for a heading, not
 * for a paragraph), Fail as a failure. */
const LEVEL_CLASS: Record<ContrastLevel, string> = {
  AAA: 'levelPass',
  AA: 'levelPass',
  'AA Large': 'levelWarn',
  Fail: 'levelFail',
};

export interface PhaseCardProps {
  phase: PhaseName;
  draft: ThemeDraft;
  onColorChange: (phase: PhaseName, key: ColorKey, value: string) => void;
  onToggleEnabled: (phase: PhaseName, enabled: boolean) => void;
  onReset: (phase: PhaseName) => void;
}

/**
 * One collapsible day-phase editor: swatch + name + per-phase "on" toggle in
 * the head; live preview card, six color fields and a (two-step) reset in
 * the body. Port of settings.js renderPhases() for a single phase.
 */
export function PhaseCard({ phase, draft, onColorChange, onToggleEnabled, onReset }: PhaseCardProps) {
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const disabled = draft.phasesEnabled[phase] === false;
  const color = (key: ColorKey) => effectiveColor(draft, phase, key);

  function requestReset() {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmReset) {
      setConfirmReset(false);
      onReset(phase);
      return;
    }
    setConfirmReset(true);
    confirmTimer.current = setTimeout(() => setConfirmReset(false), 3000);
  }

  return (
    <div className={`${styles.card} ${disabled ? styles.cardDisabled : ''}`}>
      {/* div-with-button-semantics, not <button>: the per-phase "on" checkbox
          lives inside the head, and interactive content can't nest in a real
          button element. */}
      <div
        className={styles.head}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
      >
        <span className={styles.swatch} style={{ background: color('bg') }} />
        <span className={styles.name}>{PHASE_LABELS[phase]}</span>
        {/* stopPropagation so toggling "on" doesn't also expand/collapse */}
        <span
          className={styles.enableWrap}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={!disabled}
            onChange={(e) => onToggleEnabled(phase, e.target.checked)}
            aria-label={`${PHASE_LABELS[phase]} enabled`}
          >
            on
          </Checkbox>
        </span>
        <span className={`${styles.chev} ${open ? styles.chevOpen : ''}`} aria-hidden="true">
          ▶
        </span>
      </div>

      {open ? (
        <div className={styles.body}>
          <div className={styles.preview} style={{ background: color('bg') }}>
            <div
              className={styles.previewInner}
              style={{ background: color('cardBg'), borderColor: color('border') }}
            >
              <div className={styles.ppTitle} style={{ color: color('text') }}>
                Sample card title
              </div>
              <div className={styles.ppSecondary} style={{ color: color('textSecondary') }}>
                Body text reads in text-secondary — a paragraph might look like this.
              </div>
              <div className={styles.ppMuted} style={{ color: color('textMuted') }}>
                Muted metadata · timestamp · hint text
              </div>
            </div>
          </div>

          {/* Contrast checker: the same three text colors the preview renders
              above, measured against both surfaces they land on — the card
              and the page behind it. The badge grades the worse of the two,
              so a pass here means it reads everywhere in this phase. Alpha is
              composited before measuring (theme/contrast.ts), which matters:
              textSecondary and textMuted are rgba and their real contrast
              depends on what's underneath.
              Prompt that produced it: "Contrast checker for color
              accessibility standards". */}
          <div className={styles.contrast}>
            <div className={styles.contrastHead}>
              <span>Contrast (WCAG)</span>
              <span className={styles.contrastCols}>card · page</span>
            </div>
            {CONTRAST_KEYS.map(([key, label]) => {
              const onCard = contrastRatio(color(key), color('cardBg'));
              const onPage = contrastRatio(color(key), color('bg'));
              const level = wcagLevel(worstRatio(onCard, onPage));
              return (
                <div className={styles.contrastRow} key={key}>
                  <span className={styles.contrastLabel}>{label}</span>
                  <span className={styles.contrastNums}>
                    {formatRatio(onCard)} · {formatRatio(onPage)}
                  </span>
                  <span
                    className={`${styles.level} ${level ? styles[LEVEL_CLASS[level]] : ''}`}
                    title={
                      level
                        ? `Worst of the two surfaces grades ${level}`
                        : 'One of these colors could not be read'
                    }
                  >
                    {level ?? '—'}
                  </span>
                </div>
              );
            })}
          </div>

          {COLOR_KEYS.map(([key, label]) => (
            <ColorField
              key={key}
              label={label}
              value={color(key)}
              onChange={(v) => onColorChange(phase, key, v)}
            />
          ))}

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.resetBtn} ${confirmReset ? styles.resetSure : ''}`}
              onClick={requestReset}
            >
              {confirmReset ? 'Sure? Colors revert to defaults' : 'Reset to default'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
