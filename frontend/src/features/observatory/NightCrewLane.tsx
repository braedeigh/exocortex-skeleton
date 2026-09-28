import { useState } from 'react';
import { tabIcon, tabLabel } from '../../shell/tabs';
import { LaneHead, useLaneOpen } from './LaneHead';
import styles from './NightCrew.module.css';

/**
 * NightCrewLane — "Built for you": everything an agent has finished and left on
 * a branch, waiting on her.
 *
 * WHERE IT RENDERS. Its own page, /observatory/nightcrew (NightCrewPage.tsx),
 * not the roster — it stacked there until 08-21. The roster keeps a door in the
 * spot it used to occupy (NightCrewDoor.tsx). This component is unchanged by
 * that move and still collapses like a room, because the page holds more than
 * just this section; what changed is only which page it's a section OF.
 *
 * FINISHED-AND-WAITING, not live (Sunflower). That is what defines this room,
 * and it's a different axis from the roster's. Personal and Coding are rooms
 * for sessions that are HAPPENING, sorted by whether she's watching. Nothing
 * here is running — it's all done and holding for a verdict. That difference is
 * what eventually moved it off the roster entirely: a page you scan and a page
 * you read want different shapes. So the only hierarchy is what asks her for
 * something: `ready` floats to the top, then anything still being built, then
 * the ones that couldn't.
 *
 * WHY IT HOLDS TWO KINDS NOW. The night crew fills it while she sleeps — one
 * green-lit note per branch in a throwaway worktree, tests run, nothing merged
 * (the permission model IS that crew: it can't ask, so it's structurally
 * unable to do the thing worth asking about). But a daytime session's branch
 * sits in exactly the same state, and it was showing up nowhere while a
 * separate page answered the same question in different words. Two surfaces
 * answering "what's waiting for me?" is how a system starts disagreeing with
 * itself. One room, one question. `source` on each card says which kind it is.
 *
 * WHAT A BRANCH CARD MAY NOT BORROW. A night run carries before/after
 * screenshots, a test result and a merge button — all EARNED by being verified
 * in its worktree before the card existed. No gate has run against a bare
 * branch, so it gets none of the three: a merge button there would be one tap
 * that ships unverified work. Its evidence is what changed, plus its own
 * written account, captioned as a claim wherever it appears.
 *
 * THE CARDS SPEAK, AND REPLYING WAKES THEM (the stewards, her 08-07 ask: "I
 * want them to have all the same capacities as other sessions in the room but
 * they describe what they've done"). The face is workVoice() — first person,
 * assembled from the evidence fields, no model call. The compose box on a
 * ready card is the wake door: the first send mints ONE steward session per
 * branch, stood on that existing branch in its own worktree
 * (POST /api/branches/steward). The steward reads the record; it does not
 * remember the building — the original session stays gone by design.
 *
 * THE SCREENSHOT LEADS, THE DIFF FOLDS AWAY (Sunflower's call, confirmed with
 * her). She reads her own app, not diffs — a before/after answers "is this
 * right?" in about a second, where a diff asks a question she isn't the best
 * person in the room to answer. A card with no screenshot leads with its words
 * instead. Deference: the interface recedes so the content does the talking.
 *
 * Reads GET /api/nightcrew (routes/nightcrew.py), which joins the night runs
 * with routes/branches.py's list. Merge is the only control that reaches her
 * real branch, so it confirms first and the server refuses anything it isn't
 * sure about (dirty tree, conflict, non-ready run) — a merge failure lands
 * back on the card in plain words rather than as a git dump she'd decode.
 */

