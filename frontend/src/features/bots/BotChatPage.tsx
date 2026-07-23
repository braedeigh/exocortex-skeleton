import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { mdToHtml } from '../journal/markdown';
import { uploadTerminalPhotos } from '../phone/phoneApi';
import { autosizeHeight, uploadedPathsMessage, uploadingLabel } from '../phone/phoneLogic';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { getBots, getConversation, journalOutput, streamSend } from './botsApi';
import {
  applyEvent,
  assistantText,
  turnsFromHistory,
  userTurn,
  type Turn,
} from './botEvents';
import { applyStatsEvent, formatWorkingLine, startTurnStats, type TurnStats } from './turnStats';
import styles from './BotChatPage.module.css';

/** Mark a conversation opened (the roster's unread dot compares this
 * against the index's last_at). */
export function markConversationOpened(convId: string): void {
  try {
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

export function BotChatPage({ botId, convId }: { botId: string; convId?: string }) {
  const navigate = useNavigate();
  const [botName, setBotName] = useState(botId.charAt(0).toUpperCase() + botId.slice(1));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
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
  // paths stage as removable chips until the send folds them into the
  // message as [uploaded: …] refs the keeper can Read. The upload modal is
  // the old surface's spinner box, same colors.
  const [attached, setAttached] = useState<string[]>([]);
  const [upload, setUpload] = useState<{ label: string; error: boolean } | null>(null);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The stop button aborts this fetch; the server kills claude when the
  // stream reader goes away (routes/bots.py's finally).
  const abortRef = useRef<AbortController | null>(null);

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

  // History load when opening an existing conversation — landing at the
  // latest turn, like reopening a terminal session.
  useEffect(() => {
    convRef.current = convId;
    if (!convId) {
      setTurns([]);
      return;
    }
    let cancelled = false;
    getConversation(convId)
      .then((data) => {
        if (cancelled) return;
        setTurns(turnsFromHistory(data.events));
        setSessionJournal(data.meta?.journal === true ? true : data.meta?.journal === false ? false : null);
        markConversationOpened(convId);
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
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
  }, [convId]);

  // Her hand outranks the machine: any manual scroll input cancels both the
  // send-follow and the open-at-bottom pin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cancel = () => {
      followRef.current = false;
      pinBottomRef.current = false;
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchmove', cancel, { passive: true });
    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchmove', cancel);
    };
  }, []);

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
  }, [turns]);

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
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const jumpTo = (edge: 'top' | 'bottom') => {
    followRef.current = false; // an explicit jump outranks any follow or pin
    pinBottomRef.current = false;
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

  const send = async () => {
    const el = inputRef.current;
    const typed = el?.value.trim() ?? '';
    // Photos may go alone (refs are a message), but empty-empty is nothing.
    if (!el || (!typed && attached.length === 0) || streaming) return;
    const paths = attached;
    const text = paths.length
      ? uploadedPathsMessage(paths) + (typed ? `\n${typed}` : '')
      : typed;
    el.value = '';
    el.style.height = 'auto';
    setAttached([]);
    setSendError(null);

    const next = [...turnsRef.current, userTurn(text, offRecord)];
    setTurns(next);
    setStreaming(true);
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

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const conv = await streamSend(
        botId,
        text,
        { conversationId: convRef.current, record: !offRecord, signal: ctrl.signal },
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
            to: '/bots/$botId',
            params: { botId },
            search: { conv },
            replace: true,
          });
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        // Her stop, not a failure: the message went out and what streamed
        // stays — just close the writing turn cleanly.
        const last = turnsRef.current[turnsRef.current.length - 1];
        if (last && last.role === 'assistant') {
          last.open = false;
          last.tool = null;
        }
        setTurns([...turnsRef.current]);
      } else {
        // A failed send must not eat the message (same guarantee as the
        // terminal composer): restore the typed text AND the staged photos.
        el.value = el.value ? `${typed}\n${el.value}` : typed;
        setAttached((prev) => [...paths, ...prev]);
        setSendError(e instanceof Error ? e.message : 'Send failed — message restored.');
        setTurns(turnsRef.current.filter((t, i) => !(i === next.length - 1 && t.role === 'user')));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const stopTurn = () => abortRef.current?.abort();

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
      setAttached((prev) => [...prev, ...data.paths]);
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

  // The working line runs the whole turn — including the quiet stretch before
  // the first token, which is exactly when a loading signal matters most.
  const writing = streaming;

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
            </div>
          ) : null}
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
            {attached.map((p) => (
              <span key={p} className={styles.chip}>
                🖼 {p.split('/').pop()}
                <button
                  type="button"
                  className={styles.chipX}
                  aria-label={`Remove ${p.split('/').pop()}`}
                  onClick={() => setAttached((prev) => prev.filter((x) => x !== p))}
                >
                  ×
                </button>
              </span>
            ))}
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
            disabled={!streaming}
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
          <button
            type="button"
            className={styles.sendBtn}
            aria-label="Send"
            disabled={streaming}
            onClick={() => void send()}
          >
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
