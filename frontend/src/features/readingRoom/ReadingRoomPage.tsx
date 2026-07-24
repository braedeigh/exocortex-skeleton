import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { mdToHtml } from '../journal/markdown';
import { uploadTerminalPhotos } from '../phone/phoneApi';
import { autosizeHeight, uploadedPathsMessage, uploadingLabel } from '../phone/phoneLogic';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { getBots, getConversation, journalOutput, stopConversation, streamSend } from './api';
import {
  applyEvent,
  assistantText,
  turnsFromHistory,
  userTurn,
  type Turn,
} from './events';
import { applyStatsEvent, formatWorkingLine, startTurnStats, type TurnStats } from './turnStats';
import { PARK_BOTTOM_PX, parkStep, shouldArm } from './parkedReading';
import {
  PACE_TICK_MS,
  cooledFrontier,
  paceStep,
  pruneSamples,
  tailWords,
  type PaceSample,
  type PaceState,
} from './streamPacing';
import { loadQueued, migrateNewQueue, saveQueued, type QueuedMessage } from './queuedMessages';
import styles from './ReadingRoomPage.module.css';

/** Mark a conversation opened (the roster's unread dot compares this
 * against the index's last_at). */
export function markConversationOpened(convId: string): void {
  try {
    // 'exo-bot-opened' predates the reading-room rename (07-24) — the
    // persona concept ("bot") stays, so this on-disk/localStorage name is
    // deliberately unchanged.
    const raw = localStorage.getItem('exo-bot-opened');
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[convId] = new Date().toISOString();
    localStorage.setItem('exo-bot-opened', JSON.stringify(map));
  } catch {
    // storage disabled — unread dots just stay conservative
  }
}

/**
 * The reading room (bot-surface-design §5, Sunflower spec 07-23): not a
 * bubble chat. Her message is an epigraph — small, accent-ruled, hers; the
 * reply is body text.
 *
 * Scroll contract — FOLLOW-THEN-LOCK (her spec, 07-23): no jump on send. The
 * reply prints beneath her message and the page follows the new text like a
 * terminal — until her sent message reaches the top of the viewport, where
 * following stops dead and stays stopped; further text lands below the fold
 * for her to scroll into. A short reply never fills the screen, so the page
 * barely moves and never locks. Her own scroll (wheel/touch/keys) cancels
 * the following instantly — her hand always outranks the machine. The
 * ↓ latest pill is the only other way the page ever moves.
 *
 * Third clause — PARKED READING (her 07-23 ask, from the car): if she's been
 * sitting at the bottom for the dwell while a reply is still writing, the
 * page takes that as "I've read everything and I'm waiting" and starts
 * turning its own pages — each time a screenful of unread text pools past
 * her frontier, that frontier scrolls to the top and the new screen fills.
 * Paced page turns, not a crawl; any touch disarms it. See parkedReading.ts.
 *
 * WORD FLOW (her 07-23 ask): the wire's token bursts don't hit the page
 * raw — they pool in a backlog and release a word at a time, each word
 * fading in once (streamPacing.ts + StreamingReply below). Purely
 * presentational: turns still hold the full wire text; only the shown
 * frontier is paced. Stop dumps the backlog instantly.
 */
/** One assistant reply, memoized: a closed turn's props never change during
 * streaming, so it skips both the re-render and the markdown re-parse (the
 * useMemo) that used to run per token delta across the whole transcript. */
