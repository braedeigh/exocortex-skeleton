import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { startVscode, stopVscode } from './api';
import { useVscodeStatus } from './useVscodeStatus';
import {
  EDITOR_URL,
  REDIRECT_DELAY_MS,
  STOP_SETTLE_MS,
  formatMb,
  formatMemText,
  isMemLow,
  memPercent,
  showLowMemWarning,
  warnDetail,
} from './vscodeMath';
import styles from './VscodePage.module.css';

/**
 * /vscode — native port of templates/vscode_launcher.html: memory gauge,
 * Open/Close Editor buttons over /api/vscode/{status,start,stop}, low-RAM
 * warning with the top memory hogs, and the redirect dance:
 *
 *  - Already running on load → straight to EDITOR_URL, no UI.
 *  - Click Open → POST start, poll status at 1s; on the off→running
 *    transition show "running — opening…" for 400ms, then redirect.
 *  - Click Close → POST stop, wait 800ms, re-check once.
 *
 * The redirect is a full window.location navigation because /files/ (with
 * the trailing slash) is the code-server reverse proxy — a different app
 * entirely from the SPA's /files route.
 */

type PillTone = 'on' | 'off' | 'starting';

interface Pill {
  tone: PillTone;
  text: string;
  spinner?: boolean;
}

interface PrimaryView {
  label: string;
  disabled: boolean;
}

const PILL_TONE_CLASS: Record<PillTone, string> = {
  on: styles.pillOn,
  off: styles.pillOff,
  starting: styles.pillStarting,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function VscodePage() {
  const [pill, setPill] = useState<Pill>({ tone: 'off', text: 'checking…' });
  const [polling, setPolling] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [stopDisabled, setStopDisabled] = useState(false);
  // Set on click, cleared by the next status render — same lifecycle as the
  // old page mutating primaryBtn directly.
  const [primaryOverride, setPrimaryOverride] = useState<PrimaryView | null>(null);

  // Mirrors the old `starting` flag: true from Open-click until the
  // off→running transition (or start failure). A ref because the status
  // effect must read the value the moment data lands, not a stale closure.
  const startingRef = useRef(false);
  const checkedInitialRef = useRef(false);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, dataUpdatedAt, isError, errorUpdatedAt, refetch } = useVscodeStatus(polling);

  // Leaving the page mid-"opening…" must not hijack navigation later.
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  // Port of the old render(s) + init IIFE, run once per status fetch.
  // dataUpdatedAt is the dep (not data): structural sharing keeps the same
  // object across identical polls, but each tick must still be observed.
  useEffect(() => {
    if (!data || dataUpdatedAt === 0 || redirecting) return;

    if (!checkedInitialRef.current) {
      checkedInitialRef.current = true;
      if (data.running) {
        // Already running on first check → redirect immediately (old page
        // never rendered the launcher in this case).
        setRedirecting(true);
        window.location.href = EDITOR_URL;
        return;
      }
    }

    if (data.running) {
      if (startingRef.current) {
        // Just transitioned to running → stop polling, then redirect.
        startingRef.current = false;
        setPolling(false);
        setRedirecting(true);
        setPill({ tone: 'on', text: 'running — opening…' });
        redirectTimerRef.current = setTimeout(() => {
          window.location.href = EDITOR_URL;
        }, REDIRECT_DELAY_MS);
        return;
      }
      // Reachable when a stop fails: running again, buttons back to normal.
      setPill({ tone: 'on', text: 'running' });
    } else {
      setPill({ tone: 'off', text: 'off' });
    }
    setPrimaryOverride(null);
  }, [data, dataUpdatedAt, redirecting]);

  // Old refresh() catch: any failed status check flips the pill.
  useEffect(() => {
    if (!isError || errorUpdatedAt === 0 || redirecting) return;
    setPill({ tone: 'off', text: 'status check failed' });
  }, [isError, errorUpdatedAt, redirecting]);

  async function handleStart() {
    setPrimaryOverride({ label: 'Open Editor', disabled: true });
    setPill({ tone: 'starting', text: 'starting…', spinner: true });
    startingRef.current = true;
    try {
      await startVscode();
      setPolling(true);
    } catch {
      startingRef.current = false;
      setPill({ tone: 'off', text: 'start failed' });
      setPrimaryOverride({ label: 'Try again', disabled: false });
    }
  }

  async function handleStop() {
    setStopDisabled(true);
    setPill({ tone: 'off', text: 'stopping…' });
    try {
      await stopVscode();
      await sleep(STOP_SETTLE_MS);
    } catch {
      // Old page ignored stop errors too — the re-check below tells the truth.
    } finally {
      setStopDisabled(false);
      void refetch();
    }
  }

  const pct = data ? memPercent(data.available_mb, data.total_mb) : 0;
  const memText = data ? formatMemText(data.available_mb, data.total_mb) : '—';
  const memLow = data ? isMemLow(data) : false;
  const showWarn = !redirecting && !!data && showLowMemWarning(data);
  const showStop = !redirecting && !!data && data.running;

  const primary: PrimaryView =
    primaryOverride ??
    (showWarn ? { label: 'Not enough memory', disabled: true } : { label: 'Open Editor', disabled: false });

  return (
    <div className={styles.wrap}>
      <div className={styles.box}>
        <h1 className={styles.title}>VS Code</h1>
        <p className={styles.sub}>In-browser editor — kept off to save memory</p>

        <div className={`${styles.pill} ${PILL_TONE_CLASS[pill.tone]}`} role="status">
          {pill.spinner ? <span className={styles.spinner} aria-hidden="true" /> : null}
          {pill.text}
        </div>

        <div className={styles.memRow}>
          <span className={styles.memLabel}>Memory available</span>
          <span className={styles.memValue}>{memText}</span>
        </div>
        <div
          className={styles.memBar}
          role="meter"
          aria-label="Memory available"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className={memLow ? `${styles.memFill} ${styles.memFillLow}` : styles.memFill}
            style={{ width: `${pct}%` }}
          />
        </div>

        {showWarn && data ? (
          <div className={styles.warn}>
            <div className={styles.warnTitle}>Not enough memory to start</div>
            <div>{warnDetail(data.threshold_mb)}</div>
            <ul className={styles.procList}>
              {data.top_processes.map((p) => (
                <li key={p.name}>
                  <span>{p.name}</span>
                  <span>{formatMb(p.mb)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Button fullWidth disabled={primary.disabled || redirecting} onClick={() => void handleStart()}>
          {primary.label}
        </Button>
        {showStop ? (
          <Button
            fullWidth
            variant="secondary"
            className={styles.stopBtn}
            disabled={stopDisabled}
            onClick={() => void handleStop()}
          >
            Close Editor (free memory)
          </Button>
        ) : null}
      </div>
    </div>
  );
}