export interface NightRun {
  id: string;
  note_id?: string;
  tab?: string;
  note_text: string;
  status: 'ready' | 'working' | 'failed' | 'parked' | 'merged' | 'reverted' | 'picked';
  branch?: string;
  /** Pick-only mode: why the crew proposed this note ("newest never-answered
   * note from the last 7 days that passes the gate — #2 of 6 candidates"). The info she aims her
   * picking-policy feedback at. */
  pick_reason?: string;
  /** When the picked note was written — age is the current policy's whole
   * criterion, so the card must show it. */
  note_created?: string;
  /** The merge commit's sha — recorded at merge time; its presence is what
   * offers the Revert tap (older merges without it can't be undone here). */
  merge_commit?: string;
  /** Go-live progress, verbatim from the server: "going live — building…",
   * "live", or "stuck: …". A merge or revert isn't running code until this
   * says live. */
  live?: string;
  diff_stat?: string;
  test_tail?: string;
  shot_before?: string;
  shot_after?: string;
  cost_usd?: number;
  finished?: string;
  /** Why a failed/parked run stopped. Kept forever even after the branch is
   * swept, so the next worker on this note reads what beat the last one. */
  reason?: string;
  /** Questions the worker left when the note wasn't clear enough to act on.
   * Also written onto the note itself (`night_questions`) — she answers by
   * editing the note, which re-queues it for the next night. */
  question?: string;
  /** The worker's own session — every attempt is one. Opens from the card
   * (night sessions are excluded from the room lanes), and replying in it
   * folds her words into the dev note. */
  conv_id?: string;
  dismissed?: boolean;

  /* --- the room holds more than the night crew now ------------------------
     A daytime session's branch sits in exactly the state everything here is
     in: finished, waiting on her. `source` is what lets ONE card shape serve
     both. A night run has before/after pictures, a test result and a merge
     button — all of which it EARNED by being verified in its worktree before
     the card existed. A bare branch has had no gate run against it and must
     not borrow any of them. */
  source?: 'night' | 'branch';
  /** What a merge would take. */
  files?: string[];
  /** Files in the copy that never reached the branch — a merge would leave
   * these behind. The one thing on this card she can't learn anywhere else. */
  uncommitted?: string[];
  commits?: number;
  /** The first few commit subjects — the face's voice: what the commits say
   * is most of what's known of a branch. */
  commit_lines?: string[];
  /** A live (non-archived) session still claims this branch — builder or an
   * already-woken steward. The compose box hides behind this: a branch with
   * a living session is talked to THROUGH that session, never given a second
   * voice (git would refuse a second worktree on the branch anyway). */
  session_live?: boolean;
}

/* The card's whole visual vocabulary in one table, the way SessionLane does it
   — adding a status is a row here and a rule in the stylesheet, never another
   branch buried in the markup. */
/* The card's FACE — the work speaking in first person, assembled from the
   literal evidence fields already on the card. Deliberately NOT a model call:
   the sentence exists even for a long-dead worker, and it can only say what
   the record says (the steward honesty rail: narrate from evidence, never
   from claims). The voice changed, the layout didn't — her own words stay
   the title; this line sits under them.
   [prompt: "the card's face IS the session's opening message — the work
   speaking, rendered from literal evidence, no model call"] */
function workVoice(run: NightRun): string | null {
  if (!run.branch) return null; // nothing was built — the status line already says so
  const stat = run.diff_stat?.trim();
  if (run.source === 'branch') {
    if (run.status === 'working') return null; // someone is mid-build; their session speaks
    if (run.status === 'merged') return 'You took this — it lives in the site now.';
    const n = run.commits ?? 0;
    if (!n) return 'Nothing was ever committed to me; there is nothing here to take.';
    const built = `${n} commit${n === 1 ? '' : 's'} went into me${stat ? ` — ${stat}` : ''}.`;
    const says = run.commit_lines?.length
      ? ` My commits say: ${run.commit_lines.join(' · ')}.`
      : '';
    return `${built}${says} No test gate has run against me — this is all that is known of me.`;
  }
  // A night run's ready card: the one place a real test result exists.
  if (run.status === 'ready') {
    return `I was built overnight${stat ? ` — ${stat}` : ''}. The test line below ran against my copy — its output, not my word.`;
  }
  return null; // failed/parked speak through `reason`; merged through the live line
}

