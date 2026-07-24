import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useDismiss } from './useDismiss';
import { addScheduledJob, cancelScheduledJob, getScheduledJobs, type ScheduledJob } from './shellApi';
import styles from './SchedulePanel.module.css';

const NEW_SESSION_VALUE = '__new__';

function defaultAt(): string {
  // Tomorrow 06:00 — "running before I wake up" is the whole point
  // (mirrors split.html's _schedDefaultAt).
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(6, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function snippet(text: string): string {
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/**
 * Scheduled-prompts panel — React port of split.html's #schedPanel
 * (templates/split.html:524-539, 1175-1344). Queues a prompt to be typed into
 * a session (existing or brand new) at a future date/time; the queue itself
 * lives in scheduled_prompts.json (routes/terminal.py), fired by the
 * cron'd scripts/prompt_dispatcher.py.
 */
export function SchedulePanel({
  open,
  onClose,
  triggerRef,
  sessionNames,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  sessionNames: string[];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, panelRef, triggerRef);
  const navigate = useNavigate();

  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [sessionChoice, setSessionChoice] = useState<string>(sessionNames[0] ?? NEW_SESSION_VALUE);
  const [newSessionName, setNewSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [at, setAt] = useState(defaultAt);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadJobs = () => {
    getScheduledJobs()
      .then((data) => setJobs(data.jobs || []))
      .catch(() => {});
  };

  // Fires only on open (not on every keystroke into sessionChoice/at) — reads
  // the latest sessionNames via a ref, and uses functional state updates, so
  // this effect only needs `open` in its dependency array.
  const sessionNamesRef = useRef(sessionNames);
  sessionNamesRef.current = sessionNames;

  useEffect(() => {
    if (!open) return;
    setSessionChoice((prev) => {
      const names = sessionNamesRef.current;
      return names.includes(prev) || prev === NEW_SESSION_VALUE ? prev : (names[0] ?? NEW_SESSION_VALUE);
    });
    setAt((prev) => prev || defaultAt());
    loadJobs();
  }, [open]);

  const resolvedSession = () => {
    if (sessionChoice === NEW_SESSION_VALUE) {
      return newSessionName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30);
    }
    return sessionChoice;
  };

  const submit = async () => {
    const session = resolvedSession();
    const trimmedPrompt = prompt.trim();
    if (!session) {
      setError('Pick or name a session.');
      return;
    }
    if (!trimmedPrompt) {
      setError('Prompt cannot be empty.');
      return;
    }
    if (!at) {
      setError('Pick a date and time.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await addScheduledJob({ session, prompt: trimmedPrompt, at: at.replace('T', ' ') });
      setPrompt('');
      setAt(defaultAt());
      if (sessionChoice === NEW_SESSION_VALUE) setNewSessionName('');
      loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not schedule that.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await cancelScheduledJob(id);
      loadJobs();
    } catch {
      // best-effort — the list just won't update this round
    }
  };

  if (!open) return null;

  const pending = jobs.filter((j) => j.status === 'pending');
  const recent = jobs.filter((j) => j.status !== 'pending').slice(0, 8);

  return (
    <div className={styles.panel} ref={panelRef}>
      <div className={styles.titleRow}>
        <div className={styles.title}>&#9200; Schedule a prompt</div>
        <button
          type="button"
          className={styles.automationsBtn}
          onClick={() => {
            onClose();
            void navigate({ to: '/automations' });
          }}
        >
          Automations &#8599;
        </button>
      </div>
      <div className={styles.form}>
        <select
          className={styles.select}
          value={sessionChoice}
          onChange={(e) => setSessionChoice(e.target.value)}
        >
          {sessionNames.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          <option value={NEW_SESSION_VALUE}>+ New session…</option>
        </select>
        {sessionChoice === NEW_SESSION_VALUE && (
          <input
            type="text"
            className={styles.textInput}
            placeholder="new-session-name"
            maxLength={30}
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
            autoFocus
          />
        )}
        <textarea
          className={styles.textarea}
          rows={3}
          placeholder="What should it do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <input
          type="datetime-local"
          className={styles.dateInput}
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}
        <button type="button" className={styles.addBtn} onClick={() => void submit()} disabled={submitting}>
          Add
        </button>
      </div>
      <div className={styles.jobs}>
        {pending.length === 0 && recent.length === 0 ? (
          <div className={styles.empty}>No scheduled prompts yet.</div>
        ) : (
          <>
            {pending.length > 0 && (
              <>
                <div className={styles.sectionLabel}>Pending</div>
                {pending.map((j) => (
                  <div key={j.id} className={styles.job}>
                    <div className={styles.jobBody}>
                      <div className={styles.jobHead}>
                        {j.session} <span className={styles.jobMeta}>&middot; {j.at}</span>
                      </div>
                      <div className={styles.jobPrompt}>{snippet(j.prompt)}</div>
                    </div>
                    <button type="button" className={styles.cancelBtn} onClick={() => void cancel(j.id)}>
                      Cancel
                    </button>
                  </div>
                ))}
              </>
            )}
            {recent.length > 0 && (
              <>
                <div className={styles.sectionLabel}>Recent</div>
                {recent.map((j) => (
                  <div key={j.id} className={[styles.job, styles.jobRecent].join(' ')}>
                    <div className={styles.jobBody}>
                      <div className={styles.jobHead}>
                        {j.session} <span className={styles.jobMeta}>&middot; {j.at} &middot; {j.status}</span>
                      </div>
                      <div className={styles.jobPrompt}>{snippet(j.prompt)}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
