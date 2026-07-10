import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PHASE_ORDER,
  commitThemeOverrides,
  getThemeOverrides,
  previewThemeOverrides,
  rememberThemeMode,
  type AccentKey,
  type ColorKey,
  type OffsetKey,
  type PhaseName,
  type ThemeMode,
} from '../../theme';
import { AccountSection } from './AccountSection';
import { ColorField } from './ColorField';
import { DevNotesSection } from './DevNotesSection';
import { PhaseCard } from './PhaseCard';
import { saveTheme } from './settingsApi';
import {
  buildSavePayload,
  draftFromOverrides,
  effectiveAccent,
  effectiveOffset,
  type ThemeDraft,
} from './settingsHelpers';
import styles from './SettingsPage.module.css';

const MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'auto', label: 'Auto — lavender by day, indigo at night' },
  { value: 'light', label: 'Light (lavender)' },
  { value: 'dark', label: 'Dark (indigo)' },
  { value: 'sky', label: 'Color runway (full day cycle)' },
];

const OFFSET_ROWS: ReadonlyArray<[OffsetKey, string, 'sunrise' | 'sunset']> = [
  ['dawnStart', 'Dawn start', 'sunrise'],
  ['dawnEnd', 'Dawn end', 'sunrise'],
  ['postDawnEnd', 'Post-dawn end', 'sunrise'],
  ['morningEnd', 'Morning end', 'sunrise'],
  ['goldenStart', 'Golden start', 'sunset'],
  ['twilightStart', 'Twilight start', 'sunset'],
  ['twilightEnd', 'Twilight end', 'sunset'],
];

const ACCENT_LABELS: ReadonlyArray<[AccentKey, string]> = [
  ['morning', 'Morning section'],
  ['evening', 'Evening section'],
  ['ongoing', 'Midday / accent'],
  ['accent', 'Primary accent'],
];

type SaveStatus = '' | 'unsaved' | 'saving…' | 'saved' | 'save failed';

/**
 * /settings — native port of templates/settings.html + static/js/settings.js:
 * theme mode, sky-theme master toggle, per-phase colors with live preview,
 * phase timing offsets, accent colors, cross-tab dev notes, and account.
 * Edits accumulate in a local draft; Save persists via POST /api/theme/save
 * then commits through the theme engine (re-skins this document and
 * broadcasts 'theme-changed' to every mounted legacy iframe).
 */
