/**
 * SudoPrompt — one sudo request as an orange card with a password box.
 *
 * What this is, in plain English: an agent asked for a root command to be run
 * (sudo_requests.py). The card says what it is — the plain name, the exact
 * command line, which sessions asked and why — and takes her password. Approve
 * sends it to the server, which passes it straight to sudo and forgets it;
 * Decline turns the request down. Either way the asking sessions are woken.
 *
 * Used in two places with the same card: the Observatory roster (SudoRequests)
 * and the bottom popup on every other page (SudoHost).
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../../ui';
import { sessionLocation } from '../observatory/sessionLocation';
import { useSudoActions } from './sudoApi';
import type { SudoRequest } from './sudoApi';
import styles from './Sudo.module.css';

export function SudoPrompt({ request, autoFocus = false }: { request: SudoRequest; autoFocus?: boolean }) {
  const navigate = useNavigate();
  const { approve, deny } = useSudoActions();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const running = request.status === 'running';

  // Approve: send the password, then say plainly what sudo answered.
  // A wrong or missing password keeps the card up with the box cleared.
  async function submit() {
    setBusy(true);
    setMessage('');
    try {
      const result = await approve(request.id, password);
      setPassword('');
      if (result.status === 'wrong_password') setMessage('Wrong password — try again.');
      else if (result.status === 'needs_password') setMessage('This one needs your password.');
      else if (result.status === 'failed') setMessage(`It ran but failed (exit ${result.exit}).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await deny(request.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.card}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={styles.head}>
        <span className={styles.tag}>sudo request</span>
        <span className={styles.label}>{request.label}</span>
      </div>
      {request.command ? <code className={styles.command}>{request.command}</code> : null}
      <ul className={styles.askers}>
        {request.askers.map((asker) => (
          <li key={asker.conv || asker.at}>
            {asker.conv ? (
              <button
                type="button"
                className={styles.asker}
                onClick={() => void navigate(sessionLocation(asker.conv))}
              >
                {asker.title}
              </button>
            ) : (
              <span className={styles.askerPlain}>{asker.title}</span>
            )}
            {asker.reason ? <span className={styles.reason}> — {asker.reason}</span> : null}
          </li>
        ))}
      </ul>
      <div className={styles.row}>
        <input
          className={styles.password}
          type="password"
          autoComplete="off"
          placeholder="Your password (blank if sudo doesn’t need one)"
          aria-label="sudo password"
          value={password}
          autoFocus={autoFocus}
          disabled={busy || running}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className={styles.row}>
        <Button type="submit" disabled={busy || running}>
          {busy || running ? 'Running…' : 'Approve'}
        </Button>
        <Button type="button" variant="secondary" disabled={busy || running} onClick={() => void decline()}>
          Decline
        </Button>
      </div>
      {message ? <p className={styles.message}>{message}</p> : null}
    </form>
  );
}
