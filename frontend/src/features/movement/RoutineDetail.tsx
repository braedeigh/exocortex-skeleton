import { useState } from 'react';
import type { ReactNode } from 'react';
import { ytId, youtubeEmbedUrl, youtubeThumbUrl } from './movementHelpers';
import type { MovementMove, MovementRoutine } from './types';
import styles from './RoutineDetail.module.css';

export interface RoutineDetailProps {
  routine: MovementRoutine;
  editing: boolean;
  hideVideos: boolean;
  onBack: () => void;
  onToggleHideVideos: () => void;
  onEditOpen: () => void;
  /** The editor panel, rendered under the header while `editing`. */
  editor: ReactNode;
}

/**
 * Detail view — one routine drilled into, recipe-style (movement.js
 * `_movementDetail`): Back/Hide-videos/Edit header, then the moves. While
 * editing, the header keeps only Back and the editor replaces the body.
 */
export function RoutineDetail({
  routine,
  editing,
  hideVideos,
  onBack,
  onToggleHideVideos,
  onEditOpen,
  editor,
}: RoutineDetailProps) {
  const moves = routine.moves ?? [];

  return (
    <div>
      <div className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          &#8592; Back
        </button>
        {!editing ? (
          <>
            <button
              type="button"
              className={`${styles.hideBtn} ${hideVideos ? styles.hideBtnActive : ''}`}
              title={
                hideVideos
                  ? 'Show the video links again'
                  : 'Hide video links — just the routine and reps/timing'
              }
              onClick={onToggleHideVideos}
            >
              {hideVideos ? <>&#128065; Show videos</> : <>&#128683; Hide videos</>}
            </button>
            <button type="button" className={styles.editBtn} onClick={onEditOpen}>
              Edit
            </button>
          </>
        ) : null}
      </div>

      {editing ? (
        editor
      ) : (
        <>
          <div className={styles.title}>{routine.name}</div>
          {routine.note ? <div className={styles.note}>{routine.note}</div> : null}
          {moves.length ? (
            moves.map((m) => <MoveRow key={m.id} move={m} hideVideos={hideVideos} />)
          ) : (
            <div className={styles.emptyMoves}>No moves yet &mdash; tap Edit to add some.</div>
          )}
        </>
      )}
    </div>
  );
}

function MoveLabel({ move }: { move: MovementMove }) {
  const hasMeta = !!(move.dose || move.note);
  return (
    <div className={styles.label}>
      <div className={styles.moveName}>{move.name}</div>
      {hasMeta ? (
        <div className={styles.metaRow}>
          {move.dose ? <span className={styles.dosePill}>{move.dose}</span> : null}
          {move.note ? <span className={styles.moveNote}>{move.note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One move — four render shapes matching movement.js `_movementMoveRow`:
 * focus mode (no video anything), YouTube (click-to-load inline player),
 * other URL (whole row links out), or no video (quiet dashed row). */
function MoveRow({ move, hideVideos }: { move: MovementMove; hideVideos: boolean }) {
  // Lazy player: the iframe only exists after the thumbnail is tapped, so the
  // tab stays light however many videos a routine collects.
  const [playing, setPlaying] = useState(false);

  const url = (move.url ?? '').trim();

  if (hideVideos) {
    // Focus mode mid-routine: just the move, its dose/reps and cue — no
    // video thumbnail, player, or link, however the move is set up.
    return (
      <div className={styles.rowFocus}>
        <span className={styles.bullet}>&#9679;</span>
        <MoveLabel move={move} />
      </div>
    );
  }

  const videoId = ytId(url);
  if (videoId) {
    return (
      <div className={styles.moveCard}>
        <div className={styles.moveCardLabel}>
          <MoveLabel move={move} />
        </div>
        {playing ? (
          <div className={styles.thumbBox}>
            <iframe
              className={styles.player}
              src={youtubeEmbedUrl(videoId)}
              title={move.name}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : (
          <div
            className={`${styles.thumbBox} ${styles.thumbClickable}`}
            role="button"
            tabIndex={0}
            aria-label={`Play video: ${move.name}`}
            onClick={() => setPlaying(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setPlaying(true);
              }
            }}
          >
            <img className={styles.thumbImg} src={youtubeThumbUrl(videoId)} loading="lazy" alt="" />
            <span className={styles.playOverlay}>&#9654;</span>
          </div>
        )}
        <a className={styles.ytLink} href={url} target="_blank" rel="noopener noreferrer">
          Open on YouTube &#8599;
        </a>
      </div>
    );
  }

  if (url) {
    // Non-YouTube URL — whole row is a link that opens in a new tab.
    return (
      <a className={styles.rowLink} href={url} target="_blank" rel="noopener noreferrer">
        <span className={styles.playCircle}>&#9654;</span>
        <MoveLabel move={move} />
        <span className={styles.linkTag}>video &#8599;</span>
      </a>
    );
  }

  // No video — a quiet, non-clickable row.
  return (
    <div className={styles.rowQuiet}>
      <span className={styles.bullet}>&#9679;</span>
      <MoveLabel move={move} />
    </div>
  );
}
