/**
 * FileRequestHost — the bottom-of-page popup for "file to edit" requests.
 * Mounted once at the app root (routes/__root.tsx, beside SudoHost), so a
 * request reaches her on whatever page she's on.
 *
 * It behaves like the sudo popup: the oldest open request as an orange card,
 * an × that tucks it into a small pill, and a newer first request opening it
 * again. It stays hidden while the Observatory roster is showing the cards
 * itself, and while a sudo request is up — that popup sits in the same corner,
 * so they take turns, sudo first.
 */
import { useState, useSyncExternalStore } from 'react';
import { inlineShown, subscribeInline } from '../sudo/inlineClaim';
import { useSudoRequests } from '../sudo/sudoApi';
import { FileRequestCard } from './FileRequestCard';
import { useFileRequests } from './fileEditApi';
import styles from '../sudo/Sudo.module.css';

export function FileRequestHost() {
  const { data } = useFileRequests();
  const sudo = useSudoRequests();
  const inline = useSyncExternalStore(subscribeInline, inlineShown);
  // Which request she tucked away — a newer first request pops it back open.
  const [tuckedId, setTuckedId] = useState<string | null>(null);
  const open = data?.open ?? [];
  if (!open.length || inline || (sudo.data?.open.length ?? 0) > 0) return null;
  const first = open[0];

  if (tuckedId === first.id) {
    return (
      <button type="button" className={styles.pill} onClick={() => setTuckedId(null)}>
        <span className={styles.pillBadge}>{open.length}</span>
        {open.length === 1 ? 'file' : 'files'} to edit
      </button>
    );
  }

  return (
    <div className={styles.popup} role="dialog" aria-label="file to edit">
      <button
        type="button"
        className={styles.close}
        aria-label="Tuck away"
        onClick={() => setTuckedId(first.id)}
      >
        ×
      </button>
      <FileRequestCard key={first.id} request={first} />
      {open.length > 1 ? <p className={styles.more}>+{open.length - 1} more after this one</p> : null}
    </div>
  );
}
