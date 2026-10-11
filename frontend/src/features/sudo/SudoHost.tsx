/**
 * SudoHost — the bottom-of-page popup for sudo requests. Mounted once at the
 * app root (routes/__root.tsx, beside ApprovalsHost), so a request reaches her
 * on whatever page she's on.
 *
 * It shows the oldest open request as the same orange card the roster uses,
 * password box and all. The × tucks it into a small orange pill (still there,
 * still counting); tapping the pill opens it again. A request that arrives
 * after she tucked it away opens it again by itself. It stays hidden while the
 * Observatory roster is showing the cards itself (inlineClaim.ts).
 */
import { useState, useSyncExternalStore } from 'react';
import { inlineShown, subscribeInline } from './inlineClaim';
import { SudoPrompt } from './SudoPrompt';
import { useSudoRequests } from './sudoApi';
import styles from './Sudo.module.css';

export function SudoHost() {
  const { data } = useSudoRequests();
  const inline = useSyncExternalStore(subscribeInline, inlineShown);
  // Which request she tucked away — a newer first request pops it back open.
  const [tuckedId, setTuckedId] = useState<string | null>(null);
  const open = data?.open ?? [];
  if (!open.length || inline) return null;
  const first = open[0];

  if (tuckedId === first.id) {
    return (
      <button type="button" className={styles.pill} onClick={() => setTuckedId(null)}>
        <span className={styles.pillBadge}>{open.length}</span>
        sudo {open.length === 1 ? 'request' : 'requests'} waiting
      </button>
    );
  }

  return (
    <div className={styles.popup} role="dialog" aria-label="sudo request">
      <button
        type="button"
        className={styles.close}
        aria-label="Tuck away"
        onClick={() => setTuckedId(first.id)}
      >
        ×
      </button>
      <SudoPrompt key={first.id} request={first} />
      {open.length > 1 ? <p className={styles.more}>+{open.length - 1} more after this one</p> : null}
    </div>
  );
}
