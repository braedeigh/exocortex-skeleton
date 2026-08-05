/**
 * RecordingCard.tsx — one recording, closed or open.
 *
 * Closed it's a title line, a date, and what's attached. Open it fetches the
 * full transcript (which the list response deliberately doesn't carry) and
 * shows the player above the text, because the two get used together: she
 * scrubs the audio to check a passage the transcript garbled.
 *
 * The card owns its own transcript fetch rather than the page pre-loading all
 * of them — that's the whole reason for the metadata/bulk split on the server.
 *
 * Talks to: api.ts (getRecording, the attach/remove calls), recordingHelpers.ts
 * (all the formatting), RecordingsPage.tsx (which owns the list and the reload).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachAudio,
  attachTranscriptFile,
  audioUrl,
  getRecording,
  removeAudio,
  removeRecording,
  updateRecording,
} from './api';
import {
  attachmentSummary,
  formatBytes,
  formatRecordingDate,
  kindLabel,
  readAudioDuration,
} from './recordingHelpers';
import { ConfirmModal } from '../media/ConfirmModal';
import type { Recording } from './types';
import styles from './RecordingsPage.module.css';

interface Props {
  recording: Recording;
  /** Open on mount — how a search hit jumps straight into the transcript. */
  initialOpen?: boolean;
  /** Scroll this text into view in the transcript once it loads. */
  highlight?: string;
  onChanged: () => void;
}

export function RecordingCard({ recording, initialOpen = false, highlight, onChanged }: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const rec = recording;

  // The full text arrives only when the card is actually opened — one fetch per
  // recording being read, never 40 of them to render a list.
  useEffect(() => {
    if (!open || text !== null || loading) return;
    if (!rec.transcript) {
      setText('');
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    getRecording(rec.id, ac.signal)
      .then((body) => setText(body.recording.transcript_text ?? ''))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load transcript');
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [open, text, loading, rec.id, rec.transcript]);

  // A search hit opens the card and names the phrase it matched; find it in the
  // rendered text and put it on screen, rather than dropping her at the top of
  // a 40,000-word transcript.
  useEffect(() => {
    if (!highlight || text === null) return;
    const el = bodyRef.current?.querySelector('mark');
    el?.scrollIntoView({ block: 'center' });
  }, [highlight, text]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      setError('');
      try {
        await fn();
        setText(null); // force a re-fetch: the transcript may have changed
        onChanged();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        setBusy('');
      }
    },
    [onChanged],
  );

  async function onAudioPicked(file: File) {
    const duration = await readAudioDuration(file);
    await run('audio', async () => {
      await attachAudio(rec.id, file);
      // The browser is the only thing here that can measure the file, so the
      // duration is sent as a separate patch after the upload lands.
      if (duration) await updateRecording(rec.id, { duration });
    });
  }

  return (
    <article className={styles.card}>
      <button
        type="button"
        className={styles.cardHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={styles.cardTitle}>{rec.title}</span>
        {rec.kind ? <span className={styles.kindBadge}>{kindLabel(rec.kind)}</span> : null}
      </button>

      <div className={styles.cardMeta}>
        <span>{formatRecordingDate(rec.date)}</span>
        <span className={styles.dot}>·</span>
        <span>{attachmentSummary(rec)}</span>
      </div>

      {rec.tags?.length ? (
        <div className={styles.tagRow}>
          {rec.tags.map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className={styles.cardBody}>
          {error ? <p className={styles.error}>{error}</p> : null}

          {rec.audio ? (
            <div className={styles.player}>
              {/* Native controls on purpose: the OS player is the one thing on
                  this page that already works with a locked screen, AirPods,
                  and the system scrubber. A custom one would lose all three. */}
              <audio className={styles.audio} controls preload="metadata" src={audioUrl(rec.audio.filename)} />
              <div className={styles.playerMeta}>
                <span>
                  {rec.audio.original_name || rec.audio.filename} · {formatBytes(rec.audio.bytes)}
                </span>
                <button
                  type="button"
                  className={styles.linkBtn}
                  disabled={!!busy}
                  onClick={() => run('audio', () => removeAudio(rec.id))}
                >
                  Remove audio
                </button>
              </div>
            </div>
          ) : (
            <label className={styles.dropSlot}>
              <input
                type="file"
                accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.amr"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onAudioPicked(f);
                  e.target.value = '';
                }}
              />
              <span>{busy === 'audio' ? 'Uploading…' : '＋ Add the audio file'}</span>
            </label>
          )}

          {rec.notes ? <p className={styles.notes}>{rec.notes}</p> : null}

          <div className={styles.transcriptHead}>
            <h3 className={styles.transcriptTitle}>Transcript</h3>
            {rec.transcript ? (
              <span className={styles.quiet}>
                {rec.transcript.words?.toLocaleString() ?? '—'} words
              </span>
            ) : null}
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setEditing((v) => !v)}
              disabled={loading}
            >
              {editing ? 'Done' : rec.transcript ? 'Edit' : 'Paste one'}
            </button>
          </div>

          {loading ? <p className={styles.quiet}>Loading transcript…</p> : null}

          {!loading && editing ? (
            <TranscriptEditor
              initial={text ?? ''}
              busy={!!busy}
              onSave={async (next) => {
                await run('transcript', () => updateRecording(rec.id, { transcript_text: next }));
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : null}

          {!loading && !editing && rec.transcript ? (
            <div className={styles.transcript} ref={bodyRef}>
              {renderTranscript(text ?? '', highlight)}
            </div>
          ) : null}

          {!loading && !editing && !rec.transcript ? (
            <label className={styles.dropSlot}>
              <input
                type="file"
                accept=".txt,.md,.vtt,.srt,.json,.csv,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run('transcript', () => attachTranscriptFile(rec.id, f));
                  e.target.value = '';
                }}
              />
              <span>{busy === 'transcript' ? 'Uploading…' : '＋ Upload a transcript file'}</span>
            </label>
          ) : null}

          <div className={styles.cardFooter}>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => setConfirming(true)}
              disabled={!!busy}
            >
              Delete recording
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void run('delete', () => removeRecording(rec.id));
        }}
      >
        Delete <b>{rec.title}</b> — the audio and the transcript both? This can&apos;t be undone.
      </ConfirmModal>
    </article>
  );
}

