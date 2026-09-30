/**
 * SavedLane.tsx — the roster's "Saved for later" section: sessions she parked
 * to come back to, shut by default at the foot of the rooms.
 *
 * A saved session (`saved_at`, set by the Save for later button on its card —
 * SessionCard.tsx SaveLaterButton) stays open with everything it had, but asks
 * nothing of her: the server's idle check never wakes it and it never closes
 * itself (routes/observatory.py save_for_later), the room helper leaves it
 * where it is (room_helper.py), and sessionFilters.roomRoster lifts it out of
 * the rooms and the rail's counts. So this section is deliberately QUIET: no
 * orange, no "needs you" on the header, only how many are waiting. Its open
 * questions are kept, folded under each card, so they're there when she picks
 * it back up.
 *
 * Its open/shut state is remembered like a room's (LaneHead.useLaneOpen), and
 * it starts shut — out of the way is the point.
 *
 * Touches: api.ts (SessionMeta.saved_at, openQuestions), LaneHead.tsx,
 * SessionCard.tsx (SaveLaterButton), SessionLane.module.css (the card look),
 * RosterPage.tsx (where it's drawn).
 *
 * [prompt: "i'm also wanting to be able to save projects for later that the
 * system check doesn't send checks to ... i want to do it later and keep that
 * open but i don't want to look at it right now"]
 */
import { useState } from 'react';
import { openQuestions, type SessionMeta } from './api';
import { LaneHead, useLaneOpen } from './LaneHead';
import { SaveLaterButton } from './SessionCard';
import styles from './SessionLane.module.css';

/** One parked session: its name and a way in, what it was doing, its saved
 * questions folded away, and Pick back up. */
function SavedCard({
  meta,
  onOpen,
  onChanged,
}: {
  meta: SessionMeta;
  onOpen: (convId: string) => void;
  onChanged?: () => void;
}) {
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const questions = openQuestions(meta);
  const savedOn = new Date(meta.saved_at ?? '');
  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <button
          type="button"
          className={styles.open}
          onClick={() => onOpen(meta.id)}
          title="Open this session"
        >
          <span className={styles.restDot} aria-hidden="true" />
          <span className={styles.title}>{meta.title || meta.id}</span>
        </button>
      </div>
      {meta.summary ? <div className={styles.summary}>{meta.summary}</div> : null}
      {Number.isNaN(savedOn.getTime()) ? null : (
        <div className={styles.cardMeta}>
          Saved {savedOn.toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </div>
      )}
      {/* Its questions, kept for when she's back — folded, and grey rather
          than orange, because nothing is waiting on them now. */}
      {questions.length > 0 ? (
        <>
          <button
            type="button"
            className={styles.filesToggle}
            aria-expanded={questionsOpen}
            onClick={() => setQuestionsOpen((v) => !v)}
          >
            <span
              className={[styles.filesArrow, questionsOpen ? styles.filesArrowOpen : '']
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              &#9654;
            </span>
            {questions.length === 1
              ? '1 open question saved with it'
              : `${questions.length} open questions saved with it`}
          </button>
          {questionsOpen ? (
            <ol className={styles.questionList}>
              {questions.map((q, i) => (
                <li key={i} className={styles.question}>
                  {q}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
      <SaveLaterButton convId={meta.id} saved onChanged={onChanged} />
    </div>
  );
}

export function SavedLane({
  sessions,
  onOpen,
  onChanged,
}: {
  /** The saved sessions, already sorted by the page. */
  sessions: SessionMeta[];
  onOpen: (convId: string) => void;
  onChanged?: () => void;
}) {
  const [open, toggle] = useLaneOpen('saved', false);
  if (sessions.length === 0) return null;
  return (
    <section className={styles.orchestra} aria-label="Saved for later">
      <LaneHead heading="Saved for later" open={open} onToggle={toggle}>
        <span className={styles.restCount}>{sessions.length}</span>
      </LaneHead>
      {open ? (
        <>
          <p className={styles.blurb}>
            Parked until you pick them back up — still open, never checked on, never nudging.
          </p>
          <div className={styles.rows}>
            {sessions.map((s) => (
              <SavedCard key={s.id} meta={s} onOpen={onOpen} onChanged={onChanged} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
