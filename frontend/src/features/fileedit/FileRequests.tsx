/**
 * FileRequests — the open "file to edit" requests as orange cards, for the top
 * of the Observatory roster, under the sudo cards. Renders nothing when there
 * are none.
 *
 * While it's on screen it tells the bottom popups to stay down
 * (features/sudo/inlineClaim.ts, the same claim the sudo cards make), so a
 * request never shows in two places at once.
 */
import { useEffect } from 'react';
import { claimInline } from '../sudo/inlineClaim';
import { FileRequestCard } from './FileRequestCard';
import { useFileRequests } from './fileEditApi';
import styles from '../sudo/Sudo.module.css';

export function FileRequests() {
  const { data } = useFileRequests();
  useEffect(() => claimInline(), []);
  const open = data?.open ?? [];
  if (!open.length) return null;
  return (
    <div className={styles.inline}>
      {open.map((request) => (
        <FileRequestCard key={request.id} request={request} />
      ))}
    </div>
  );
}
