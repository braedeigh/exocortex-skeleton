import { useState } from 'react';
import { ApiError } from '../../api/client';
import { changePassword } from './settingsApi';
import styles from './AccountSection.module.css';

type MsgKind = 'info' | 'error' | 'success';

/**
 * Account — change password (POST /api/auth/change-password, same
 * client-side validation as settings.js changePassword()) and sign out as a
 * plain /logout link (full navigation: Flask clears the session and
 * redirects to /login).
 */
export function AccountSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: MsgKind; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!current || !next) {
      setMsg({ kind: 'error', text: 'Fill in current and new password.' });
      return;
    }
    if (next.length < 6) {
      setMsg({ kind: 'error', text: 'New password must be 6+ characters.' });
      return;
    }
    if (next !== confirm) {
      setMsg({ kind: 'error', text: "New and confirm don't match." });
      return;
    }
    setMsg({ kind: 'info', text: 'changing…' });
    setBusy(true);
    try {
      await changePassword(current, next);
      setMsg({ kind: 'success', text: 'Password updated.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (e) {
      const text = e instanceof ApiError && e.message ? e.message : 'Network error.';
      setMsg({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <details className={styles.pwChange}>
        <summary className={styles.summary}>Change password</summary>
        <div className={styles.form}>
          <input
            type="password"
            className={styles.input}
            placeholder="Current password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-label="Current password"
          />
          <input
            type="password"
            className={styles.input}
            placeholder="New password (6+ chars)"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-label="New password"
          />
          <input
            type="password"
            className={styles.input}
            placeholder="Confirm new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-label="Confirm new password"
          />
          <div className={styles.actions}>
            <button type="button" className={styles.changeBtn} onClick={submit} disabled={busy}>
              Change password
            </button>
            {msg ? (
              <span
                className={`${styles.msg} ${msg.kind === 'error' ? styles.msgError : ''} ${
                  msg.kind === 'success' ? styles.msgSuccess : ''
                }`}
              >
                {msg.text}
              </span>
            ) : null}
          </div>
        </div>
      </details>
      <div className={styles.signoutRow}>
        <a href="/logout" className={styles.signoutLink}>
          Sign out
        </a>
      </div>
    </>
  );
}
