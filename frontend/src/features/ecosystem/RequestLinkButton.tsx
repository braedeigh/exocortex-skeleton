/**
 * RequestLinkButton — the "Request linking" button for a food nobody has
 * traced to a source yet. Pressing it queues the food for the research pass
 * (POST /api/ecosystem/request-link); it does NOT link anything. Once a
 * request is open the button reads "Requested" and can't be pressed again.
 *
 * Shared on purpose: the ecosystem map, the Kitchen's recipe rows and the
 * grocery organic popup all use this one component, so the button looks and
 * behaves the same wherever an untraced food shows up.
 *
 * Touches: ./api.ts (requestLink), ./RequestLink.module.css. The "is it
 * already requested?" answer comes from the caller — pass
 * isFoodRequested(eco_requested, id, name) from ./requestLink.ts, which reads
 * the `eco_requested` marker in /api/data/kitchen and /api/data/ecosystem.
 *
 * Prompt that produced it: untraced foods get "Request linking" — it queues
 * the food for research and doesn't link — in the Kitchen and on the map.
 */
import { useState } from 'react';
import { requestLink } from './api';
import styles from './RequestLink.module.css';

export interface RequestLinkButtonProps {
  /** The food's id, or null when it only exists as a name so far. */
  foodId: number | null;
  foodName: string;
  /** True when an open request already exists — see isFoodRequested. */
  requested: boolean;
  /** Where she asked: 'recipe:<id>', 'grocery' or 'map'. */
  from?: string;
  onRequested?: () => void;
  onError?: (message: string) => void;
}

export function RequestLinkButton({
  foodId,
  foodName,
  requested,
  from = 'map',
  onRequested,
  onError,
}: RequestLinkButtonProps) {
  // Show "Requested" the moment the server says yes, before the caller's
  // next poll brings back the updated `eco_requested` list.
  const [justRequested, setJustRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const isRequested = requested || justRequested;

  // Send the request by id when there is one, by name otherwise.
  async function handleClick() {
    if (isRequested || busy) return;
    setBusy(true);
    try {
      await requestLink(foodId ?? foodName, from);
      setJustRequested(true);
      onRequested?.();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`${styles.btn} ${isRequested ? styles.requested : ''}`}
      disabled={isRequested || busy}
      onClick={(event) => {
        event.stopPropagation();
        void handleClick();
      }}
      title={
        isRequested
          ? `Finding where ${foodName} comes from is queued for research`
          : `Ask research to find where ${foodName} comes from`
      }
    >
      {isRequested ? 'Requested' : busy ? 'Requesting…' : 'Request linking'}
    </button>
  );
}
