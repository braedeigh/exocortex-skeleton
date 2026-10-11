/**
 * SpinoffOffer — the Go button a /spinoff grows at the bottom of her chat, and
 * the question the new session asks when she arrives from it.
 *
 * What it does: when the agent in this chat runs /spinoff, it writes the
 * briefs and stages an offer on this conversation (scripts/spinoff_offer.py →
 * routes/spinoff.py) instead of asking "shall I?" in words. `SpinoffOffer`
 * reads that offer and draws a card after the latest reply: what would start,
 * a Go, and a ×. Go starts the sessions and opens the first one, carrying
 * `?from=<this chat>` in the URL. She can also ignore the card and keep
 * talking; it waits until she taps Go or ×, or the agent offers again.
 *
 * `CloseSourcePrompt` is the other half. It sits at the top of the session
 * she was just taken to, asks whether to close the chat she came from, and
 * clears `from` from the URL either way so a reload doesn't ask again.
 *
 * Talks to: observatory/api.ts (getSpinoffOffer, goSpinoffOffer,
 * dismissSpinoffOffer, closeConversation, getSessions); mounted by
 * ObservatoryPage.tsx.
 *
 * Prompt: "Make it such that the /spinoff skill comes with a UI. instead of it
 * asking go, I can click a "go" button that emerges at the bottom of the chat,
 * or just keep talking. Then it takes me to that chat and prompts me to close
 * the existing chat or not"
 */
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, IconButton } from '../../ui';
import {
  closeConversation,
  dismissSpinoffOffer,
  getSessions,
  getSpinoffOffer,
  goSpinoffOffer,
  type SpinoffOffer as Offer,
} from './api';
import styles from './SpinoffOffer.module.css';

export function SpinoffOffer({
  convId,
  writing,
  pinned,
}: {
  convId: string;
  /** A turn is in progress. The offer is staged mid-turn, so the card
   * re-reads each time a turn ends rather than polling. */
  writing: boolean;
  /** The pinned Keeper session can't be closed, so it never asks. */
  pinned: boolean;
}) {
  const navigate = useNavigate();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read the offer when the chat opens and again whenever a turn finishes.
  useEffect(() => {
    if (writing) return;
    const ac = new AbortController();
    getSpinoffOffer(convId, ac.signal)
      .then((data) => setOffer(data.offer))
      .catch(() => {});
    return () => ac.abort();
  }, [convId, writing]);

  if (!offer) return null;

  // Start everything offered, then open the first session that started. A
  // partial failure stays here to be read instead of vanishing behind the
  // navigation.
  const go = () => {
    setBusy(true);
    setError(null);
    goSpinoffOffer(convId)
      .then((result) => {
        const first = result.spawned[0];
        const failed = result.errors.map((e) => `${e.slug}: ${e.error}`).join(' · ');
        if (failed || !first) {
          const started = result.spawned.map((s) => s.slug).join(', ');
          setError(`${failed || 'Nothing started.'}${started ? ` — started anyway: ${started} (on the roster).` : ''}`);
          return;
        }
        void navigate({
          to: '/observatory/$botId',
          params: { botId: 'session' },
          search: pinned ? { conv: first.conversation_id } : { conv: first.conversation_id, from: convId },
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Go failed.'))
      .finally(() => setBusy(false));
  };

  const dismiss = () => {
    setOffer(null);
    void dismissSpinoffOffer(convId).catch(() => {});
  };

  const many = offer.sessions.length > 1;
  return (
    <div className={styles.card} role="group" aria-label="Spin off">
      <div className={styles.head}>
        <span className={styles.eyebrow}>⤴ Spin off</span>
        <IconButton aria-label="Not now" onClick={dismiss} disabled={busy}>
          ×
        </IconButton>
      </div>
      <ul className={styles.list}>
        {offer.sessions.map((s) => (
          <li key={s.slug}>
            <span className={styles.title}>{s.title}</span> <code className={styles.slug}>{s.slug}</code>
          </li>
        ))}
      </ul>
      {/* After a failed Go the offer is already spent server-side, so the
          card keeps only the message and its × — a second Go would find
          nothing to start. */}
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : (
        <div className={styles.actions}>
          <span className={styles.hint}>Or just keep talking.</span>
          <Button onClick={go} disabled={busy} data-track="spinoff-go">
            {busy ? 'Starting…' : many ? `Go — start ${offer.sessions.length}` : 'Go'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CloseSourcePrompt({ convId, from }: { convId: string; from: string }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Name the chat she came from, so the question isn't about "a chat".
  useEffect(() => {
    const ac = new AbortController();
    getSessions(ac.signal)
      .then((data) => setTitle(data.sessions?.find((s) => s.id === from)?.title ?? null))
      .catch(() => {});
    return () => ac.abort();
  }, [from]);

  // Either answer drops `from` from the URL, so the question is asked once.
  const done = () =>
    void navigate({ to: '/observatory/$botId', params: { botId: 'session' }, search: { conv: convId }, replace: true });

  const close = () => {
    setBusy(true);
    closeConversation(from)
      .catch(() => {})
      .finally(done);
  };

  return (
    <div className={styles.prompt} role="group" aria-label="Close the chat you came from?">
      <span>
        Close the chat you came from{title ? <> — <b>{title}</b></> : null}?
      </span>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={done} disabled={busy}>
          Keep it
        </Button>
        <Button onClick={close} disabled={busy} data-track="spinoff-close-source">
          Close it
        </Button>
      </div>
    </div>
  );
}