/**
 * Split the transcript into paragraphs, marking the searched phrase.
 *
 * Done with string splitting, never `innerHTML`: a transcript is arbitrary text
 * she didn't write, and the one thing it must never do is execute.
 */
function renderTranscript(text: string, highlight?: string) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const needle = highlight?.trim().toLowerCase();

  return paragraphs.map((para, i) => {
    if (!needle) return <p key={i}>{para}</p>;
    const parts: React.ReactNode[] = [];
    let rest = para;
    let key = 0;
    for (;;) {
      const at = rest.toLowerCase().indexOf(needle);
      if (at === -1) break;
      if (at > 0) parts.push(rest.slice(0, at));
      parts.push(<mark key={`m${key++}`}>{rest.slice(at, at + needle.length)}</mark>);
      rest = rest.slice(at + needle.length);
    }
    parts.push(rest);
    return <p key={i}>{parts}</p>;
  });
}

function TranscriptEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  onSave: (text: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className={styles.editor}>
      <textarea
        className={styles.textarea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
        placeholder="Paste the transcript here…"
      />
      <div className={styles.editorRow}>
        <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void onSave(draft)}>
          {busy ? 'Saving…' : 'Save transcript'}
        </button>
        <button type="button" className={styles.linkBtn} onClick={onCancel}>
          Cancel
        </button>
        <span className={styles.quiet}>Saving an empty box clears the transcript.</span>
      </div>
    </div>
  );
}
