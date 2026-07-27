import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadTerminalPhotos } from '../phone/phoneApi';
import { uploadingLabel } from '../phone/phoneLogic';
import styles from './ObservatoryPage.module.css';

interface Attached {
  path: string;
  thumb: string | null;
}

/**
 * photoAttach.tsx — photo attach (the terminal toolbar's photo button,
 * reborn): uploaded paths stage as removable thumbnails until the send
 * folds them into the message as [uploaded: …] refs the keeper can Read.
 * The thumb is a local object URL over the picked File (uploads aren't
 * served over HTTP); revoked on remove/send/unmount. The upload modal is
 * the old surface's spinner box, same colors.
 */
// This hook and its two presentational components (AttachChips,
// UploadOverlay) are one tightly-coupled unit by design.
// eslint-disable-next-line react/only-export-components
export function usePhotoAttach(): {
  attached: Attached[];
  upload: { label: string; error: boolean } | null;
  fileRef: React.RefObject<HTMLInputElement | null>;
  openPicker: () => void;
  onPhotoChange: (input: HTMLInputElement) => Promise<void>;
  remove: (path: string) => void;
  drain: () => string[];
} {
  const [attached, setAttached] = useState<Attached[]>([]);
  const attachedRef = useRef<Attached[]>([]);
  attachedRef.current = attached;
  const [upload, setUpload] = useState<{ label: string; error: boolean } | null>(null);
  const uploadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      clearTimeout(uploadTimer.current ?? undefined);
      for (const a of attachedRef.current) if (a.thumb) URL.revokeObjectURL(a.thumb);
    },
    [],
  );

  const openPicker = useCallback(() => {
    fileRef.current?.click();
  }, []);

  // Upload straight away on pick (the old surface's behavior — the wait
  // happens while she types the caption, not after she hits send), staging
  // the returned paths as chips. Files live in the transient uploads dir
  // (24h sweep); whoever consumes them moves what's worth keeping. The
  // spinner modal and its 2.2s error flash are phone.html's, verbatim.
  const onPhotoChange = useCallback(async (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    clearTimeout(uploadTimer.current ?? undefined);
    setUpload({ label: uploadingLabel(files.length), error: false });
    try {
      const data = await uploadTerminalPhotos(files);
      if (!data.paths || !data.paths.length) throw new Error('no paths returned');
      // paths[] come back in send order, so paths[i] is files[i]'s new home —
      // the picked File doubles as its own thumbnail.
      setAttached((prev) => [
        ...prev,
        ...data.paths.map((p, i) => ({
          path: p,
          thumb: files[i] ? URL.createObjectURL(files[i]) : null,
        })),
      ]);
      setUpload(null);
    } catch (e) {
      setUpload({ label: `Upload failed: ${e instanceof Error ? e.message : 'unknown error'}`, error: true });
      uploadTimer.current = setTimeout(() => setUpload(null), 2200);
    }
  }, []);

  const remove = useCallback((path: string) => {
    setAttached((prev) => {
      const hit = prev.find((x) => x.path === path);
      if (hit?.thumb) URL.revokeObjectURL(hit.thumb);
      return prev.filter((x) => x.path !== path);
    });
  }, []);

  const drain = useCallback((): string[] => {
    const paths = attachedRef.current.map((a) => a.path);
    for (const a of attachedRef.current) if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttached([]);
    return paths;
  }, []);

  return { attached, upload, fileRef, openPicker, onPhotoChange, remove, drain };
}

/** The staged-photo chips row, above the composer: a picture's own thumb if
 * it has one, else a plain chip — both with a full-tap-target × to remove. */
export function AttachChips({
  attached,
  onRemove,
}: {
  attached: Attached[];
  onRemove: (path: string) => void;
}) {
  if (attached.length === 0) return null;
  return (
    <div className={styles.chipsRow}>
      {attached.map((a) =>
        a.thumb ? (
          <span key={a.path} className={styles.thumb}>
            <img src={a.thumb} alt={a.path.split('/').pop()} className={styles.thumbImg} />
            <button
              type="button"
              className={styles.thumbX}
              aria-label={`Remove ${a.path.split('/').pop()}`}
              onClick={() => onRemove(a.path)}
            >
              ×
            </button>
          </span>
        ) : (
          <span key={a.path} className={styles.chip}>
            🖼 {a.path.split('/').pop()}
            <button
              type="button"
              className={styles.chipX}
              aria-label={`Remove ${a.path.split('/').pop()}`}
              onClick={() => onRemove(a.path)}
            >
              ×
            </button>
          </span>
        ),
      )}
    </div>
  );
}

/** The upload spinner overlay — the old surface's modal, same colors. */
export function UploadOverlay({ upload }: { upload: { label: string; error: boolean } | null }) {
  if (!upload) return null;
  return (
    <div className={styles.uploadOverlay}>
      <div className={[styles.uploadBox, upload.error ? styles.uploadError : ''].filter(Boolean).join(' ')}>
        {!upload.error && <div className={styles.spinner} />}
        <div>{upload.label}</div>
      </div>
    </div>
  );
}
