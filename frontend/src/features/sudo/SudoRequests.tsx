/**
 * SudoRequests — the open sudo requests as orange cards, for the top of the
 * Observatory roster. Renders nothing when there are none.
 *
 * While it's on screen it tells SudoHost (the bottom popup) to stay down, so
 * the same request never asks for the password in two places at once.
 */
import { useEffect } from 'react';
import { claimInline } from './inlineClaim';
import { SudoPrompt } from './SudoPrompt';
import { useSudoRequests } from './sudoApi';
import styles from './Sudo.module.css';

export function SudoRequests() {
  const { data } = useSudoRequests();
  useEffect(() => claimInline(), []);
  const open = data?.open ?? [];
  if (!open.length) return null;
  return (
    <div className={styles.inline}>
      {open.map((request) => (
        <SudoPrompt key={request.id} request={request} />
      ))}
    </div>
  );
}
