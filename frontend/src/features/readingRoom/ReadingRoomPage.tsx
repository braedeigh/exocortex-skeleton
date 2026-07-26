import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { autosizeHeight, uploadedPathsMessage } from '../phone/phoneLogic';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { TerrainBackdrop } from '../terrain/TerrainBackdrop';
import { createSession, getConversation, journalOutput, stopConversation, streamSend } from './api';
import { applyEvent, assistantText, lastUserTurnIndex, turnsFromHistory, userTurn, type Turn } from './events';
import { formatWorkingLine } from './turnStats';
import { isUnread, markConversationOpened } from './openedStore';
import { Reply, StreamingReply } from './replyViews';
import { useTurnStats } from './useTurnStats';
import { useWordFlow } from './useWordFlow';
import { useScrollContract } from './useScrollContract';
import { useMessageQueue } from './useMessageQueue';
import { usePhotoAttach, AttachChips, UploadOverlay } from './photoAttach';
import { useReattach } from './useReattach';
import { useKeeperRollover } from './useKeeperRollover';
import styles from './ReadingRoomPage.module.css';

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
 *
 * OPEN-AT-UNREAD ANCHOR (07-24): opening a conversation normally lands at
 * the bottom, like reopening a terminal — but if it's carrying activity she
 * hasn't seen since her last visit, that would drop her past the part she
 * hasn't read. Instead it lands with her LAST MESSAGE at the viewport top,
 * so the unread reply reads downward from there, same as a fresh reply she
 * just sent. See the history-load effect below and useScrollContract.ts's
 * pinToAnchor.
 *
 * DOCKED MODE (07-25): this page is also the desktop split's left pane (see
 * shell/KeeperPane.tsx), where there is no URL of its own to keep in step —
 * the address bar belongs to the right pane. `onOpenConversation` is that
 * seam: when it's passed, the two places this page would otherwise route
 * ("the session I just created", "the fresh Keeper the rollover woke") hand
 * the id to the pane instead, and the app's route never moves. Everything
 * else about the page is identical in both homes.
 */
