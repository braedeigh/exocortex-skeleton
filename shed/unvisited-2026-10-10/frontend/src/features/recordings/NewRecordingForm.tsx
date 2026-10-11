/**
 * NewRecordingForm.tsx — the "add a recording" sheet.
 *
 * Only the title is required. Everything else — audio, transcript, date, kind,
 * tags — is optional, because the two real capture paths arrive incomplete and
 * at different times: a transcript pasted from her phone with the audio still
 * on the phone, or an audio file recorded now and transcribed later.
 *
 * The audio file is measured HERE, in the browser, before upload: the server
 * has no ffprobe, so a throwaway <audio> element is the only thing in the
 * system that can say how long the recording is.
 *
 * Talks to: api.ts (addRecording), recordingHelpers.ts (readAudioDuration,
 * formatBytes, todayStr), RecordingsPage.tsx (which mounts it).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { addRecording } from './api';
import { formatBytes, kindLabel, readAudioDuration, todayStr } from './recordingHelpers';
import styles from './RecordingsPage.module.css';

interface Props {
  kinds: string[];
  onClose: () => void;
  onCreated: () => void;
}

export function NewRecordingForm({ kinds, onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayStr());
  const [kind, setKind] = useState('voice-memo');
  const [source, setSource] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [audio, setAudio] = useState<File | null>(null);
  const [duration, setDuration] = useState('');
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  async function pickAudio(file: File | null) {
    setAudio(file);
    setDuration(file ? await readAudioDuration(file) : '');
  }

  async function submit() {
    if (!title.trim()) {
      setError('Give it a title.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await addRecording(
        { title: title.trim(), date, kind, source, notes, duration, tags },
        { audio, transcriptFile, transcriptText },
      );
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save');
      setSaving(false);
    }
  }

  return createPortal(
    <div className={styles.overlay} role="presentation" onClick={() => !saving && onClose()}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="New recording"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.sheetTitle}>New recording</h2>

        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            className={styles.input}
            value={title}
            autoFocus
            placeholder="Flex library prep training"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.label}>Date</span>
            <input className={styles.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Kind</span>
            <select className={styles.input} value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.label}>Source</span>
            <input
              className={styles.input}
              value={source}
              placeholder="iPhone Voice Memos"
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Tags</span>
            <input
              className={styles.input}
              value={tags}
              placeholder="work, training"
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Audio file (optional)</span>
          <input
            className={styles.fileInput}
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.amr"
            onChange={(e) => void pickAudio(e.target.files?.[0] ?? null)}
          />
          {audio ? (
            <span className={styles.quiet}>
              {audio.name} · {formatBytes(audio.size)}
              {duration ? ` · ${duration}` : ''}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Transcript file (optional)</span>
          <input
            className={styles.fileInput}
            type="file"
            accept=".txt,.md,.vtt,.srt,.json,.csv,text/plain"
            onChange={(e) => setTranscriptFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {!transcriptFile ? (
          <label className={styles.field}>
            <span className={styles.label}>…or paste the transcript</span>
            <textarea
              className={styles.textarea}
              rows={8}
              value={transcriptText}
              placeholder="Paste it here."
              onChange={(e) => setTranscriptText(e.target.value)}
            />
          </label>
        ) : null}

        <label className={styles.field}>
          <span className={styles.label}>Notes (optional)</span>
          <textarea
            className={styles.textarea}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.sheetButtons}>
          <button type="button" className={styles.primaryBtn} disabled={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save recording'}
          </button>
          <button type="button" className={styles.secondaryBtn} disabled={saving} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
