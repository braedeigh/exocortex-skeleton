/**
 * The photos on a journal card: a row of small square thumbnails under the
 * card's words, and a full-screen viewer that opens when one is tapped.
 *
 * The viewer shows the photo as large as the screen allows, with the Keeper's
 * description underneath when there is one. Arrows (or the keyboard's ←/→)
 * step through the card's other photos. Tapping the dark surround, the ×
 * button, or pressing Escape closes it.
 *
 * Touches: `photoRefs.ts` (the photo list and server addresses),
 * `EntryCard.tsx` (puts this under the card body), and the server's
 * `routes/photos.py` (which makes the thumbnails).
 *
 * Prompt: "shrink them as thumbnails i think, real small thumbnails, with the
 * option to click to enlarge."
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../../ui';
import type { PhotoRef } from './photoRefs';
import { photoUrls } from './photoRefs';
import styles from './CardPhotos.module.css';

export interface CardPhotosProps {
  photos: PhotoRef[];
}

export function CardPhotos({ photos }: CardPhotosProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!photos.length) return null;

  return (
    <>
      <div className={styles.strip}>
        {photos.map((photo, i) => (
          <button
            key={`${photo.name}-${i}`}
            type="button"
            className={styles.thumbButton}
            onClick={() => setOpenIndex(i)}
            aria-label={photo.caption ? `Open photo: ${photo.caption}` : 'Open photo'}
            data-track="card-photo-open"
          >
            <img className={styles.thumb} src={photoUrls(photo.name).thumb} alt={photo.caption} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {openIndex !== null ? (
        <PhotoViewer photos={photos} index={openIndex} onIndex={setOpenIndex} onClose={() => setOpenIndex(null)} />
      ) : null}
    </>
  );
}

interface PhotoViewerProps {
  photos: PhotoRef[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** One photo, full screen. Portaled onto the page body for the same reason
 * the Sheet is: a container with its own stacking would otherwise trap it. */
function PhotoViewer({ photos, index, onIndex, onClose }: PhotoViewerProps) {
  const photo = photos[index];
  const many = photos.length > 1;

  // Step to the previous/next photo, wrapping around at either end.
  function step(direction: number) {
    onIndex((index + direction + photos.length) % photos.length);
  }

  // Keyboard: Escape closes, the arrow keys step.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (many && e.key === 'ArrowLeft') onIndex((index - 1 + photos.length) % photos.length);
      else if (many && e.key === 'ArrowRight') onIndex((index + 1) % photos.length);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, many, photos.length, onIndex, onClose]);

  return createPortal(
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="Photo">
      <div className={styles.topBar} onClick={(e) => e.stopPropagation()}>
        {many ? (
          <span className={styles.count}>
            {index + 1} of {photos.length}
          </span>
        ) : (
          <span />
        )}
        <IconButton aria-label="Close photo" className={styles.close} onClick={onClose}>
          &times;
        </IconButton>
      </div>

      <img
        className={styles.full}
        src={photoUrls(photo.name).full}
        alt={photo.caption}
        onClick={(e) => e.stopPropagation()}
      />

      {photo.caption ? (
        <p className={styles.caption} onClick={(e) => e.stopPropagation()}>
          {photo.caption}
        </p>
      ) : null}

      {many ? (
        <>
          <IconButton
            aria-label="Previous photo"
            className={`${styles.nav} ${styles.navPrev}`}
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
          >
            &larr;
          </IconButton>
          <IconButton
            aria-label="Next photo"
            className={`${styles.nav} ${styles.navNext}`}
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
          >
            &rarr;
          </IconButton>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
