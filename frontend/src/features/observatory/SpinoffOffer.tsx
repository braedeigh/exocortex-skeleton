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
 * A spinoff plans before it builds, so the card has two shapes. In an
 * ordinary chat, Go starts a PLANNING session (it can read but not edit) and
 * "Skip the plan" starts a session that builds straight away. In a planning
 * session, the card is the plan's approval, with two buttons: "Plan mode" on
 * the left tucks the card away so she can keep correcting the plan (it comes
 * back after the agent's next reply), and "Approve plan and start building"
 * on the right starts a fresh build session on the plan and closes the
 * planning one. "View the plan" opens the exact text the builder would get.
 * `PlanSessionLink` sits at the top of that build session's chat and opens
 * the planning session it came from.
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
 *
 * Prompt (the plan step): "separate. with a UI after the plan to go. make it
 * default but with a skip the plan button. the plan session closes itself,
 * but you can click back into it at the top of the build session chat from a
 * button in the UI."
 *
 * Prompt (the approval card): "I want there to be 2 buttons: one on the left
 * with "plan mode" and one on the right with "approve plan and start
 * building" and maybe an option to view the plan"
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
  const [planOpen, setPlanOpen] = useState(false);

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
  const go = (skipPlan = false) => {
    setBusy(true);
    setError(null);
    goSpinoffOffer(convId, skipPlan)
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
          // Nothing to ask when the chat she came from can't be closed (the
          // pinned Keeper) or already was (a planning session, on approval).
          search:
            pinned || result.closed_source
              ? { conv: first.conversation_id }
              : { conv: first.conversation_id, from: convId },
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Go failed.'))
      .finally(() => setBusy(false));
  };

  const dismiss = () => {
    setOffer(null);
    void dismissSpinoffOffer(convId).catch(() => {});
  };

  // Stay in plan mode: hide the card here without withdrawing the offer. The
  // effect above reads it again when the next turn ends, so the card returns
  // after the agent's reply, carrying whatever plan is then saved.
  const keepPlanning = () => {
    setPlanOpen(false);
    setOffer(null);
  };

  const many = offer.sessions.length > 1;
  // A planning session's offer is the plan's approval card.
  const approving = offer.kind === 'build';
  return (
    <div className={styles.card} role="group" aria-label={approving ? 'Approve the plan' : 'Spin off'}>
      <div className={styles.head}>
        <span className={styles.eyebrow}>{approving ? '⤴ Plan ready' : '⤴ Spin off'}</span>
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
      {/* The plan itself, as the build session would receive it. */}
      {approving && offer.plan ? (
        <>
          <button
            type="button"
            className={styles.viewPlan}
            aria-expanded={planOpen}
            onClick={() => setPlanOpen((open) => !open)}
            data-track="spinoff-view-plan"
          >
            {planOpen ? '▾ Hide the plan' : '▸ View the plan'}
          </button>
          {planOpen ? <pre className={styles.plan}>{offer.plan}</pre> : null}
        </>
      ) : null}
      {/* After a failed Go the offer is already spent server-side, so the
          card keeps only the message and its × — a second Go would find
          nothing to start. */}
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : (
        <div className={approving ? styles.approval : styles.actions}>
          {approving ? null : (
            <span className={styles.hint}>
              Each session plans first and builds nothing until you approve. Or just keep talking.
            </span>
          )}
          {approving ? (
            <>
              <Button variant="secondary" onClick={keepPlanning} disabled={busy} data-track="spinoff-plan-mode">
                Plan mode
              </Button>
              <Button onClick={() => go()} disabled={busy} data-track="spinoff-approve-plan">
                {busy ? 'Starting…' : 'Approve plan and start building'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => go(true)} disabled={busy} data-track="spinoff-skip-plan">
                Skip the plan
              </Button>
              <Button onClick={() => go()} disabled={busy} data-track="spinoff-go">
                {busy ? 'Starting…' : many ? `Go — plan ${offer.sessions.length}` : 'Go — plan first'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The strip at the top of a build session's chat: a button back to the
 * planning session its plan was agreed in. That session is closed, so it
 * opens read-only unless she sends into it. */
export function PlanSessionLink({ plannedIn }: { plannedIn: string }) {
  const navigate = useNavigate();
  return (
    <div className={styles.prompt} role="group" aria-label="The plan this session is building">
      <span>This session is building a plan you approved.</span>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          onClick={() =>
            void navigate({ to: '/observatory/$botId', params: { botId: 'session' }, search: { conv: plannedIn } })
          }
          data-track="spinoff-open-plan-session"
        >
          Open the plan session
        </Button>
      </div>
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
