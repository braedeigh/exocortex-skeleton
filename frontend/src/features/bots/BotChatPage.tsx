import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { mdToHtml } from '../journal/markdown';
import { autosizeHeight } from '../phone/phoneLogic';
import { TermNotesPanel } from '../../shell/TermNotesPanel';
import { SchedulePanel } from '../../shell/SchedulePanel';
import { getBots, getConversation, streamSend } from './botsApi';
import {
  applyEvent,
  assistantText,
  turnsFromHistory,
  userTurn,
  type Turn,
} from './botEvents';
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

  const scrollRef = useRef<HTMLDivElement>(null);
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
        // Land at the latest turn, always — like reopening a terminal.
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch(() => {
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
  }, [convId]);

  // Her hand outranks the machine: any manual scroll input cancels following.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cancel = () => {
      followRef.current = false;
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchmove', cancel, { passive: true });
    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchmove', cancel);
    };
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
    followRef.current = false; // an explicit jump outranks any follow
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
    const text = el?.value.trim();
    if (!el || !text || streaming) return;
    el.value = '';
    el.style.height = 'auto';
    setSendError(null);

    const next = [...turnsRef.current, userTurn(text, offRecord)];
    setTurns(next);
    setStreaming(true);

    // No jump — start following: the reply prints below her message and the
    // page tracks it until that message reaches the top (the lock), or she
    // scrolls (the cancel). See the follow effect above.
    anchorIndexRef.current = next.length - 1;
    followRef.current = true;

    try {
      const conv = await streamSend(
        botId,
        text,
        { conversationId: convRef.current, record: !offRecord },
        (event) => {
          applyEvent(turnsRef.current, event);
          setTurns([...turnsRef.current]);
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
      // A failed send must not eat the message (same guarantee as the
      // terminal composer): restore it ahead of anything typed mid-flight.
      el.value = el.value ? `${text}\n${el.value}` : text;
      setSendError(e instanceof Error ? e.message : 'Send failed — message restored.');
      setTurns(turnsRef.current.filter((t, i) => !(i === next.length - 1 && t.role === 'user')));
    } finally {
      setStreaming(false);
    }
  };

  const last = turns[turns.length - 1];
  const writing = streaming && !!last && last.role === 'assistant';

  return (
    <div className={styles.page}>
      <div ref={scrollRef} className={styles.scroll}>
        <div className={styles.column}>
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
                <div key={i} className={styles.reply}>
                  <div
                    className={styles.replyBody}
                    dangerouslySetInnerHTML={{ __html: mdToHtml(assistantText(t)) }}
                  />
                  {t.open && t.tool ? <div className={styles.toolNote}>{t.tool}</div> : null}
                </div>
              );
            })
          )}
          {writing ? (
            <div className={styles.writing}>
              <span className={styles.writingDot} /> still writing…
            </div>
          ) : null}
        </div>
      </div>

      {/* The terminal's floating sidekicks, at home here too: notes, timer,
          and the jump buttons (dev note 647ff100's cousins). */}
      <div className={styles.cornerCluster}>
        <button
          ref={notesBtnRef}
          type="button"
          className={styles.cornerBtn}
          title="Dev notes"
          aria-label="Dev notes"
          onClick={() => togglePanel('notes')}
        >
          &#128221;
        </button>
        <button
          ref={schedBtnRef}
          type="button"
          className={styles.cornerBtn}
          title="Schedule a prompt"
          aria-label="Schedule a prompt"
          onClick={() => togglePanel('schedule')}
        >
          &#9200;
        </button>
        <button
          type="button"
          className={styles.cornerBtn}
          title="Jump to top"
          aria-label="Jump to top"
          onClick={() => jumpTo('top')}
        >
          &#9650;&#9650;
        </button>
        <button
          type="button"
          className={styles.cornerBtn}
          title="Jump to bottom"
          aria-label="Jump to bottom"
          onClick={() => jumpTo('bottom')}
        >
          &#9660;&#9660;
        </button>
      </div>
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
        <div className={styles.composerRow}>
          <button
            type="button"
            className={[styles.offBtn, offRecord ? styles.offBtnActive : ''].filter(Boolean).join(' ')}
            title={offRecord ? 'Back on the record' : 'Go off the record'}
            aria-label={offRecord ? 'Back on the record' : 'Go off the record'}
            aria-pressed={offRecord}
            onClick={() => setOffRecord((v) => !v)}
          >
            {offRecord ? '◌' : '●'}
          </button>
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
    </div>
  );
}
