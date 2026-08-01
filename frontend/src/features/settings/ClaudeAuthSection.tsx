import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  cancelClaudeAuth,
  fetchClaudeAuth,
  startClaudeAuth,
  submitClaudeAuthCode,
  type ClaudeAuthStatus,
} from './settingsApi';
import styles from './ClaudeAuthSection.module.css';

/**
 * Claude login — re-authenticate the box from the phone.
 *
 * Everything on this box that talks to Claude shares one OAuth token, and its
 * refresh half expires roughly every 60 days. When it lapses, the Observatory
 * and the keeper rollover stop at once. Logging back in normally means sitting
 * at the machine, which is the thing this card exists to avoid.
 *
 * The flow has exactly two steps a human must do, and they're the whole UI:
 * open the authorization link in a real browser, then paste the code back.
 * Everything around them is handled by routes/claude_auth.py driving a hidden
 * tmux pane.
 *
 * WHY THE LINK IS A PLAIN <a target="_blank"> AND NOT AN ONCLICK: installed to
 * the home screen, this app runs as a standalone PWA, where `window.open()`
 * called from anything but a direct user gesture is blocked — the tap would
 * appear to do nothing. A real anchor hands off to the system browser, which
 * is also where she's already signed in to claude.com.
 *
 * Prompt that shaped it: "figure out how to make /login work in my
 * observatory — I want it to push through the PWA to open a browser tab."
 */

/** How often to re-poll while the pane is working toward the URL. */
const POLL_MS = 2000;

type Msg = { kind: 'info' | 'error' | 'success'; text: string } | null;

/** "28.8 days left" in the register she reads at a glance, plus whether that
 * number should be alarming. Under a week is worth colouring; expired is worth
 * saying outright, because at that point nothing on the box works. */
function runway(days: number | null): { text: string; urgent: boolean } {
  if (days === null) return { text: 'not signed in', urgent: true };
  if (days <= 0) return { text: 'expired — Claude is down on this box', urgent: true };
  if (days < 1) return { text: 'expires today', urgent: true };
  return { text: `${Math.floor(days)} days left`, urgent: days < 7 };
}

export function ClaudeAuthSection() {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchClaudeAuth());
    } catch {
      /* a failed poll is not worth a message — the next one usually lands */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while the pane is mid-flight. Once the URL is up (or the flow is
  // idle) nothing changes server-side until she acts, so polling stops.
  useEffect(() => {
    if (status?.state !== 'starting') {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [status?.state, refresh]);

  async function start() {
    setBusy(true);
    setMsg({ kind: 'info', text: 'starting the login…' });
    try {
      await startClaudeAuth();
      setCode('');
      setStatus({ state: 'starting', url: null, expires_at: null, days_left: null });
      setMsg({ kind: 'info', text: 'waiting for the authorization link…' });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Network error.' });
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!code.trim()) {
      setMsg({ kind: 'error', text: 'Paste the code first.' });
      return;
    }
    setBusy(true);
    setMsg({ kind: 'info', text: 'checking…' });
    try {
      const next = await submitClaudeAuthCode(code.trim());
      setStatus(next);
      setCode('');
      setMsg({ kind: 'success', text: 'Signed in. The box is good again.' });
    } catch (e) {
      setMsg({
        kind: 'error',
        text: e instanceof ApiError && e.message ? e.message : 'Network error.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await cancelClaudeAuth();
      setCode('');
      setMsg(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state ?? 'idle';
  const { text: runwayText, urgent } = runway(status?.days_left ?? null);

  return (
    <div className={styles.section}>
      <div className={styles.headRow}>
        <div>
          <div className={styles.title}>Claude login</div>
          <div className={`${styles.runway} ${urgent ? styles.urgent : ''}`}>
            {runwayText}
            {status?.expires_at ? (
              <span className={styles.dim}> · {status.expires_at.slice(0, 10)}</span>
            ) : null}
          </div>
        </div>
        {state === 'idle' || state === 'done' ? (
          <button type="button" className={styles.primaryBtn} onClick={start} disabled={busy}>
            Re-authenticate
          </button>
        ) : (
          <button type="button" className={styles.cancelBtn} onClick={cancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>

      {state === 'starting' ? (
        <div className={styles.waiting}>Opening a login session on the box…</div>
      ) : null}

      {state === 'awaiting_code' && status?.url ? (
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepNum}>1</span>
            <a
              className={styles.authLink}
              href={status.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the Claude authorization page
            </a>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>2</span>
            <div className={styles.codeRow}>
              <input
                className={styles.input}
                placeholder="Paste the code from that page"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Authorization code"
              />
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={submit}
                disabled={busy}
              >
                Sign in
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {msg ? (
        <div
          className={`${styles.msg} ${msg.kind === 'error' ? styles.msgError : ''} ${
            msg.kind === 'success' ? styles.msgSuccess : ''
          }`}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}