const STATUS: Record<NightRun['status'], { cls: string; dot: string; label: string }> = {
  ready: { cls: 'cardReady', dot: 'dotReady', label: 'ready for you' },
  // Only a daytime branch reaches this one: a night run is never in progress —
  // she's asleep and it's finished by the time she sees it.
  working: { cls: 'cardWorking', dot: 'dotWorking', label: 'still building' },
  failed: { cls: 'cardFailed', dot: 'dotFailed', label: "couldn't" },
  parked: { cls: 'cardParked', dot: 'dotParked', label: 'parked' },
  merged: { cls: 'cardMerged', dot: 'dotMerged', label: 'merged' },
  reverted: { cls: 'cardParked', dot: 'dotParked', label: 'reverted' },
  picked: { cls: 'cardReady', dot: 'dotReady', label: 'picked — want this?' },
};

function Card({
  run,
  onDismiss,
  onMerge,
  onRevert,
  onFeedback,
  onPick,
  onWake,
  onOpenSession,
}: {
  run: NightRun;
  onDismiss: (id: string) => void;
  onMerge: (id: string) => Promise<string | null>;
  onRevert: (id: string) => Promise<string | null>;
  /** Saves one line of her judgment onto the run record. */
  onFeedback: (id: string, note: string) => Promise<void>;
  /** Judges a picked card; resolves to an error string or null. */
  onPick: (id: string, verdict: 'approve' | 'reject', note: string) => Promise<string | null>;
  /** Her reply on a finished card — wakes (or rejoins) the steward on that
   * branch. Resolves to the session to open, or an error in her words. */
  onWake: (branch: string, message: string) => Promise<{ convId: string | null; error: string | null }>;
  onOpenSession: (convId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  // Merging writes to her real branch, so it confirms first — the same
  // two-tap shape the rest of the app uses for anything destructive.
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Revert gets its own two-tap state — sharing merge's would let one
  // armed button fire the other.
  const [revertConfirming, setRevertConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  // The learning layer: Clear/Discard opens a one-line "why?" first (Skip is
  // right there — zero cost when she has nothing to say), and picked cards
  // carry the same box beside their verdict buttons. Whatever she types
  // lands on the run record for the tune-up sitting.
  const [askingWhy, setAskingWhy] = useState(false);
  const [why, setWhy] = useState('');
  // "Not this" writes a permanent never-propose-again on the note, so it
  // arms like merge/revert do.
  const [rejectConfirming, setRejectConfirming] = useState(false);
  const s = STATUS[run.status];
  const hasShots = Boolean(run.shot_before && run.shot_after);
  const isBranch = run.source === 'branch';
  // The session's own account of what it did, pulled only when she opens it.
  // Labelled as a claim wherever it shows: a well-written explanation of
  // broken code reads exactly like a good outcome, so it never sits where a
  // test result would.
  // The steward composer. Replying is what wakes the work: the first send
  // mints a session standing on this card's branch (one per branch — the
  // server rejoins a live one instead of doubling it). Only a `ready` card
  // with a branch nobody living claims offers it: a live session is talked
  // to through its own door, and merged work has nothing left to amend.
  const [wake, setWakeText] = useState('');
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const canWake =
    run.status === 'ready' && Boolean(run.branch) && !run.session_live;

  function sendWake() {
    const text = wake.trim();
    if (!text || waking) return;
    setWaking(true);
    setWakeError(null);
    void onWake(run.branch!, text).then(({ convId, error }) => {
      setWaking(false);
      setWakeError(error);
      if (error) return; // her words stay in the box — a refusal never eats them
      setWakeText('');
      if (convId) onOpenSession(convId);
    });
  }

  function clearWithWhy(save: boolean) {
    const text = why.trim();
    setAskingWhy(false);
    if (save && text) void onFeedback(run.id, text);
    onDismiss(run.id);
  }

  function judge(verdict: 'approve' | 'reject') {
    if (verdict === 'reject' && !rejectConfirming) {
      setRejectConfirming(true);
      setTimeout(() => setRejectConfirming(false), 3000);
      return;
    }
    setRejectConfirming(false);
    onPick(run.id, verdict, why.trim()).then(setMergeError);
  }

  function merge() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    setMerging(true);
    onMerge(run.id)
      .then(setMergeError)
      .finally(() => setMerging(false));
  }

  function revert() {
    if (!revertConfirming) {
      setRevertConfirming(true);
      setTimeout(() => setRevertConfirming(false), 3000);
      return;
    }
    setRevertConfirming(false);
    setReverting(true);
    onRevert(run.id)
      .then(setMergeError)
      .finally(() => setReverting(false));
  }

  return (
    <article className={`${styles.card} ${styles[s.cls]}`}>
      <header className={styles.cardHead}>
        <span className={`${styles.dot} ${styles[s.dot]}`} aria-hidden />
        <span className={styles.status}>{s.label}</span>
      </header>

      {/* WHERE THE NOTE CAME FROM — a caption above her words, not a whisper in
          the corner. It used to sit right-aligned in the header at the 12px
          floor in --text-muted: three de-emphasis levers stacked on the one
          piece of context that makes her note parseable. A note reading "make
          this function like the other normal pages" is only legible once you
          know which page she was standing on, so the origin is a premise, not a
          footnote — it goes ABOVE the sentence it qualifies, and it says the
          page's real name (Today, not `today`) via shell/tabs.ts. */}
      <p className={styles.origin}>
        <span className={styles.originIcon} aria-hidden>
          {isBranch ? '⎇' : tabIcon(run.tab ?? '')}
        </span>
        {isBranch ? 'session branch' : tabLabel(run.tab ?? '')}
      </p>

      {/* Her own words are the title — she recognises the note before she
          recognises anything we'd write about it. */}
      <p className={styles.noteText}>{run.note_text}</p>

      {/* The work speaking for itself, from the evidence fields alone —
          see workVoice. Under her title: voice changed, layout kept. */}
      {workVoice(run) && <p className={styles.voice}>{workVoice(run)}</p>}

      {hasShots && (
        <div className={styles.shots}>
          <figure className={styles.shot}>
            <img src={run.shot_before} alt="before" loading="lazy" />
            <figcaption>before</figcaption>
          </figure>
          <figure className={styles.shot}>
            <img src={run.shot_after} alt="after" loading="lazy" />
            <figcaption>after</figcaption>
          </figure>
        </div>
      )}

      {/* Work sitting in the copy that a merge would NOT pick up. Nothing else
          in the app can tell her this, and it's the difference between "the
          session built that" and "the session built that and it's still in a
          folder nobody will look at again". */}
      {run.uncommitted && run.uncommitted.length > 0 && (
        <p className={styles.stranded}>
          {run.uncommitted.length} file{run.uncommitted.length === 1 ? '' : 's'} changed in
          its copy but never committed — merging wouldn&rsquo;t take{' '}
          {run.uncommitted.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* A failed or parked run owes her one plain sentence about what beat it.
          Anything less and the card is a shrug she has to go investigate. */}
      {run.reason && <p className={styles.reason}>{run.reason}</p>}

      {/* A picked card owes her the WHY of the pick — the policy is what her
          feedback is aimed at, so it has to be visible to be judged. */}
      {run.status === 'picked' && (
        <p className={styles.pickWhy}>
          {run.pick_reason || 'picked by the crew'}
          {run.note_created ? ` · note from ${run.note_created.slice(0, 10)}` : ''}
        </p>
      )}

      {/* The worker's questions, verbatim. They also sit on the note card in
          the panel — this copy is so the morning stack shows what's being
          asked without a trip to the notes. */}
      {run.question && <p className={styles.question}>{run.question}</p>}

      {run.diff_stat && (
        <>
          <button
            type="button"
            className={styles.diffToggle}
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            <span className={styles.chevron} data-open={showDiff || undefined}>›</span>
            {run.diff_stat}
          </button>
          {showDiff && (
            <pre className={styles.tail}>
              {/* A night run's evidence is its test output. A branch has none —
                  no gate has been run against it — so it shows the files a
                  merge would take rather than an empty box pretending to be a
                  result. */}
              {isBranch
                ? (run.files ?? []).join('\n') || 'no files'
                : run.test_tail || 'no test output recorded'}
            </pre>
          )}
        </>
      )}

      {/* Replying is what wakes it: the first send mints the steward — a
          fresh session standing on this branch in its own worktree, briefed
          with the evidence above plus her words. It reads the record; it does
          NOT remember the building (that session is gone, by design). Same
          law as the archive door: talking to it brings it back. */}
      {canWake && (
        <div className={styles.wakeRow}>
          <textarea
            className={styles.wakeInput}
            value={wake}
            rows={1}
            placeholder="Reply to wake this work…"
            onChange={(e) => setWakeText(e.target.value)}
          />
          <button
            type="button"
            className={styles.wakeSend}
            disabled={waking || !wake.trim()}
            onClick={sendWake}
          >
            {waking ? 'Waking…' : 'Send'}
          </button>
        </div>
      )}
      {wakeError && <p className={styles.mergeError}>{wakeError}</p>}

      {/* A merge that couldn't happen has to say why in her words, not git's —
          "you have uncommitted changes" is actionable, a conflict dump is not. */}
      {mergeError && <p className={styles.mergeError}>{mergeError}</p>}

      {/* Go-live progress, verbatim from the server — "merged" without this
          saying "live" means the site is still running the old build. */}
      {(run.status === 'merged' || run.status === 'reverted') && run.live && (
        <p className={run.live === 'live' ? styles.liveOk : styles.liveBusy}>
          {run.live === 'live' ? '● live' : run.live}
        </p>
      )}

      {/* The why-row: opened by Clear/Discard, and by arming "Not this" on a
          picked card. Optional by design — Skip costs nothing.

          It used to sit open on EVERY picked card. That was fine when the pile
          was short and unreadable at forty, where the page became a wall of
          identical text boxes with the cards lost between them. Now it appears
          at the moment she actually has something to say: "Not this" already
          arms before it fires, so the box opens on that first tap and her
          answer rides the second. An approval needs no explanation — a reject
          is the one that teaches the picker what she doesn't want. */}
      {(askingWhy || rejectConfirming) && (
        <div className={styles.whyRow}>
          <input
            className={styles.whyInput}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="why? (optional — helps the crew learn)"
          />
          {askingWhy && (
            <>
              <button type="button" className={styles.whySave} onClick={() => clearWithWhy(true)}>
                Save
              </button>
              <button type="button" className={styles.whySkip} onClick={() => clearWithWhy(false)}>
                Skip
              </button>
            </>
          )}
        </div>
      )}

      <footer className={styles.actions}>
        {run.status === 'picked' && (
          <>
            <button type="button" className={styles.approve} onClick={() => judge('approve')}>
              Would want this
            </button>
            <button
              type="button"
              className={rejectConfirming ? styles.rejectConfirm : styles.reject}
              onClick={() => judge('reject')}
            >
              {rejectConfirming ? 'Never propose again?' : 'Not this'}
            </button>
          </>
        )}
        {/* Merge is a NIGHT-RUN affordance and it stays one. A night run earned
            it by being verified in its own worktree before this card existed;
            no gate has been run against a bare branch, so a button here would
            be one tap that ships unverified work — worse than making her type
            it. Merging these lands with the ship-it card, where the gates run
            against the merged result. */}
        {run.status === 'ready' && !isBranch && (
          <button
            type="button"
            className={confirming ? styles.mergeConfirm : styles.merge}
            disabled={merging}
            onClick={merge}
          >
            {merging ? 'Merging…' : confirming ? 'Merge for real?' : 'Merge'}
          </button>
        )}
        {run.status === 'ready' && isBranch && run.branch && (
          <code className={styles.branchName}>{run.branch}</code>
        )}
        {run.status === 'merged' && <span className={styles.merged}>merged</span>}
        {/* The regret tap — only for merges that recorded their commit.
            Undoes exactly that merge and goes live again; the branch
            survives for another look. */}
        {run.status === 'merged' && run.merge_commit && (
          <button
            type="button"
            className={revertConfirming ? styles.revertConfirm : styles.revert}
            disabled={reverting}
            onClick={revert}
          >
            {reverting ? 'Reverting…' : revertConfirming ? 'Undo for real?' : 'Revert'}
          </button>
        )}
        {/* The worker's own session, from the card — night sessions live
            HERE, not in the room lanes. Replying in it folds into the note. */}
        {run.conv_id && (
          <button
            type="button"
            className={styles.sessionLink}
            onClick={() => onOpenSession(run.conv_id!)}
          >
            Session ↗
          </button>
        )}
        {/* Dismiss marks a night RUN record dismissed — a branch has no record
            to mark, so branch cards get no Clear (merge or delete it are the
            only exits, and neither lives in this room yet). Clear opens the
            why-row first (Save/Skip finish the dismissal); on a picked card
            the row is already there, so Clear just files whatever's typed
            and goes. */}
        {!isBranch && !askingWhy && (
          <button
            type="button"
            className={styles.dismiss}
            onClick={() =>
              run.status === 'picked' ? clearWithWhy(true) : setAskingWhy(true)
            }
          >
            {run.status === 'ready' ? 'Discard' : 'Clear'}
          </button>
        )}
        {run.cost_usd != null && (
          <span className={styles.cost}>${run.cost_usd.toFixed(2)}</span>
        )}
      </footer>
    </article>
  );
}

/** What every card needs to act. Bundled because they're threaded through two
 * layers now (lane → group → card) and seven separate props at each hop is a
 * lot of noise for something that never varies per card. */
interface CardHandlers {
  onDismiss: (id: string) => void;
  onMerge: (id: string) => Promise<string | null>;
  onRevert: (id: string) => Promise<string | null>;
  onFeedback: (id: string, note: string) => Promise<void>;
  onPick: (id: string, verdict: 'approve' | 'reject', note: string) => Promise<string | null>;
  onWake: (branch: string, message: string) => Promise<{ convId: string | null; error: string | null }>;
  onOpenSession: (convId: string) => void;
}

/* THE STACK IS SORTED INTO PILES BY WHAT IT ASKS OF HER.

   The page was one flat column of every live card. On her install that was 60
   of them — 4 pieces of finished work sitting above 40 "would you want this?"
   proposals and 16 attempts that died, all in the same card shell with no
   heading between them. The server already ordered them by urgency; nothing on
   screen said where one kind stopped and the next began, so the four cards that
   actually wanted a decision were indistinguishable from the forty that wanted
   a shrug.

   These piles are not statuses — they're QUESTIONS. "Ready for you" asks for a
   merge, "Worth building?" asks for a taste judgment, "Didn't land" asks for
   nothing at all and is there to be read. Two statuses that ask the same thing
   share a pile (failed and parked both mean it didn't happen and here's why).

   Default open follows the same rule: the piles that want something from her
   are open, the ones that are just the record are shut and say their size on
   the header. Her hand overrides either way and it's remembered (useLaneOpen).

   [prompt: "make the UI in there better to show what's going on and let me
   interact with it all better"] */
const GROUPS: {
  key: string;
  heading: string;
  statuses: NightRun['status'][];
  /** One line saying what this pile is FOR — the piles differ in what they
   * want from her, which is invisible unless it's written down. */
  blurb: string;
  defaultOpen: boolean;
  /** Warms the header when it isn't empty: this pile is waiting on her. */
  wants?: boolean;
}[] = [
  {
    key: 'ready',
    heading: 'Ready for you',
    statuses: ['ready'],
    blurb: 'Built and tested overnight, sitting on a branch. Nothing merges without you.',
    defaultOpen: true,
    wants: true,
  },
  {
    key: 'picked',
    heading: 'Worth building?',
    statuses: ['picked'],
    blurb: 'Notes the crew would take next. Nothing has been built — this is a taste call, and it teaches the picker.',
    defaultOpen: true,
  },
  {
    key: 'working',
    heading: 'Still building',
    statuses: ['working'],
    blurb: 'A session is on this right now.',
    defaultOpen: true,
  },
  {
    key: 'stalled',
    heading: 'Didn’t land',
    statuses: ['failed', 'parked'],
    blurb: 'Attempts that stopped, and what beat them. Kept so the next worker on the note reads it.',
    defaultOpen: false,
  },
  {
    key: 'done',
    heading: 'Done',
    statuses: ['merged', 'reverted'],
    blurb: 'Already taken, or taken back.',
    defaultOpen: false,
  },
];

/** How many of a pile are drawn before it offers the rest. Forty proposals in
 * one scroll is not a queue she can work — it's a wall she closes. Eight is
 * about a phone screen's worth: enough to get a run going, few enough that the
 * end of it is visible from the top. Nothing is hidden silently — the button
 * says the real number. */
const PAGE = 8;

function RunGroup({
  group,
  runs,
  handlers,
}: {
  group: (typeof GROUPS)[number];
  runs: NightRun[];
  handlers: CardHandlers;
}) {
  const [open, toggleOpen] = useLaneOpen(`nightcrew:${group.key}`, group.defaultOpen);
  const [all, setAll] = useState(false);
  const shown = all ? runs : runs.slice(0, PAGE);
  const hidden = runs.length - shown.length;

  return (
    <section className={styles.group} aria-label={group.heading}>
      <LaneHead
        heading={group.heading}
        open={open}
        onToggle={toggleOpen}
        wanting={Boolean(group.wants)}
      >
        <span className={group.wants ? styles.groupCountWants : styles.groupCount}>
          {runs.length}
        </span>
      </LaneHead>

      {open && (
        <>
          <p className={styles.blurb}>{group.blurb}</p>
          <div className={styles.rows}>
            {shown.map((run) => (
              <Card key={run.id} run={run} {...handlers} />
            ))}
          </div>
          {hidden > 0 && (
            <button type="button" className={styles.showAll} onClick={() => setAll(true)}>
              Show the other {hidden} &darr;
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The night crew's stack, sorted into piles by what each card asks of her.
 * Rendered by NightCrewPage at /observatory/nightcrew.
 *
 * The ORDER of the piles is the server's (routes/nightcrew.py sorts ready →
 * picked → working → failed → parked, newest first inside each). This only
 * draws the boundaries the sort already implies; it never re-sorts, so the two
 * can't disagree about what's most urgent.
 */
export function NightCrewLane({
  runs,
  queued,
  spendUsd,
  ...handlers
}: {
  runs: NightRun[];
  /** How many notes are green-lit and would pass the gate tonight. */
  queued: number;
  spendUsd: number;
} & CardHandlers) {
  const live = runs.filter((r) => !r.dismissed);
  const piles = GROUPS.map((group) => ({
    group,
    runs: live.filter((r) => group.statuses.includes(r.status)),
  })).filter((p) => p.runs.length > 0);

  const ready = live.filter((r) => r.status === 'ready').length;

  return (
    <>
      {/* The state of the whole page, said once at the threshold — what's
          waiting, what's queued for tonight, what last night cost. It's here
          rather than repeated per pile because it answers "was the night any
          good", which is the question she arrives with. */}
      <p className={styles.summary}>
        {live.length === 0 ? (
          <span className={styles.summaryQuiet}>Nothing waiting.</span>
        ) : (
          <>
            <strong className={ready > 0 ? styles.summaryReady : styles.summaryQuiet}>
              {ready} ready for you
            </strong>
            <span className={styles.summaryQuiet}>
              {' · '}
              {live.length} card{live.length === 1 ? '' : 's'} in all
            </span>
          </>
        )}
        <span className={styles.summaryQuiet}>
          {' · '}
          {queued > 0 ? `${queued} teed up for tonight` : 'nothing green-lit for tonight'}
        </span>
        <span className={styles.summarySpend}>${spendUsd.toFixed(2)} last night</span>
      </p>

      {piles.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden />
          {queued > 0
            ? `Nothing waiting. ${queued} note${queued === 1 ? '' : 's'} teed up for tonight.`
            : 'Nothing waiting, and nothing green-lit for tonight.'}
        </div>
      ) : (
        piles.map(({ group, runs: rows }) => (
          <RunGroup key={group.key} group={group} runs={rows} handlers={handlers} />
        ))
      )}
    </>
  );
}
