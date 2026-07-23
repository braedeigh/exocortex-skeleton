import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { mdToHtml } from '../journal/markdown';
import { autosizeHeight } from '../phone/phoneLogic';
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
 * reply is body text. ONE programmatic scroll per turn (her new message to
 * the top of the viewport, at send); after that the scrollbar is hers,
 * unconditionally — no follow mode exists, only the one-shot ↓ latest pill.
 */
export function BotChatPage({ botId, convId }: { botId: string; convId?: string }) {
  const navigate = useNavigate();
  const [botName, setBotName] = useState(botId.charAt(0).toUpperCase() + botId.slice(1));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // The conversation this page is writing into (set by the first send's
  // 'conv' frame for fresh conversations).
  const convRef = useRef<string | undefined>(convId);

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

  // History load when opening an existing conversation.
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
        markConversationOpened(convId);
      })
      .catch(() => {
        if (!cancelled) setSendError('Could not load this conversation.');
      });
    return () => {
      cancelled = true;
    };
  }, [convId]);

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

    // The one allowed programmatic scroll: her new message to the top.
    requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const block = scroller?.querySelector(`[data-turn="${next.length - 1}"]`);
      if (scroller && block instanceof HTMLElement) {
        scroller.scrollTo({ top: block.offsetTop - 8, behavior: 'smooth' });
      }
    });

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

      {showJump ? (
        <button type="button" className={styles.jumpPill} onClick={jumpToLatest}>
          ↓ latest
        </button>
      ) : null}

      <div className={[styles.composer, offRecord ? styles.composerOff : ''].filter(Boolean).join(' ')}>
        {sendError ? <div className={styles.sendError}>{sendError}</div> : null}
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
