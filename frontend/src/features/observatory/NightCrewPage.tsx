import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { wakeSteward } from './api';
import { NightCrewLane, type NightRun } from './NightCrewLane';
import { sessionLocation } from './sessionLocation';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { ToastStack } from '../../ui';
import styles from './NightCrewPage.module.css';

/**
 * /observatory/nightcrew — the night crew's own page: everything an agent
 * finished on a branch and left waiting on her.
 *
 * WHY IT LEFT THE ROSTER (her 08-21 call: "make night crew into its own
 * separate room... i want it inside its own route inside of observatory, like
 * you scroll down and can click into it from that location"). It was the
 * tallest section on the roster and the least like the rest of it. The roster
 * is a standing-and-scanning surface — walk in, see what's yours, act. This is
 * a READING surface: work already done, read once in the morning, on cards
 * carrying screenshots, diffs, test results, costs, merge buttons and a compose
 * box. Stacking the two meant her two live rooms kept getting pushed down the
 * scroll by work that wasn't moving. Now the roster keeps a door where the
 * section was (NightCrewDoor) and the reading happens here, with room to grow.
 *
 * WHAT MOVED WITH IT. All the night state and every action on it — dismiss,
 * merge, revert, feedback, pick, wake — used to live in RosterPage and be
 * threaded down through props. They live here now, next to the only thing that
 * calls them. The roster still fetches /api/nightcrew, but only for the census
 * on its door.
 *
 * NOT POLLED, on purpose. Nothing on this page changes while she's looking at
 * it: the crew ran hours ago and nothing merges without her. A poll here would
 * be a request per tick to watch a stack that cannot move. It refetches after
 * the actions that DO change something, and merge/revert additionally schedule
 * a few delayed refetches to catch the go-live line flipping once the ~30s
 * build lands.
 *
 * Reads GET /api/nightcrew (routes/nightcrew.py). The cards themselves, and
 * every rule about what a branch card may and may not borrow, live in
 * NightCrewLane.tsx.
 */

/** What GET /api/nightcrew hands back (routes/nightcrew.py). */
export interface NightState {
  runs: NightRun[];
  queue: { id: string; tab: string; text: string }[];
  spend: { night_usd: number };
}

/** The one fetch, shared by this page and the roster's door so the two can't
 * describe different nights. */
export function fetchNightState(): Promise<NightState | null> {
  return fetch('/api/nightcrew')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

export function NightCrewPage() {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [night, setNight] = useState<NightState | null>(null);

  const loadNight = () => {
    void fetchNightState().then(setNight);
  };
  useEffect(loadNight, []);

  const dismissNightRun = (id: string) => {
    // Optimistic: the card leaves on the tap. A dismiss that can't fail in any
    // way she'd care about shouldn't make her wait for a round-trip.
    setNight((prev) =>
      prev
        ? { ...prev, runs: prev.runs.map((r) => (r.id === id ? { ...r, dismissed: true } : r)) }
        : prev,
    );
    fetch(`/api/nightcrew/runs/${id}/dismiss`, { method: 'POST' }).catch(loadNight);
  };

  /** Merge/revert are NOT optimistic — they write to her real branch and can
   * legitimately refuse (dirty tree, conflict), so the card waits for the
   * server and shows whatever it says. Resolves to an error string, or null
   * when it landed. Success also goes live in the background (~30s build +
   * reload), so a couple of delayed refreshes catch the card's go-live line
   * flipping to "live" without her mashing reload. */
  const nightAction = (id: string, verb: 'merge' | 'revert'): Promise<string | null> =>
    fetch(`/api/nightcrew/runs/${id}/${verb}`, { method: 'POST' })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok || !body?.ok) return body?.error || `Couldn't ${verb}.`;
        loadNight();
        [8000, 35000, 70000].forEach((ms) => setTimeout(loadNight, ms));
        return null;
      })
      .catch(() => "Couldn't reach the server.");

  /** Her one-line why, filed onto the run record. Fire-and-forget — losing a
   * note to a network blip isn't worth making her wait on a dismissal. */
  const feedbackNightRun = (id: string, note: string): Promise<void> =>
    fetch(`/api/nightcrew/runs/${id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })
      .then(() => undefined)
      .catch(() => undefined);

  /** Judges a picked card (pick-only mode). Reject writes the permanent
   * never-propose-again on the note, so this waits for the server. */
  const pickNightRun = (id: string, verdict: 'approve' | 'reject', note: string): Promise<string | null> =>
    fetch(`/api/nightcrew/runs/${id}/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict, note: note || undefined }),
    })
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok || !body?.ok) return body?.error || "Couldn't record that.";
        loadNight();
        return null;
      })
      .catch(() => "Couldn't reach the server.");

  /** Her reply on a finished card — wakes (or rejoins) the ONE steward for
   * that branch. Waits for the server: waking cuts a worktree and can
   * legitimately refuse (merged branch, live session), and the refusal belongs
   * on the card in the server's plain words. */
  const wakeBranchSteward = (
    branch: string,
    message: string,
  ): Promise<{ convId: string | null; error: string | null }> =>
    wakeSteward(branch, message)
      .then((body) => {
        loadNight();
        return { convId: body.conversation_id ?? null, error: null };
      })
      .catch((e: unknown) => ({
        convId: null,
        error: e instanceof Error ? e.message : "Couldn't wake it.",
      }));

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        {/* Same threshold as the archive page: the way back, then what this
            place is. One idiom for every page that hangs off the roster. */}
        <div className={styles.header}>
          <button
            type="button"
            className={styles.back}
            onClick={() => void navigate({ to: '/observatory' })}
          >
            &larr; Observatory
          </button>
          <h1 className={styles.title}>Night crew</h1>
        </div>

        <NightCrewLane
          runs={night?.runs ?? []}
          queued={night?.queue?.length ?? 0}
          spendUsd={night?.spend?.night_usd ?? 0}
          onDismiss={dismissNightRun}
          onMerge={(id) => nightAction(id, 'merge')}
          onRevert={(id) => nightAction(id, 'revert')}
          onFeedback={feedbackNightRun}
          onPick={pickNightRun}
          onWake={wakeBranchSteward}
          onOpenSession={(convId) => void navigate(sessionLocation(convId))}
        />
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {/* Its own dev-notes tab, not the roster's: notes left here are about
          this page, and filing them under "observatory" would mix them in with
          notes about the roster. */}
      <NotesPill tab="nightcrew" onError={push} />
    </div>
  );
}
