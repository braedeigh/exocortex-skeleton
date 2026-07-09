import { Checkbox, IconButton } from '../../ui';
import { formatMediaDate, mediaTypeLabel } from './mediaHelpers';
import type { MediaItem } from './types';
import styles from './MediaCard.module.css';

export interface MediaCardProps {
  item: MediaItem;
  onToggleDone: (id: string, done: boolean) => void;
  onEdit: (id: string) => void;
  onRemove: (item: MediaItem) => void;
}

/** One backlog entry — port of media.js _mediaRenderCard: checkbox, type
 * label + title + author on one wrapping line, "by X · date" meta line,
 * pre-wrapped notes, edit/remove on the right. Done items strike through
 * and fade. */
export function MediaCard({ item, onToggleDone, onEdit, onRemove }: MediaCardProps) {
  const done = !!item.done;
  const meta: string[] = [];
  if (item.recommended_by) meta.push(`by ${item.recommended_by}`);
  meta.push(formatMediaDate(item.date));

  return (
    <div className={`${styles.card} ${done ? styles.done : ''}`}>
      <div className={styles.row}>
        <Checkbox
          className={styles.check}
          checked={done}
          onChange={(e) => onToggleDone(item.id, e.target.checked)}
          title="Mark read/watched"
        />
        <div className={styles.main}>
          <div className={styles.titleLine}>
            <span className={styles.typeLabel}>{mediaTypeLabel(item.type)}</span>
            <span className={styles.title}>{item.title}</span>
            {item.author ? <span className={styles.author}>{item.author}</span> : null}
          </div>
          <div className={styles.metaLine}>{meta.join(' · ')}</div>
          {item.notes ? <div className={styles.notes}>{item.notes}</div> : null}
        </div>
        <div className={styles.actions}>
          <IconButton aria-label="Edit" title="Edit" onClick={() => onEdit(item.id)}>
            &#9998;
          </IconButton>
          <IconButton aria-label="Remove" title="Remove" onClick={() => onRemove(item)}>
            &times;
          </IconButton>
        </div>
      </div>
    </div>
  );
}
