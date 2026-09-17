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
import { effectsReduced, setEffectsReduced } from '../../ui/effects';
import { chatSurfaceIsObservatory, setChatSurfaceObservatory } from '../../shell/chatSurface';
import { AccountSection } from './AccountSection';
import { ClaudeAuthSection } from './ClaudeAuthSection';
import { ColorField } from './ColorField';
import { DevNotesSection } from './DevNotesSection';
import { NotificationsSection } from './NotificationsSection';
import { PhaseCard } from './PhaseCard';
import { ProfileSection } from './ProfileSection';
import { ThemeModeTiles } from './ThemeModeTiles';
import { saveTheme } from './settingsApi';
import {
  buildSavePayload,
  draftFromOverrides,
  effectiveAccent,
  effectiveOffset,
  type ThemeDraft,
} from './settingsHelpers';
import styles from './SettingsPage.module.css';

const ADVANCED_STORAGE_KEY = 'settingsAdvancedColorsOpen';

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
 * /settings — theme, chat surface, reduced effects, usage heat, cross-tab dev
 * notes, profile (owner name/email/app name), notifications, Claude login and
 * account.
 *
 * The theme section shows one thing: four mode tiles (ThemeModeTiles), with
 * Auto as the default. All the tuning — the runway toggle, the seven phase
 * palettes, the phase timing offsets, the accent colors — lives behind a
 * single "Advanced colors" disclosure that stays shut until she opens it
 * (remembered in localStorage).
 *
 * Theme edits accumulate in a local draft; Save persists via POST
 * /api/theme/save then commits through the theme engine (re-skins this
 * document and broadcasts 'theme-changed' to every mounted legacy iframe).
 * The mode tiles are the exception — they preview live on click.
 *
 * Prompt behind this shape: "in my settings there is not a good colour theme
 * setting — I want auto colour theme, advanced colour settings accessible with
 * a click into the UI, and otherwise only theme mode." 
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

  // Reduced effects — same shape as the usage-heat toggle: localStorage, no
  // Save, and the module's window event changes every open page over live.
  // Initialised from effectsReduced() rather than storage directly, so an
  // untouched install reflects the OS hint it's already following.
  const [reducedFx, setReducedFx] = useState(effectsReduced);

  function onReducedFxChange(on: boolean) {
    setReducedFx(on);
    setEffectsReduced(on);
  }

  // Advanced colours stay shut unless she opened them before — same
  // localStorage-remembered disclosure idiom as the collapsible cards.
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try {
      return localStorage.getItem(ADVANCED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  function onAdvancedToggle(open: boolean) {
    setAdvancedOpen(open);
    try {
      localStorage.setItem(ADVANCED_STORAGE_KEY, open ? '1' : '0');
    } catch {
      // storage denied — it just won't persist
    }
  }

  // Chat tab surface: terminal (default) or the Keeper bot's observatory.
  const [chatBots, setChatBots] = useState(chatSurfaceIsObservatory);
  function onChatSurfaceChange(on: boolean) {
    setChatBots(on);
    setChatSurfaceObservatory(on);
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
    // Choosing "Color runway" IS switching the runway on. Without this, the
    // separate `enabled` toggle buried in Advanced silently wins and the tile
    // does nothing visible — the mode picker has to mean what it says.
    const enable = mode === 'sky' ? true : undefined;
    update((d) => ({ ...d, mode, ...(enable ? { enabled: true } : {}) }));
    // Live preview immediately (legacy parity): swap the in-memory overrides'
    // mode and re-skin this document — the rest still applies only on Save.
    previewThemeOverrides({
      ...getThemeOverrides(),
      mode,
      ...(enable ? { enabled: true } : {}),
    });
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
    rememberThemeMode(payload.mode ?? 'auto');
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
          <h2 className={styles.heading}>Theme</h2>
          <div className={styles.sub}>
            Auto follows Austin sunrise and sunset. Pick a fixed look instead, or let the color
            drift through the whole day.
          </div>
          <ThemeModeTiles draft={draft} onChange={onModeChange} />

          {/* Everything below is the sky-runway machinery — 60-odd colour
              pickers and timing offsets that only matter if she's tuning the
              palette. One disclosure, shut by default, state remembered, so
              the page reads as "pick a theme" and nothing else. */}
          <details
            className={styles.advanced}
            open={advancedOpen}
            onToggle={(e) => onAdvancedToggle(e.currentTarget.open)}
          >
            <summary className={styles.advancedSummary}>
              <span className={styles.advancedChevron} aria-hidden="true">
                &#9656;
              </span>
              <span>
                <span className={styles.advancedLabel}>Advanced colors</span>
                <span className={styles.advancedDesc}>
                  Per-phase palettes, when each phase starts, and the accent colors
                </span>
              </span>
            </summary>

            <div className={styles.advancedBody}>
              <div className={styles.subsection}>
                <h3 className={styles.subheading}>Color runway</h3>
                <div className={styles.sub}>
                  Only used in &ldquo;Color runway&rdquo; mode. Colors shift through the day
                  based on Austin sunrise/sunset.
                </div>
                <label className={styles.toggleRow}>
                  <span>
                    <span className={styles.toggleLabel}>Enable the runway</span>
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
              </div>

              <div className={styles.subsection}>
                <h3 className={styles.subheading}>Phase colors</h3>
                <div className={styles.sub}>
                  Each phase has six colors that the page blends between. Click a phase to
                  expand. Disabling a phase only affects Color runway mode &mdash; the runway
                  slides past it wearing the next phase&rsquo;s colors. Light, Dark and Auto
                  always use the palettes as you set them here.
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
              </div>

              <div className={styles.subsection}>
                <h3 className={styles.subheading}>Phase timing</h3>
                <div className={styles.sub}>
                  Boundaries are offsets in hours, relative to sunrise or sunset. Negative means
                  before, positive means after.
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
              </div>

              <div className={styles.subsection}>
                <h3 className={styles.subheading}>Accent colors</h3>
                <div className={styles.sub}>
                  Static colors used for habit-section headers and dot fills. These don&rsquo;t
                  shift with the day.
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
              </div>
            </div>
          </details>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Chat surface</h2>
          <label className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Chat tab opens the Keeper</span>
              <span className={styles.toggleDesc}>
                The Chat tab opens the Keeper&rsquo;s observatory (streaming, journaled)
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
          <h2 className={styles.heading}>Reduced effects</h2>
          <label className={styles.toggleRow}>
            <span>
              <span className={styles.toggleLabel}>Turn off frosted glass</span>
              <span className={styles.toggleDesc}>
                Panels, docks and overlays stop blurring what&rsquo;s behind them and use a solid
                tint instead. Blurring is the most expensive thing this app draws, and it costs
                on every frame even when nothing is moving &mdash; so if the interface feels
                laggy, especially on a big screen or an older laptop, turn this on. Nothing moves
                or disappears; it just loses some depth.
              </span>
            </span>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={reducedFx}
              onChange={(e) => onReducedFxChange(e.target.checked)}
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
          <h2 className={styles.heading}>Claude login</h2>
          <ClaudeAuthSection />
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
