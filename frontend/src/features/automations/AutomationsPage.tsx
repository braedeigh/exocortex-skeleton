import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getAutomations, toggleAutomation, type ScheduledRun } from './api';
import styles from './AutomationsPage.module.css';

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusPill(run: ScheduledRun): { label: string; cls: string } {
  if (run.last_status === 'ok') return { label: 'ok', cls: styles.pillOk };
  if (run.last_status === 'error') return { label: 'error', cls: styles.pillError };
  return { label: 'never run', cls: styles.pillMuted };
}

/**
 * /automations — the app-visible registry of recurring scheduled runs
 * (routes/automations.py). Recurring jobs (e.g. the 5 AM Morning Spark) are
 * fired by the system crontab; this page mirrors what runs, when it last
 * ran, whether it succeeded, lets her open what it produced, and pause it
 * without touching cron.
 */
export function AutomationsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refresh = () => {
    getAutomations()
      .then(({ runs }) => {
        setRuns(runs);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onToggle = (id: string) => {
    setTogglingId(id);
    toggleAutomation(id)
      .then(refresh)
      .catch(() => setFailed(true))
      .finally(() => setTogglingId(null));
  };

  const openSession = (convId: string) => {
    void navigate({ to: '/observatory/$botId', params: { botId: 'keeper' }, search: { conv: convId } });
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <h1 className={styles.title}>Automations</h1>
        </div>
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load automations.</div> : null}

        <div className={styles.list}>
          {loading ? (
            <div className={styles.emptyHint}>Loading&hellip;</div>
          ) : runs.length === 0 ? (
            <div className={styles.emptyHint}>No automations yet.</div>
          ) : (
            runs.map((run) => {
              const pill = statusPill(run);
              return (
                <div key={run.id} className={styles.card}>
                  <div
                    className={[styles.cardBody, !run.enabled ? styles.cardBodyDisabled : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div className={styles.cardTop}>
                      <span className={styles.name}>{run.name}</span>
                      <span className={[styles.pill, pill.cls].join(' ')}>{pill.label}</span>
                    </div>
                    {run.description ? <div className={styles.description}>{run.description}</div> : null}
                    <div className={styles.meta}>
                      <span>{run.schedule_human}</span>
                      <span className={styles.metaSep}>&middot;</span>
                      <span>Last run: {formatWhen(run.last_run)}</span>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={[styles.toggleBtn, run.enabled ? styles.toggleBtnOn : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onToggle(run.id)}
                      disabled={togglingId === run.id}
                      aria-pressed={run.enabled}
                    >
                      {run.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    {run.last_conv_id ? (
                      <button
                        type="button"
                        className={styles.openBtn}
                        onClick={() => openSession(run.last_conv_id as string)}
                      >
                        Open session
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
