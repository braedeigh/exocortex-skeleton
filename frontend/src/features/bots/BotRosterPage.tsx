import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getBots, type BotInfo } from './botsApi';
import styles from './BotRosterPage.module.css';

function ago(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function openedMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem('exo-bot-opened');
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * /bots — the roster (bot-surface-design §5B, Sunflower spec): one card per
 * bot in the SessionListPage card language, past conversations as plain tap
 * rows beneath. A conversation whose last_at is newer than the last time she
 * opened it gets the unread accent (dev note ddeff5a5's "highlighted until
 * opened" want, on the surface that can actually know).
 */
export function BotRosterPage() {
  const navigate = useNavigate();
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBots()
      .then(({ bots }) => {
        if (!cancelled) setBots(bots);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const opened = openedMap();
  const isUnread = (convId: string, lastAt: string | undefined) => {
    if (!lastAt) return false;
    const seen = opened[convId];
    return !seen || Date.parse(lastAt) > Date.parse(seen);
  };

  const openConv = (botId: string, convId?: string) => {
    void navigate({
      to: '/bots/$botId',
      params: { botId },
      search: convId ? { conv: convId } : {},
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Bots</h1>
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load the roster.</div> : null}

        {bots.map((bot) => {
          const latest = bot.conversations[0];
          const unread = latest ? isUnread(latest.id, latest.last_at) : false;
          return (
            <section key={bot.id} className={styles.botSection}>
              <div
                role="button"
                tabIndex={0}
                className={[styles.card, unread ? styles.cardUnread : ''].filter(Boolean).join(' ')}
                onClick={() => openConv(bot.id, latest?.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openConv(bot.id, latest?.id);
                  }
                }}
              >
                <div className={styles.cardTop}>
                  <span className={[styles.botName, unread ? styles.botNameUnread : ''].filter(Boolean).join(' ')}>
                    {bot.name}
                    {unread ? <span className={styles.unreadDot} /> : null}
                  </span>
                  {latest ? <span className={styles.cardTime}>{ago(latest.last_at)}</span> : null}
                </div>
                <div className={styles.cardSummary}>
                  {latest ? latest.title : 'Nothing yet — tap to start.'}
                </div>
              </div>

              <button
                type="button"
                className={styles.newBtn}
                onClick={() => openConv(bot.id)}
              >
                + New conversation
              </button>

              {bot.conversations.length > 0 ? (
                <>
                  <div className={styles.sectionLabel}>Past conversations</div>
                  <div className={styles.convList}>
                    {bot.conversations.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={styles.convRow}
                        onClick={() => openConv(bot.id, c.id)}
                      >
                        <span
                          className={[styles.convTitle, isUnread(c.id, c.last_at) ? styles.convTitleUnread : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {c.title || c.id}
                        </span>
                        <span className={styles.convTime}>{ago(c.last_at)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