const Reply = memo(function Reply({
  index,
  text,
  buffer,
  open,
  tool,
  journaled,
  armed,
  onBodyTap,
  onJournalTap,
}: {
  index: number;
  text: string;
  buffer: string;
  open: boolean;
  tool: string | null;
  journaled: boolean;
  armed: boolean;
  onBodyTap: (i: number) => void;
  onJournalTap: (i: number) => void;
}) {
  const html = useMemo(
    () => mdToHtml(buffer ? (text ? `${text}\n\n${buffer}` : buffer) : text),
    [text, buffer],
  );
  return (
    <div className={styles.reply}>
      {/* Tap a finished reply to arm the journal pill; tap again to disarm. */}
      <div
        className={styles.replyBody}
        onClick={() => onBodyTap(index)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {open && tool ? <div className={styles.toolNote}>{tool}</div> : null}
      {journaled ? <div className={styles.journaledNote}>✦ in the journal</div> : null}
      {armed && !journaled && !open ? (
        <button type="button" className={styles.journalBtn} onClick={() => onJournalTap(index)}>
          ✦ put this in the journal
        </button>
      ) : null}
    </div>
  );
});

/** Within one tick's release-batch, successive LETTERS start their fades
 * this far apart — the ember front glides through words instead of hopping
 * between them. */
const LETTER_STAGGER_MS = 12;
/** Cascade cap, so a big catch-up batch doesn't trail forever. */
const STAGGER_MAX_MS = 600;

/** The turn currently being written, rendered through the word flow
 * (streamPacing.ts): only the first `shown` characters are visible.
 * Completed paragraphs settle into parsed markdown; the live tail renders
 * as word spans keyed by offset, so each word mounts exactly once. A word
 * still cooling renders its letters as individual spans, each fading in a
 * beat after the one before — letter-grain smoothness; once fully cooled
 * (behind the `cooled` frontier) it collapses to plain text, so the number
 * of live animations stays bounded no matter how long the reply gets. The
 * tail shows raw markdown until its paragraph settles — the price of spans
 * that hold still. */
function StreamingReply({ t, shown, cooled }: { t: Turn; shown: number; cooled: number }) {
  const full = assistantText(t);
  const visible = full.slice(0, Math.min(shown, full.length));
  // A paragraph settles only once every word in it has finished cooling
  // (cooled = the frontier COOL_LINGER_MS ago) — settling earlier unmounts
  // spans mid-ember and snaps them to ink. The tail may span paragraphs.
  const cut = visible.lastIndexOf('\n\n', Math.min(cooled, visible.length));
  const settled = cut > 0 ? visible.slice(0, cut) : '';
  // The paragraph break itself is neither settled nor tail — the settled
  // block's own bottom margin is the gap.
  let tailStart = cut > 0 ? cut : 0;
  while (tailStart < visible.length && visible[tailStart] === '\n') tailStart++;
  const html = useMemo(() => mdToHtml(settled), [settled]);
  const words = tailWords(visible.slice(tailStart), tailStart);
  // Each word's base delay is assigned once, at first sight — its letter
  // position in its batch, in stagger beats. Frozen in a ref so re-renders
  // can never change a mounted span's animation (a changed delay restarts
  // the fade). Letters within the word step from the base.
  const delayRef = useRef(new Map<number, number>());
  let batchLetters = 0;
  for (const w of words) {
    if (!delayRef.current.has(w.key)) {
      delayRef.current.set(w.key, Math.min(batchLetters * LETTER_STAGGER_MS, STAGGER_MAX_MS));
      batchLetters += w.text.length;
    }
  }
  return (
    <div className={styles.reply}>
      <div className={styles.replyBody}>
        {settled ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null}
        {words.length ? (
          <div className={styles.tail}>
            {words.map((w) => {
              // Fully cooled: animations are complete, so plain text renders
              // identically — and frees the letter spans.
              if (w.key + w.text.length <= cooled) {
                return <span key={w.key}>{w.text}</span>;
              }
              const base = delayRef.current.get(w.key) ?? 0;
              return (
                <span key={w.key}>
                  {[...w.text].map((ch, j) => (
                    <span
                      key={j}
                      className={styles.fadeWord}
                      style={{
                        animationDelay: `${Math.min(base + j * LETTER_STAGGER_MS, STAGGER_MAX_MS)}ms`,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      {t.tool ? <div className={styles.toolNote}>{t.tool}</div> : null}
    </div>
  );
}

export function ReadingRoomPage({ botId, convId }: { botId: string; convId?: string }) {
  const navigate = useNavigate();
  const [botName, setBotName] = useState(botId.charAt(0).toUpperCase() + botId.slice(1));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Re-attached to a turn that outlived its stream (closed PWA, dropped
  // proxy): the page polls the conversation log until the turn ends.
  const [reattaching, setReattaching] = useState(false);
  // Messages sent while a turn is still writing — the Claude Code queued-
  // prompt gesture: they wait as removable rows and fire when the turn ends.
  // Persisted per conversation (queuedMessages.ts) so closing the PWA loses
  // nothing; restored queues fire once the conversation is known idle.
  const [queued, setQueued] = useState<QueuedMessage[]>(() => loadQueued(botId, convId));
  // Gate for that firing: false until the history load tells us whether a
  // turn is still running server-side (fire into a busy conversation and
  // the server would refuse it).
  const [histLoaded, setHistLoaded] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  // The terminal's floating sidekicks, ported: 📝 dev notes and the ⏰
  // prompt timer (the same shared panels the terminal pane uses).
  const [panel, setPanel] = useState<'notes' | 'schedule' | null>(null);
  const [schedSessions, setSchedSessions] = useState<string[]>([]);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  // Explicit journal state of this session (null until meta loads; the hint
  // renders only on an explicit false — a workshop space).
  const [sessionJournal, setSessionJournal] = useState<boolean | null>(null);
  // The working line (turnStats.ts): word · elapsed · tokens · thought.
  const [stats, setStats] = useState<TurnStats | null>(null);
  const statsRef = useRef<TurnStats | null>(null);
  const [, setClockTick] = useState(0);
  // Tap-to-journal: which assistant turn is armed (tap → "✦ put this in the
  // journal" appears → tap that to mint the K card).
  const [journalArmed, setJournalArmed] = useState<number | null>(null);
  // Photo attach (the terminal toolbar's photo button, reborn): uploaded
  // paths stage as removable thumbnails until the send folds them into the
  // message as [uploaded: …] refs the keeper can Read. The thumb is a local
  // object URL over the picked File (uploads aren't served over HTTP);
  // revoked on remove/send/unmount. The upload modal is the old surface's
  // spinner box, same colors.
  const [attached, setAttached] = useState<{ path: string; thumb: string | null }[]>([]);
  const attachedRef = useRef<{ path: string; thumb: string | null }[]>([]);
  attachedRef.current = attached;
  const [upload, setUpload] = useState<{ label: string; error: boolean } | null>(null);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The stop button aborts this fetch AND calls the stop endpoint — the
  // server no longer kills claude just because the stream reader went away
  // (that's the whole PWA-close fix; only /stop kills a turn).
  const abortRef = useRef<AbortController | null>(null);
  // TRUE only when she pressed stop. The unmount cleanup aborts the same
  // controller (leaving for the terminal page, closing the app) — that
  // abort must NOT stop the server-side turn; it keeps writing without us.
  const stopIntentRef = useRef(false);
  // Word flow (streamPacing.ts): which turn is being paced, how many of its
  // characters are on screen (state — it drives the render), and the ticker's
  // carry bookkeeping (ref). Pacing outlives `streaming` briefly: the leftover
  // backlog fast-drains after the turn ends.
  const [pacing, setPacing] = useState(false);
  const [paceIdx, setPaceIdx] = useState(-1);
  const [shownChars, setShownChars] = useState(0);
  // The cooled frontier: everything behind it finished its ember fade and
  // may settle into markdown (see COOL_LINGER_MS).
  const [cooledChars, setCooledChars] = useState(0);
  const paceRef = useRef<PaceState>({ shown: 0, carry: 0 });
  const sampleRef = useRef<PaceSample[]>([]);
  // Re-entry guard for sendMessage (belt to the auto-send effect's braces).
  const busyRef = useRef(false);
  // Lets the re-attach poll loop stop cold on unmount.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // The conversation this page is writing into (set by the first send's
  // 'conv' frame for fresh conversations).
  const convRef = useRef<string | undefined>(convId);
  // Follow-then-lock state: following is on from send until her message hits
  // the viewport top (lock) or she scrolls herself (cancel).
  const followRef = useRef(false);
  const anchorIndexRef = useRef<number | null>(null);
  // Parked reading (see parkedReading.ts): armed state renders the little
  // "turning pages" note; the working parts live in refs because the ticker
  // reads them between renders.
  const [parkArmed, setParkArmed] = useState(false);
  const parkedRef = useRef(false);
  const frontierRef = useRef<number | null>(null);
  const lastFlipRef = useRef(0);
  // When she last ARRIVED at the bottom. Content growing below her doesn't
  // clear it (no scroll event fires for growth) — only her own hand does.
  const atBottomSinceRef = useRef<number | null>(null);
  // Bottom-pin on open: a conversation always opens anchored to its latest
  // output, and STAYS anchored through late layout shifts (markdown, fonts,
  // code blocks growing the page after the first snap) — until her first
  // scroll, or a send (follow-then-lock takes over from there).
  const pinBottomRef = useRef(false);

  // Bot display name for the empty state / header.
  useEffect(() => {
    let cancelled = false;
    getBots()
      .then(({ bots }) => {
        if (cancelled) return;
        const bot = bots.find((b) => b.id === botId);
        if (bot) setBotName(bot.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [botId]);

  // Re-attach to a turn that's still running server-side: poll the log every
  // couple of seconds and re-render from history (message-granular — token
  // deltas aren't logged, and that's fine for a window that just came back).
  // Ends when the index says the turn is over, she leaves the page, or ten
  // minutes pass without an ending (then it's honest about giving up).
  const reattach = useCallback(async (conv: string) => {
    setReattaching(true);
    setStats(null); // the token/thought counts died with the old stream
    statsRef.current = null;
    try {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        if (!mountedRef.current || convRef.current !== conv) return;
        try {
          const data = await getConversation(conv);
          if (!mountedRef.current || convRef.current !== conv) return;
          setTurns(turnsFromHistory(data.events));
          if (data.meta?.running !== true) return;
        } catch {
          // transient (offline, worker restart) — keep polling
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setSendError('Lost sight of the reply — it may still be finishing. Reload to check.');
    } finally {
      if (mountedRef.current) setReattaching(false);
    }
  }, []);

  // The queue's persistence (queuedMessages.ts): restore when the
  // conversation changes, persist on every change. A blank compose stages
  // under the bot's `new-` key until its conversation id exists.
  const queueConvRef = useRef(convId);
  useEffect(() => {
    const prev = queueConvRef.current;
    queueConvRef.current = convId;
    if (prev === convId) return; // mount — the useState initializer loaded
    // A fresh conversation just got its id (the post-first-turn navigate):
    // whatever was staged under `new-` belongs to it now.
    if (prev === undefined && convId) migrateNewQueue(botId, convId);
    setQueued(loadQueued(botId, convId));
  }, [botId, convId]);
  const persistConvRef = useRef(convId);
  useEffect(() => {
    // The first run after a conversation switch is the restore itself —
    // writing the outgoing queue under the incoming key would carry
    // messages between conversations.
    if (persistConvRef.current !== convId) {
      persistConvRef.current = convId;
      return;
    }
    saveQueued(botId, convId, queued);
  }, [botId, convId, queued]);

  // History load when opening an existing conversation — landing at the
  // latest turn, like reopening a terminal session.
  useEffect(() => {
    const prevConv = convRef.current;
    convRef.current = convId;
    if (!convId) {
      setTurns([]);
      setHistLoaded(true); // nothing running in a conversation that isn't
      return;
    }
    // The URL catching up to a conversation this page is already
    // mid-stream in (a blank compose's first turn just named itself, and a
    // queued message may already be running the next turn): live state is
    // fresher than the log — refetching would clobber the open turn.
    if (busyRef.current && prevConv === convId) {
      setHistLoaded(true);
      return;
    }
    setHistLoaded(false);
    let cancelled = false;
    getConversation(convId)
      .then((data) => {
        if (cancelled) return;
        setTurns(turnsFromHistory(data.events));
        setSessionJournal(data.meta?.journal === true ? true : data.meta?.journal === false ? false : null);
        markConversationOpened(convId);
        // Reopened onto a turn that's still writing (the PWA was closed
        // mid-reply and the turn kept going) — pick it back up.
        if (data.meta?.running === true) void reattach(convId);
        setHistLoaded(true);
        // Land at the latest turn, always — like reopening a terminal. The
        // pin (see the ResizeObserver below) keeps us there while the
        // rendered markdown finishes laying out.
        pinBottomRef.current = true;
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el && pinBottomRef.current) el.scrollTop = el.scrollHeight;
        });
      })
      .catch(() => {
        // histLoaded stays false — with the conversation's state unknown,
        // a restored queue holds its fire.
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
  }, [convId, reattach]);

  // Standing down the parked reader: her hand, a jump, or a new send.
  const disarmPark = useCallback(() => {
    parkedRef.current = false;
    frontierRef.current = null;
    atBottomSinceRef.current = null;
    setParkArmed(false);
  }, []);

  // Her hand outranks the machine: any manual scroll input cancels the
  // send-follow, the open-at-bottom pin, AND the parked reader.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cancel = () => {
      followRef.current = false;
      pinBottomRef.current = false;
      disarmPark();
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchmove', cancel, { passive: true });
    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchmove', cancel);
    };
  }, [disarmPark]);

  // The pin itself: while pinned, any growth of the content column re-snaps
  // the viewport to the bottom — this is what makes "opens at the bottom"
  // survive markdown/code blocks finishing their layout after the load snap.
  useEffect(() => {
    const el = scrollRef.current;
    const col = columnRef.current;
    if (!el || !col || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(col);
    return () => ro.disconnect();
  }, []);

  // The follow step, after each streamed update paints: keep the live tail
  // in view until the anchor (her sent message) reaches the viewport top —
  // then clamp there and stop for good.
  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const anchor =
      anchorIndexRef.current !== null
        ? el.querySelector(`[data-turn="${anchorIndexRef.current}"]`)
        : null;
    const bottom = el.scrollHeight - el.clientHeight;
    if (anchor instanceof HTMLElement && anchor.offsetTop <= bottom) {
      // Locking scroll position: her message at the top, done following.
      el.scrollTop = anchor.offsetTop - 8;
      followRef.current = false;
    } else {
      el.scrollTop = bottom;
    }
    // shownChars: with the word flow, the page grows on paced releases, not
    // just on turns changes — the follow has to track those too.
  }, [turns, shownChars]);

  useEffect(() => {
    if (!streaming) followRef.current = false;
  }, [streaming]);

  // The pause (off-record) button only exists where the journal is live —
  // in a workshop session there's nothing to pause. Clear any stale state
  // when the session turns out not to journal.
  useEffect(() => {
    if (sessionJournal !== true) setOffRecord(false);
  }, [sessionJournal]);

  // The working line's clock: re-render while streaming so the elapsed
  // seconds tick even when no tokens are arriving (tool time). 250ms, not
  // 1s: the display derives from Date.now() so a dropped frame self-corrects
  // instead of visibly stuttering the counter.
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [streaming]);

  useEffect(
    () => () => {
      clearTimeout(uploadTimer.current ?? undefined);
      abortRef.current?.abort();
      for (const a of attachedRef.current) if (a.thumb) URL.revokeObjectURL(a.thumb);
    },
    [],
  );

  // The ↓ latest pill: visible only while writing AND the live tail is out
  // of view. Scroll position is never touched here — display only.
  const updateJump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(fromBottom > 200);
    // Arriving at the bottom starts the parked-reading dwell clock. Never
    // cleared here: content growing below her isn't her leaving (growth
    // fires no scroll event anyway) — only her hand clears it (disarmPark).
    if (fromBottom < PARK_BOTTOM_PX && atBottomSinceRef.current === null) {
      atBottomSinceRef.current = Date.now();
    }
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateJump, { passive: true });
    return () => el.removeEventListener('scroll', updateJump);
  }, [updateJump]);
  useEffect(() => {
    if (streaming) updateJump();
    else setShowJump(false);
  }, [streaming, turns, updateJump]);

  const jumpToLatest = () => {
    disarmPark(); // landing at the bottom restarts the dwell from scratch
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const jumpTo = (edge: 'top' | 'bottom') => {
    followRef.current = false; // an explicit jump outranks any follow or pin
    pinBottomRef.current = false;
    disarmPark();
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' });
  };

  const togglePanel = (name: 'notes' | 'schedule') => {
    if (name === 'schedule' && schedSessions.length === 0) {
      // The timer schedules prompts into tmux sessions (the dispatcher's
      // delivery lane) — fetch their names once, on first open.
      fetch('/api/sessions')
        .then((r) => r.json())
        .then((d) => setSchedSessions(Array.isArray(d.sessions) ? d.sessions : []))
        .catch(() => {});
    }
    setPanel((p) => (p === name ? null : name));
  };

  const sendMessage = useCallback(
    async (text: string, sendOffRecord: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setSendError(null);

      const next = [...turnsRef.current, userTurn(text, sendOffRecord)];
      setTurns(next);
      setStreaming(true);
      // The word flow starts fresh: the reply will land at next.length and
      // release from character zero.
      setPaceIdx(next.length);
      paceRef.current = { shown: 0, carry: 0 };
      sampleRef.current = [];
      setShownChars(0);
      setCooledChars(0);
      setPacing(true);
      const startStats = startTurnStats(Date.now());
      statsRef.current = startStats;
      setStats(startStats);

      // No jump — start following: the reply prints below her message and the
      // page tracks it until that message reaches the top (the lock), or she
      // scrolls (the cancel). See the follow effect above. The open-at-bottom
      // pin hands off to the follow here.
      pinBottomRef.current = false;
      anchorIndexRef.current = next.length - 1;
      followRef.current = true;
      // A new turn starts the scroll contract over; the follow phase's trips
      // through the bottom will re-seed the parked reader's dwell clock.
      disarmPark();

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      stopIntentRef.current = false;
      try {
        const conv = await streamSend(
          botId,
          text,
          { conversationId: convRef.current, record: !sendOffRecord, signal: ctrl.signal },
          (event) => {
            applyEvent(turnsRef.current, event);
            setTurns([...turnsRef.current]);
            if (statsRef.current) {
              statsRef.current = applyStatsEvent(statsRef.current, event, Date.now());
              setStats(statsRef.current);
            }
          },
        );
        if (conv) {
          markConversationOpened(conv);
          if (!convRef.current) {
            convRef.current = conv;
            // Refresh lands back in this conversation, without a history entry
            // per turn.
            void navigate({
              to: '/reading-room/$botId',
              params: { botId },
              search: { conv },
              replace: true,
            });
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) {
          if (stopIntentRef.current) {
            // Her stop, not a failure: what streamed stays — close the
            // writing turn cleanly, and actually stop the server-side run
            // (a dead stream alone no longer stops anything).
            if (convRef.current) void stopConversation(convRef.current).catch(() => {});
            const last = turnsRef.current[turnsRef.current.length - 1];
            if (last && last.role === 'assistant') {
              last.open = false;
              last.tool = null;
            }
            setTurns([...turnsRef.current]);
          }
          // Otherwise: the page went away (another route, closed app). The
          // turn keeps writing server-side; whoever opens this conversation
          // next re-attaches to it. Nothing to do here.
        } else if (convRef.current) {
          // The turn is known server-side and keeps writing without us
          // (closed PWA, dropped proxy) — don't unsay her message; go find
          // the reply in the record instead.
          await reattach(convRef.current);
        } else {
          // Never reached the server: restore so nothing is eaten (photo
          // refs are text lines now, so they come back with the message).
          const el = inputRef.current;
          if (el) {
            el.value = el.value ? `${text}\n${el.value}` : text;
            el.style.height = 'auto';
            el.style.height = `${autosizeHeight(el.scrollHeight, 132)}px`;
          }
          setSendError(e instanceof Error ? e.message : 'Send failed — message restored.');
          setTurns(turnsRef.current.filter((t, i) => !(i === next.length - 1 && t.role === 'user')));
        }
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        setStreaming(false);
      }
    },
    [botId, navigate, reattach, disarmPark],
  );

  const writing = streaming || reattaching;
  const writingRef = useRef(writing);
  writingRef.current = writing;

  // The word-flow ticker: each tick advances the shown frontier into the
  // paced turn's text (streamPacing.ts owns the arithmetic). Keeps running
  // after the turn ends until the leftover backlog fast-drains, then stands
  // down. Missing turn (send failed, reattach reshuffled) → empty source →
  // stands down as soon as writing stops.
  useEffect(() => {
    if (!pacing) return;
    const id = setInterval(() => {
      const t = turnsRef.current[paceIdx];
      const source = t && t.role === 'assistant' ? assistantText(t) : '';
      const st = paceStep(source, paceRef.current, writingRef.current, PACE_TICK_MS);
      paceRef.current = st;
      setShownChars(st.shown);
      // Track the cooled frontier so paragraphs settle only after their
      // embers are out — and keep pacing alive past the last word until it
      // finishes cooling (unmounting early snaps it to ink).
      const now = Date.now();
      sampleRef.current = pruneSamples([...sampleRef.current, { t: now, shown: st.shown }], now);
      const cooled = cooledFrontier(sampleRef.current, now);
      setCooledChars(cooled);
      if (!writingRef.current && st.shown >= source.length && cooled >= source.length) {
        setPacing(false);
      }
    }, PACE_TICK_MS);
    return () => clearInterval(id);
  }, [pacing, paceIdx]);

  // The parked reader's ticker: 1s of granularity is plenty for arming
  // (30s dwell) and page turns (15s pacing). Runs while a turn is writing
  // (to arm) and while armed (to drain a backlog after the turn ends).
  useEffect(() => {
    if (!writing && !parkArmed) return;
    const id = setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const now = Date.now();
      if (!parkedRef.current) {
        // Pre-lock the follow already tracks the tail — nothing to park.
        if (followRef.current) return;
        if (shouldArm(atBottomSinceRef.current, writingRef.current, now)) {
          parkedRef.current = true;
          setParkArmed(true);
          // The open-at-bottom pin snaps to the tail on every growth — the
          // parked reader takes over from it (stable pages, not a crawl).
          pinBottomRef.current = false;
          // Her frontier: the bottom edge of what she's seen. The viewport
          // bottom, not the content bottom — the reply may already have
          // grown past her while she dwelled.
          frontierRef.current = el.scrollTop + el.clientHeight;
          lastFlipRef.current = 0; // the dwell was the wait; first turn owes none
        }
        return;
      }
      const frontier = frontierRef.current ?? el.scrollTop + el.clientHeight;
      const act = parkStep(
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        frontier,
        lastFlipRef.current,
        writingRef.current,
        now,
      );
      if (act.kind === 'flip') {
        el.scrollTo({ top: act.to, behavior: 'smooth' });
        frontierRef.current = act.frontier;
        lastFlipRef.current = now;
      } else if (act.kind === 'reveal' || act.kind === 'disarm') {
        if (act.kind === 'reveal') el.scrollTo({ top: act.to, behavior: 'smooth' });
        parkedRef.current = false;
        frontierRef.current = null;
        setParkArmed(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [writing, parkArmed]);

  const send = () => {
    const el = inputRef.current;
    const typed = el?.value.trim() ?? '';
    // Photos may go alone (refs are a message), but empty-empty is nothing.
    if (!el || (!typed && attached.length === 0)) return;
    const paths = attached.map((a) => a.path);
    const text = paths.length
      ? uploadedPathsMessage(paths) + (typed ? `\n${typed}` : '')
      : typed;
    el.value = '';
    el.style.height = 'auto';
    for (const a of attached) if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttached([]);
    if (writing) {
      // A turn is still going — queue this one to fire the moment it ends
      // (the Claude Code gesture). Each queued message keeps the record
      // state it was written under.
      setQueued((q) => [...q, { text, offRecord }]);
      return;
    }
    void sendMessage(text, offRecord);
  };

  // Fire the next queued message once the current turn fully ends — or, for
  // a queue restored from storage, once the history load confirms nothing is
  // running. A hard send error pauses the queue (her text is back in the
  // composer; auto-firing more into a broken pipe would just eat them too).
  useEffect(() => {
    // `pacing` too: the word flow keeps printing briefly after the turn
    // ends — let the tail finish before the next queued turn takes over.
    if (!histLoaded || writing || pacing || sendError || queued.length === 0) return;
    const [head, ...rest] = queued;
    setQueued(rest);
    void sendMessage(head.text, head.offRecord);
  }, [histLoaded, writing, pacing, sendError, queued, sendMessage]);

  const stopTurn = () => {
    // Her stop dumps the word flow's backlog — whatever streamed shows whole.
    setPacing(false);
    if (abortRef.current) {
      stopIntentRef.current = true; // this abort MEANS stop (unmount's doesn't)
      abortRef.current.abort();
    } else if (writingRef.current && convRef.current) {
      // Re-attach mode: no fetch to abort — stop the server-side turn
      // directly; the poll sees `running` clear and settles. (Not writing at
      // all → the turn already ended and only the printing lagged; flushing
      // the flow above was the whole job.)
      void stopConversation(convRef.current).catch(() => {});
    }
  };

  // Upload straight away on pick (the old surface's behavior — the wait
  // happens while she types the caption, not after she hits send), staging
  // the returned paths as chips. Files live in the transient uploads dir
  // (24h sweep); whoever consumes them moves what's worth keeping. The
  // spinner modal and its 2.2s error flash are phone.html's, verbatim.
  const onPhotoChange = async (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    clearTimeout(uploadTimer.current ?? undefined);
    setUpload({ label: uploadingLabel(files.length), error: false });
    try {
      const data = await uploadTerminalPhotos(files);
      if (!data.paths || !data.paths.length) throw new Error('no paths returned');
      // paths[] come back in send order, so paths[i] is files[i]'s new home —
      // the picked File doubles as its own thumbnail.
      setAttached((prev) => [
        ...prev,
        ...data.paths.map((p, i) => ({
          path: p,
          thumb: files[i] ? URL.createObjectURL(files[i]) : null,
        })),
      ]);
      setUpload(null);
    } catch (e) {
      setUpload({ label: `Upload failed: ${e instanceof Error ? e.message : 'unknown error'}`, error: true });
      uploadTimer.current = setTimeout(() => setUpload(null), 2200);
    }
  };

  // Stable callbacks (refs only) so the memoized Reply rows below actually
  // skip re-rendering — closed turns re-running mdToHtml on every token
  // delta was the transcript's main render cost.
  const tapReply = useCallback((i: number) => {
    const t = turnsRef.current[i];
    if (!t || t.open || t.journaled || !convRef.current) return;
    setJournalArmed((a) => (a === i ? null : i));
  }, []);

  const journalReply = useCallback(async (i: number) => {
    const conv = convRef.current;
    const t = turnsRef.current[i];
    if (!conv || !t || t.journaled) return;
    try {
      await journalOutput(conv, assistantText(t));
      t.journaled = true;
      setTurns([...turnsRef.current]);
    } catch {
      setSendError('Could not put that reply in the journal.');
    } finally {
      setJournalArmed(null);
    }
  }, []);

  return (
    <div className={styles.page}>
      <div ref={scrollRef} className={styles.scroll}>
        <div ref={columnRef} className={styles.column}>
          {turns.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyName}>{botName}</div>
              <div className={styles.emptyHint}>Whenever you&rsquo;re ready.</div>
            </div>
          ) : (
            turns.map((t, i) => {
              if (t.role === 'user') {
                return (
                  <div
                    key={i}
                    data-turn={i}
                    className={[styles.userMsg, t.offRecord ? styles.userOffRecord : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {t.text}
                  </div>
                );
              }
              if (t.role === 'gap') {
                return (
                  <div key={i} className={styles.gap}>
                    — off the record —
                  </div>
                );
              }
              if (t.role === 'error') {
                return (
                  <div key={i} className={styles.error}>
                    {t.text}
                  </div>
                );
              }
              if (pacing && i === paceIdx) {
                return <StreamingReply key={i} t={t} shown={shownChars} cooled={cooledChars} />;
              }
              return (
                <Reply
                  key={i}
                  index={i}
                  text={t.text}
                  buffer={t.buffer}
                  open={t.open}
                  tool={t.tool}
                  journaled={t.journaled}
                  armed={journalArmed === i}
                  onBodyTap={tapReply}
                  onJournalTap={journalReply}
                />
              );
            })
          )}
          {writing ? (
            <div className={styles.writing}>
              <span className={styles.writingDot} />{' '}
              {stats ? formatWorkingLine(stats, Date.now()) : 'still writing…'}
              {parkArmed ? ' · turning pages for you' : ''}
            </div>
          ) : null}
          {queued.map((q, i) => (
            <div key={i} className={styles.queuedRow}>
              <span className={styles.queuedTag}>queued</span>
              <span className={styles.queuedText}>{q.text}</span>
              <button
                type="button"
                className={styles.queuedX}
                aria-label="Remove queued message"
                onClick={() => setQueued((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Notes + timer panels — their trigger buttons live in the composer
          toolbar now (the corner cluster folded into it, her 07-23 ask). */}
      <TermNotesPanel open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />
      <SchedulePanel
        open={panel === 'schedule'}
        onClose={() => setPanel(null)}
        triggerRef={schedBtnRef}
        sessionNames={schedSessions}
      />

      {showJump ? (
        <button type="button" className={styles.jumpPill} onClick={jumpToLatest}>
          ↓ latest
        </button>
      ) : null}

      <div className={[styles.composer, offRecord ? styles.composerOff : ''].filter(Boolean).join(' ')}>
        {sendError ? <div className={styles.sendError}>{sendError}</div> : null}
        {sessionJournal === false && !offRecord ? (
          <div className={styles.offNote}>working space — not journaled</div>
        ) : null}
        {offRecord ? (
          <div className={styles.offNote}>
            off the record — not journaled, not kept (Claude&rsquo;s transcript still sees this)
          </div>
        ) : null}
        {attached.length > 0 ? (
          <div className={styles.chipsRow}>
            {attached.map((a) =>
              a.thumb ? (
                <span key={a.path} className={styles.thumb}>
                  <img src={a.thumb} alt={a.path.split('/').pop()} className={styles.thumbImg} />
                  <button
                    type="button"
                    className={styles.thumbX}
                    aria-label={`Remove ${a.path.split('/').pop()}`}
                    onClick={() =>
                      setAttached((prev) => {
                        const hit = prev.find((x) => x.path === a.path);
                        if (hit?.thumb) URL.revokeObjectURL(hit.thumb);
                        return prev.filter((x) => x.path !== a.path);
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ) : (
                <span key={a.path} className={styles.chip}>
                  🖼 {a.path.split('/').pop()}
                  <button
                    type="button"
                    className={styles.chipX}
                    aria-label={`Remove ${a.path.split('/').pop()}`}
                    onClick={() => setAttached((prev) => prev.filter((x) => x.path !== a.path))}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
          </div>
        ) : null}
        {/* The old bottom bar's toolbar row, same colors and placement —
            directly above the input, twilight-indigo like the terminal
            chrome. Notes/timer/jumps moved in from the corner cluster; the
            journal pause (●/◌) appears only where the journal is live. */}
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolBtn} onClick={() => fileRef.current?.click()}>
            photo
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to top"
            aria-label="Jump to top"
            onClick={() => jumpTo('top')}
          >
            &#9650;&#9650;
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to bottom"
            aria-label="Jump to bottom"
            onClick={() => jumpTo('bottom')}
          >
            &#9660;&#9660;
          </button>
          {sessionJournal === true ? (
            <button
              type="button"
              className={[styles.toolBtn, offRecord ? styles.toolBtnPaused : ''].filter(Boolean).join(' ')}
              title={offRecord ? 'Back on the record' : 'Go off the record'}
              aria-label={offRecord ? 'Back on the record' : 'Go off the record'}
              aria-pressed={offRecord}
              onClick={() => setOffRecord((v) => !v)}
            >
              {offRecord ? '◌' : '●'}
            </button>
          ) : null}
          <button
            ref={notesBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Dev notes"
            aria-label="Dev notes"
            onClick={() => togglePanel('notes')}
          >
            &#128221;
          </button>
          <button
            ref={schedBtnRef}
            type="button"
            className={styles.toolBtn}
            title="Schedule a prompt"
            aria-label="Schedule a prompt"
            onClick={() => togglePanel('schedule')}
          >
            &#9200;
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            // Live through the post-turn drain too: while the word flow is
            // still printing, stop skips to the end of the reply.
            disabled={!writing && !pacing}
            title="Stop the reply"
            aria-label="Stop the reply"
            onClick={stopTurn}
          >
            stop
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            className={styles.fileInput}
            onChange={(e) => void onPhotoChange(e.currentTarget)}
          />
        </div>
        <div className={styles.composerRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={`message ${botName}…`}
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = `${autosizeHeight(t.scrollHeight, 132)}px`;
            }}
          />
          {/* Never disabled while writing — a send mid-turn queues (the
              queued rows above the composer). */}
          <button type="button" className={styles.sendBtn} aria-label="Send" onClick={send}>
            ↑
          </button>
        </div>
      </div>

      {upload ? (
        <div className={styles.uploadOverlay}>
          <div className={[styles.uploadBox, upload.error ? styles.uploadError : ''].filter(Boolean).join(' ')}>
            {!upload.error && <div className={styles.spinner} />}
            <div>{upload.label}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
