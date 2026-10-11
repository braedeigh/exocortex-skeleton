/**
 * FileRequestCard — one "open this file for me" request as an orange card.
 *
 * What this is, in plain English: a session needs her to change or fill in
 * something in a file herself (scripts/open_file.py). The card names the file,
 * which sessions asked and what they want done, and has one button that opens
 * the file's editor in a new tab. Saving there answers the request and wakes
 * the sessions; Not now closes it and tells them nothing was changed.
 *
 * Used in two places with the same card: the Observatory roster (FileRequests)
 * and the bottom popup on every other page (FileRequestHost). It wears the
 * sudo card's styles (features/sudo/Sudo.module.css), so the two kinds of
 * "an agent is waiting on you" look alike.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../../ui';
import { sessionLocation } from '../observatory/sessionLocation';
import { editorHref, useDismissFileRequest } from './fileEditApi';
import type { FileRequest } from './fileEditApi';
import styles from '../sudo/Sudo.module.css';

export function FileRequestCard({ request }: { request: FileRequest }) {
  const navigate = useNavigate();
  const dismiss = useDismissFileRequest();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function notNow() {
    setBusy(true);
    try {
      await dismiss(request.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.tag}>file to edit</span>
        <span className={styles.label}>{request.path.split('/').slice(-1)[0]}</span>
      </div>
      <code className={styles.command}>
        {request.repo}: {request.path}
      </code>
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
        {/* Open the editor in a new tab. Called straight from the click,
            because an installed PWA blocks window.open from anywhere else. */}
        <Button
          type="button"
          data-track="file-request-open"
          onClick={() => window.open(editorHref(request.repo, request.path), '_blank')}
        >
          Open to edit
        </Button>
        <Button type="button" variant="secondary" disabled={busy} data-track="file-request-dismiss" onClick={() => void notNow()}>
          Not now
        </Button>
      </div>
      {message ? <p className={styles.message}>{message}</p> : null}
    </div>
  );
}
