import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { useToasts } from '../journal/useJournalData';
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
import { USAGE_HEAT_EVENT, USAGE_HEAT_STORAGE_KEY } from '../../ui/usageHeat';
import { chatSurfaceIsReadingRoom, setChatSurfaceReadingRoom } from '../../shell/chatSurface';
import { AccountSection } from './AccountSection';
import { ColorField } from './ColorField';
import { DevNotesSection } from './DevNotesSection';
import { NotificationsSection } from './NotificationsSection';
import { PhaseCard } from './PhaseCard';
import { ProfileSection } from './ProfileSection';
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
 * phase timing offsets, accent colors, cross-tab dev notes, profile
 * (owner name/email/app name), and account.
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
  const { toasts, push, dismiss } = useToasts();

  // Usage heat view — a localStorage toggle, independent of the theme draft:
  // commits instantly (no Save), and the window event lets any open /journal
  // or /todos page react without a reload (see src/ui/usageHeat.ts).
  const [usageHeat, setUsageHeat] = useState(() => {
    try {
      return localStorage.getItem(USAGE_HEAT_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  function onUsageHeatChange(on: boolean) {
    setUsageHeat(on);
    try {
      localStorage.setItem(USAGE_HEAT_STORAGE_KEY, on ? '1' : '');
    } catch {
      // storage denied — the toggle still works for this page via the event
    }
    window.dispatchEvent(new CustomEvent(USAGE_HEAT_EVENT, { detail: { enabled: on } }));
  }

  // Chat tab surface: terminal (default) or the Keeper bot's reading room.
  const [chatBots, setChatBots] = useState(chatSurfaceIsReadingRoom);
  function onChatSurfaceChange(on: boolean) {
    setChatBots(on);
    setChatSurfaceReadingRoom(on);
  }

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
          <span
            className={
              status === 'save failed' ? `${styles.saveStatus} ${styles.saveStatusError}` : styles.saveStatus
            }
          >
            {status}
          </span>
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
          <h2 className={styles.heading}>Chat surface</h2>
          <label className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Chat tab opens the Keeper</span>
              <span className={styles.toggleDesc}>
                The Chat tab opens the Keeper&rsquo;s reading room (streaming, journaled)
                instead of the tmux terminal. The terminal stays in More &#9662; &rarr; Terminal.
              </span>
            </span>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={chatBots}
              onChange={(e) => onChatSurfaceChange(e.target.checked)}
            />
          </label>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Usage heat view</h2>
          <label className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Usage heat view</span>
              <span className={styles.toggleDesc}>
                Tint Journal and To Do controls by how often you use them
              </span>
            </span>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={usageHeat}
              onChange={(e) => onUsageHeatChange(e.target.checked)}
            />
          </label>
          <div className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Export usage data</span>
              <span className={styles.toggleDesc}>
                Downloads your usage counts as a file &mdash; tab time, taps, routes. Day-level
                only, no content, no identity. Look it over, then share it if you choose.
              </span>
            </span>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={() => {
                // A plain navigation is the most reliable download path in the
                // PWA: the route answers Content-Disposition: attachment, so
                // the browser saves the file without leaving the page.
                window.location.assign('/api/usage/export');
              }}
            >
              Export
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Cross-tab dev notes</h2>
          <div className={styles.sub}>Ideas that don&rsquo;t fit any one page.</div>
          <DevNotesSection onError={push} />
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Profile</h2>
          <div className={styles.sub}>
            How your exocortex addresses you and titles itself. Leave a field empty to use the
            default.
          </div>
          <ProfileSection />
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Notifications</h2>
          <NotificationsSection />
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Account</h2>
          <AccountSection />
        </section>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