export function SettingsPage() {
  const [draft, setDraft] = useState<ThemeDraft>(() => draftFromOverrides(getThemeOverrides()));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('');
  const [saving, setSaving] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, []);

  // Warn before the tab closes/reloads with unsaved edits (legacy
  // window.__settingsDirty beforeunload guard).
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // legacy browsers need returnValue set for the prompt to appear
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setStatus('unsaved');
  }, []);

  function update(mutate: (d: ThemeDraft) => ThemeDraft) {
    setDraft(mutate);
    markDirty();
  }

  function onModeChange(mode: ThemeMode) {
    update((d) => ({ ...d, mode }));
    // Live preview immediately (legacy parity): swap the in-memory overrides'
    // mode and re-skin this document — the rest still applies only on Save.
    previewThemeOverrides({ ...getThemeOverrides(), mode });
    rememberThemeMode(mode);
  }

  function onColorChange(phase: PhaseName, key: ColorKey, value: string) {
    update((d) => ({
      ...d,
      themes: { ...d.themes, [phase]: { ...d.themes[phase], [key]: value } },
    }));
  }

  function onTogglePhase(phase: PhaseName, enabled: boolean) {
    update((d) => {
      const phasesEnabled = { ...d.phasesEnabled };
      if (enabled) delete phasesEnabled[phase];
      else phasesEnabled[phase] = false;
      return { ...d, phasesEnabled };
    });
  }

  function onResetPhase(phase: PhaseName) {
    update((d) => {
      const themes = { ...d.themes };
      delete themes[phase];
      return { ...d, themes };
    });
  }

  function onOffsetChange(key: OffsetKey, raw: string) {
    const v = parseFloat(raw);
    if (Number.isNaN(v)) return;
    update((d) => ({ ...d, offsets: { ...d.offsets, [key]: v } }));
  }

  function onAccentChange(key: AccentKey, value: string) {
    update((d) => ({ ...d, accents: { ...d.accents, [key]: value } }));
  }

  async function save() {
    if (!dirty || saving) return;
    const payload = buildSavePayload(draft);
    setSaving(true);
    setStatus('saving…');
    rememberThemeMode(payload.mode ?? 'sky');
    try {
      await saveTheme(payload);
      setDirty(false);
      setStatus('saved');
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => {
        setStatus((cur) => (cur === 'saved' ? '' : cur));
      }, 1200);
      // Apply here and broadcast to every mounted legacy iframe.
      commitThemeOverrides(payload);
    } catch {
      setStatus('save failed');
    } finally {
      setSaving(false);
    }
  }

  if (typeof window !== 'undefined' && window.VIEW_MODE === 'public') {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>Settings aren&rsquo;t available here.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.titlebar}>
          <h1 className={styles.title}>Settings</h1>
          <span className={styles.saveStatus}>{status}</span>
          <button
            type="button"
            className={`${styles.saveBtn} ${dirty ? styles.saveBtnDirty : ''}`}
            disabled={!dirty || saving}
            onClick={save}
          >
            Save
          </button>
        </div>

        <section className={styles.section}>
          <h2 className={styles.heading}>Theme mode</h2>
          <div className={styles.sub}>
            Auto follows Austin sunrise/sunset — lavender by day, indigo at night. Or pick a fixed
            look.
          </div>
          <select
            className={styles.modeSelect}
            value={draft.mode}
            onChange={(e) => onModeChange(e.target.value as ThemeMode)}
            aria-label="Theme mode"
          >
            {MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Sky theme</h2>
          <div className={styles.sub}>
            Used only in &ldquo;Color runway&rdquo; mode. Colors shift through the day based on
            Austin sunrise/sunset.
          </div>
          <label className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Enable sky theme</span>
              <span className={styles.toggleDesc}>
                When off, colors stay frozen at the CSS defaults.
              </span>
            </span>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={draft.enabled}
              onChange={(e) => update((d) => ({ ...d, enabled: e.target.checked }))}
            />
          </label>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Phase colors</h2>
          <div className={styles.sub}>
            Each phase has six colors that the page blends between. Click a phase to expand.
            Disable a phase to make it inherit the next one&rsquo;s colors.
          </div>
          {PHASE_ORDER.map((phase) => (
            <PhaseCard
              key={phase}
              phase={phase}
              draft={draft}
              onColorChange={onColorChange}
              onToggleEnabled={onTogglePhase}
              onReset={onResetPhase}
            />
          ))}
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Phase timing</h2>
          <div className={styles.sub}>
            Boundaries are offsets in hours, relative to sunrise or sunset. Negative means before,
            positive means after.
          </div>
          <div className={styles.rulesCard}>
            {OFFSET_ROWS.map(([key, label, anchor]) => {
              const val = effectiveOffset(draft, key);
              return (
                <div key={key} className={styles.ruleRow}>
                  <label className={styles.ruleLabel} htmlFor={`offset-${key}`}>
                    {label}
                  </label>
                  <span className={styles.ruleAnchor}>{anchor}</span>
                  <span className={styles.ruleFormula}>
                    {anchor} + {val} hr
                  </span>
                  <input
                    id={`offset-${key}`}
                    type="number"
                    step={0.25}
                    className={styles.ruleInput}
                    value={val}
                    onChange={(e) => onOffsetChange(key, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Accent colors</h2>
          <div className={styles.sub}>
            Static colors used for habit-section headers and dot fills. These don&rsquo;t shift
            with the day.
          </div>
          <div className={styles.accentsCard}>
            <div className={styles.accentPreview}>
              {ACCENT_LABELS.map(([key, label]) => (
                <span
                  key={key}
                  className={styles.swatchPill}
                  style={{ background: effectiveAccent(draft, key) }}
                >
                  <span className={styles.swatchDot} />
                  {label}
                </span>
              ))}
            </div>
            {ACCENT_LABELS.map(([key, label]) => (
              <ColorField
                key={key}
                label={label}
                value={effectiveAccent(draft, key)}
                onChange={(v) => onAccentChange(key, v)}
              />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Cross-tab dev notes</h2>
          <div className={styles.sub}>Ideas that don&rsquo;t fit any one page.</div>
          <DevNotesSection />
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Account</h2>
          <AccountSection />
        </section>
      </div>
    </div>
  );
}