export function ReadingRoomPage({
  botId,
  convId,
  onOpenConversation,
}: {
  botId: string;
  convId?: string;
  onOpenConversation?: (convId: string) => void;
}) {
  const navigate = useNavigate();
  // Sessions dissolved the "bot" persona (07-24) — there's no roster of named
  // bots to look a display name up in anymore. The header/placeholder show
  // the session's own title instead, filled in once the history load (below)
  // resolves it; a brand-new session (nothing to load yet) gets a plain
  // generic label.
  const [roomTitle, setRoomTitle] = useState('Reading room');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Messages sent while a turn is still writing — the Claude Code queued-
  // prompt gesture: they wait as removable rows and fire when the turn ends.
  // Gate for that firing: false until the history load tells us whether a
  // turn is still running server-side (fire into a busy conversation and
  // the server would refuse it).
  const [histLoaded, setHistLoaded] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The terminal's floating sidekicks, ported: 📝 dev notes and the ⏰
  // prompt timer (the same shared panels the terminal pane uses).
  const [panel, setPanel] = useState<'notes' | 'schedule' | null>(null);
  const [schedSessions, setSchedSessions] = useState<string[]>([]);
  const notesBtnRef = useRef<HTMLButtonElement>(null);
  const schedBtnRef = useRef<HTMLButtonElement>(null);
  // Explicit journal state of this session (null until meta loads; the hint
  // renders only on an explicit false — a workshop space).
  const [sessionJournal, setSessionJournal] = useState<boolean | null>(null);
  // Explicit pinned state of this session (null until meta loads) — the
  // "Roll over" control only exists in the one pinned session (the Keeper).
  const [sessionPinned, setSessionPinned] = useState<boolean | null>(null);
  // Tap-to-journal: which assistant turn is armed (tap → "✦ put this in the
  // journal" appears → tap that to mint the K card).
  const [journalArmed, setJournalArmed] = useState<number | null>(null);
  // The stop button aborts this fetch AND calls the stop endpoint — the
  // server no longer kills claude just because the stream reader went away
  // (that's the whole PWA-close fix; only /stop kills a turn).
  const abortRef = useRef<AbortController | null>(null);
  // TRUE only when she pressed stop. The unmount cleanup aborts the same
  // controller (leaving for the terminal page, closing the app) — that
  // abort must NOT stop the server-side turn; it keeps writing without us.
  const stopIntentRef = useRef(false);
  // Re-entry guard for sendMessage (belt to the auto-send effect's braces).
  const busyRef = useRef(false);
  // Lets the re-attach poll loop stop cold on unmount.
  const mountedRef = useRef(true);
  // Draft prefill fires at most once per mount — the route remounts this
  // page on every conv change (see reading-room_.$botId.tsx's `key`), so a
  // plain boolean here already can't leak a prefill across conversations;
  // it just also guards against a second history load inside the same
  // mount re-stomping something she's since edited or cleared.
  const draftAppliedRef = useRef(false);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // The conversation this page is writing into (set by the first send's
  // 'conv' frame for fresh conversations).
  const convRef = useRef<string | undefined>(convId);

  const turnStats = useTurnStats(streaming);

  const reattachApi = useReattach({
    convRef,
    mountedRef,
    onTurns: setTurns,
    // the token/thought counts died with the old stream
    onStart: turnStats.reset,
    onGiveUp: setSendError,
  });

  const writing = streaming || reattachApi.reattaching;
  const writingRef = useRef(writing);
  writingRef.current = writing;

  const wordFlow = useWordFlow(turnsRef, writingRef);
  const scrollContract = useScrollContract({
    turns,
    shownChars: wordFlow.shownChars,
    streaming,
    writing,
  });

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
        const loadedTurns = turnsFromHistory(data.events);
        setTurns(loadedTurns);
        setSessionJournal(data.meta?.journal === true ? true : data.meta?.journal === false ? false : null);
        setSessionPinned(data.meta?.pinned === true);
        if (data.meta?.title) setRoomTitle(data.meta.title);
        // Draft prefill: a staged first message she hasn't fired yet. Only
        // takes the compose box if it's still empty (never stomp something
        // she's already typed) and only once per mount (the server clears
        // the draft after a real send; re-loading history within the same
        // mount — the busyRef fast path above skips this call entirely, but
        // belt-and-suspenders — must not re-inject it).
        if (!draftAppliedRef.current && typeof data.meta?.draft === 'string' && data.meta.draft.trim()) {
          draftAppliedRef.current = true;
          const el = inputRef.current;
          if (el && !el.value.trim()) {
            el.value = data.meta.draft;
            el.style.height = 'auto';
            el.style.height = `${autosizeHeight(el.scrollHeight, 132)}px`;
          }
        }
        // Capture the stamp BEFORE it's overwritten — this open's own
        // freshness can't be judged against a mark this same open just made.
        const prevOpened = markConversationOpened(convId);
        // Reopened onto a turn that's still writing (the PWA was closed
        // mid-reply and the turn kept going) — pick it back up.
        if (data.meta?.running === true) void reattachApi.reattach(convId);
        setHistLoaded(true);
        // Open-at-unread anchor: if she left new activity unread since her
        // last visit, land with her last message at the viewport top so the
        // unread reply reads downward from there — otherwise land at the
        // latest turn, always, like reopening a terminal (the pin keeps us
        // there while the rendered markdown finishes laying out — see
        // useScrollContract.ts).
        const anchorIdx = lastUserTurnIndex(loadedTurns);
        if (isUnread(data.meta?.last_at, prevOpened)) {
          if (anchorIdx >= 0) scrollContract.pinToAnchor(anchorIdx);
          // Unread but she's never sent a message (a fresh session someone
          // else fed events into) — nothing to anchor on; the container
          // naturally starts at the top, which is the right place to start
          // catching up anyway.
        } else {
          scrollContract.pinToBottom();
        }
      })
      .catch(() => {
        // histLoaded stays false — with the conversation's state unknown,
        // a restored queue holds its fire.
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
    // reattachApi.reattach / scrollContract.pinToBottom / scrollContract.pinToAnchor
    // are stable (useCallback, [] deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, reattachApi.reattach, scrollContract.pinToBottom, scrollContract.pinToAnchor]);

  // The pause (off-record) button only exists where the journal is live —
  // in a workshop session there's nothing to pause. Clear any stale state
  // when the session turns out not to journal.
  useEffect(() => {
    if (sessionJournal !== true) setOffRecord(false);
  }, [sessionJournal]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

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
      wordFlow.begin(next.length);
      turnStats.start(Date.now());

      // No jump — start following: the reply prints below her message and
      // the page tracks it until that message reaches the top (the lock),
      // or she scrolls (the cancel). The open-at-bottom pin hands off to
      // the follow here (see useScrollContract.ts).
      scrollContract.beginFollow(next.length - 1);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      stopIntentRef.current = false;
      try {
        let conv = convRef.current;
        if (!conv) {
          // The old create-implicitly-on-send flow is gone from this
          // client (sessions carry their own config server-side now, so a
          // send needs a real id to send into) — a brand-new blank compose
          // creates its session explicitly first, titled from what she's
          // about to say, same journal-off default as the roster's own
          // '+ New session' dialog.
          const created = await createSession(text.slice(0, 40), false);
          conv = created.id;
          convRef.current = conv;
          // The URL catches up as soon as the session exists, not once the
          // reply finishes — a reload mid-turn lands back here instead of a
          // blank compose that would try to create a second session. Docked
          // in the split pane there's no URL to catch up; the pane takes the
          // id instead (same effect: a reload resolves back to this session).
          if (onOpenConversation) onOpenConversation(conv);
          else
            void navigate({
              to: '/reading-room/$botId',
              params: { botId },
              search: { conv },
              replace: true,
            });
        }
        await streamSend(
          conv,
          text,
          { record: !sendOffRecord, signal: ctrl.signal },
          (event) => {
            applyEvent(turnsRef.current, event);
            setTurns([...turnsRef.current]);
            turnStats.apply(event, Date.now());
          },
        );
        markConversationOpened(conv);
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
          await reattachApi.reattach(convRef.current);
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
    // The functions below are stable (useCallback, [] deps in their own hooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      botId,
      navigate,
      onOpenConversation,
      reattachApi.reattach,
      wordFlow.begin,
      turnStats.start,
      turnStats.apply,
      scrollContract.beginFollow,
    ],
  );

  const rollover = useKeeperRollover({ botId, pinned: sessionPinned === true, onOpenConversation });

  const photo = usePhotoAttach();

  // canFire: nothing running server-side, no turn actively streaming/
  // pacing/reattaching, and no unresolved send error — see
  // useMessageQueue.ts for why each of these gates the auto-fire.
  const canFire = histLoaded && !writing && !wordFlow.pacing && !sendError;
  const messageQueue = useMessageQueue({ botId, convId, canFire, onFire: sendMessage });

  const send = () => {
    const el = inputRef.current;
    const typed = el?.value.trim() ?? '';
    // Photos may go alone (refs are a message), but empty-empty is nothing.
    if (!el || (!typed && photo.attached.length === 0)) return;
    const paths = photo.drain();
    const text = paths.length
      ? uploadedPathsMessage(paths) + (typed ? `\n${typed}` : '')
      : typed;
    el.value = '';
    el.style.height = 'auto';
    if (writing) {
      // A turn is still going — queue this one to fire the moment it ends
      // (the Claude Code gesture). Each queued message keeps the record
      // state it was written under.
      messageQueue.enqueue(text, offRecord);
      return;
    }
    void sendMessage(text, offRecord);
  };

  const stopTurn = () => {
    // Her stop dumps the word flow's backlog — whatever streamed shows whole.
    wordFlow.flush();
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
      {/* Step 1 of the backdrop: the terrain map behind the conversation.
          The glass, the featured agent and the burning scroll are separate
          steps and land separately — see TerrainBackdrop.tsx. */}
      <TerrainBackdrop focusConv={convId} />

      <div ref={scrollContract.scrollRef} className={styles.scroll}>
        <div ref={scrollContract.columnRef} className={styles.column}>
          {turns.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyName}>{roomTitle}</div>
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
              if (wordFlow.pacing && i === wordFlow.paceIdx) {
                return (
                  <StreamingReply
                    key={i}
                    t={t}
                    shown={wordFlow.shownChars}
                    cooled={wordFlow.cooledChars}
                  />
                );
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
              {turnStats.stats ? formatWorkingLine(turnStats.stats, Date.now()) : 'still writing…'}
              {scrollContract.parkArmed ? ' · turning pages for you' : ''}
            </div>
          ) : null}
          {messageQueue.queued.map((q, i) => (
            <div key={i} className={styles.queuedRow}>
              <span className={styles.queuedTag}>queued</span>
              <span className={styles.queuedText}>{q.text}</span>
              <button
                type="button"
                className={styles.queuedX}
                aria-label="Remove queued message"
                onClick={() => messageQueue.removeAt(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Roll over — the pinned Keeper's one-tap "close the day, wake a fresh
          Keeper". Floats at the top-right of the page (her 07-24 ask) rather
          than living in the composer: it's a once-a-day, session-level act,
          not a message control, and the row it occupied down there was a row
          of height taken from the conversation. Confirm opens as a card under
          the button, so the destructive step stays anchored to what raised
          it. Still label-first, never a bare icon — it closes out a day. */}
      {sessionPinned === true ? (
        <div className={styles.rolloverFloat}>
          {rollover.phase === 'confirming' ? (
            <div className={styles.rolloverConfirmRow}>
              <span className={styles.rolloverConfirmText}>Close the day and wake a fresh Keeper?</span>
              <button
                type="button"
                className={styles.rolloverConfirmBtn}
                onClick={() => void rollover.confirm()}
              >
                Confirm
              </button>
              <button type="button" className={styles.rolloverCancelBtn} onClick={rollover.cancelConfirm}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.rolloverBtn}
              disabled={rollover.phase === 'rolling'}
              aria-busy={rollover.phase === 'rolling'}
              onClick={rollover.requestConfirm}
            >
              {rollover.phase === 'rolling' ? (
                <span className={styles.rolloverSpin} aria-hidden="true" />
              ) : (
                '\u{1F319}'
              )}
              {rollover.phase === 'rolling' ? 'Rolling over\u2026' : 'Roll over'}
            </button>
          )}
          {rollover.phase === 'error' && rollover.errorMsg ? (
            <span className={styles.rolloverError}>{rollover.errorMsg}</span>
          ) : null}
        </div>
      ) : null}

      {/* Notes + timer panels — their trigger buttons live in the composer
          toolbar now (the corner cluster folded into it, her 07-23 ask). */}
      <TermNotesPanel open={panel === 'notes'} onClose={() => setPanel(null)} triggerRef={notesBtnRef} />
      <SchedulePanel
        open={panel === 'schedule'}
        onClose={() => setPanel(null)}
        triggerRef={schedBtnRef}
        sessionNames={schedSessions}
      />

      {/* showJump alone covers a live reply scrolled out of view; catchingUp
          covers the open-at-unread anchor's idle side — a conversation
          that isn't writing at all still has an unread reply waiting below
          her anchored message, so the pill stays offered until she either
          scrolls near it herself or taps this. */}
      {scrollContract.showJump || scrollContract.catchingUp ? (
        <button type="button" className={styles.jumpPill} onClick={scrollContract.jumpToLatest}>
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
        <AttachChips attached={photo.attached} onRemove={photo.remove} />
        {/* The old bottom bar's toolbar row, same colors and placement —
            directly above the input, twilight-indigo like the terminal
            chrome. Notes/timer/jumps moved in from the corner cluster; the
            journal pause (●/◌) appears only where the journal is live. */}
        <div className={styles.toolbar}>
          <button type="button" className={styles.toolBtn} onClick={photo.openPicker}>
            photo
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to top"
            aria-label="Jump to top"
            onClick={() => scrollContract.jumpTo('top')}
          >
            &#9650;&#9650;
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="Jump to bottom"
            aria-label="Jump to bottom"
            onClick={() => scrollContract.jumpTo('bottom')}
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
            disabled={!writing && !wordFlow.pacing}
            title="Stop the reply"
            aria-label="Stop the reply"
            onClick={stopTurn}
          >
            stop
          </button>
          <input
            ref={photo.fileRef}
            type="file"
            accept="image/*"
            multiple
            tabIndex={-1}
            className={styles.fileInput}
            onChange={(e) => void photo.onPhotoChange(e.currentTarget)}
          />
        </div>
        <div className={styles.composerRow}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={`message ${roomTitle}…`}
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

      <UploadOverlay upload={photo.upload} />
    </div>
  );
}
