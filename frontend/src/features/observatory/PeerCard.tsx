/**
 * PeerCard.tsx — one message between two agents, drawn in a chat.
 *
 * What this is, in plain English: when one of her agents messages another
 * (scripts/peers.py → peermail.py), the message shows up in BOTH chats as a
 * small teal card — "→ sent to <session>" in the sender's, "← from <session>"
 * in the recipient's — so she can see what her agents say to each other
 * without it reading as her words or as a reply. The other session's name
 * opens it. Nothing holds new messages any more; one the old count brakes
 * held still says why, with a button to let it through.
 *
 * Touches: events.ts (the `peer` turn it draws), api.ts (releasePeerMessage),
 * sessionLocation.ts (opening the other session), ObservatoryPage.tsx (where
 * it's placed).
 *
 * Prompt that produced it: "agent to agent messages should show automatically
 * yes so that i see what it's sent. they should be a little colored card."
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { releasePeerMessage } from './api';
import type { PeerMessage } from './events';
import styles from './PeerCard.module.css';
import { sessionLocation } from './sessionLocation';

const MODE_WORDS: Record<PeerMessage['mode'], string> = {
  inject: '',
  queue: ' · after its turn',
  interrupt: ' · interrupting',
};

export function PeerCard({ peer, text }: { peer: PeerMessage; text: string }) {
  const navigate = useNavigate();
  // Released here, before the server's peer-status line arrives in history.
  const [released, setReleased] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const held = peer.status === 'held' && !released;
  const out = peer.direction === 'out';
  const name = peer.otherTitle || peer.otherConv;

  const release = () => {
    setReleaseError('');
    releasePeerMessage(peer.id).then(
      () => setReleased(true),
      () => setReleaseError('Couldn’t release it — it may already have gone.'),
    );
  };

  return (
    <div className={[styles.card, held ? styles.held : ''].filter(Boolean).join(' ')}>
      <div className={styles.head}>
        <span className={styles.arrow} aria-hidden="true">
          {out ? '→' : '←'}
        </span>
        <span className={styles.label}>
          {out ? 'Sent to ' : 'From '}
          <button type="button" className={styles.who} onClick={() => void navigate(sessionLocation(peer.otherConv))}>
            {name}
          </button>
          {MODE_WORDS[peer.mode]}
        </span>
      </div>
      <div className={styles.text}>{text}</div>
      {held ? (
        <div className={styles.heldRow}>
          <span className={styles.heldWhy}>Held: {peer.heldReason || 'a brake stopped it'}</span>
          <button type="button" className={styles.release} onClick={release}>
            Let it through
          </button>
        </div>
      ) : null}
      {releaseError ? <div className={styles.heldWhy}>{releaseError}</div> : null}
    </div>
  );
}
