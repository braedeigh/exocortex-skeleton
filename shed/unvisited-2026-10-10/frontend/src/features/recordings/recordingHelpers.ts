/**
 * recordingHelpers.ts — the small pure calculations the recordings page needs,
 * kept out of the components so they can be tested without a DOM.
 *
 * Nothing here talks to the server. `readAudioDuration` is the one function
 * that touches the browser, and it's here because it's the counterpart to
 * `formatDuration`: the server has no ffprobe, so the only thing that knows how
 * long an uploaded file is, is the browser about to upload it. We read the
 * duration off a throwaway <audio> element and send it along as a plain string.
 */

import type { Recording } from './types';

/** Bytes as something a person reads. Audio is the reason this exists — a
 * two-hour voice memo is 'tens of MB' and that's worth seeing before upload. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Seconds -> '2h 14m' / '3m 20s' / '45s'.
 *
 * Precision drops as the recording gets longer, because that's what's readable:
 * seconds matter for a 45-second memo and are noise on a two-hour training, so
 * once there's an hour on the clock only hours and minutes show. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Playback position for the scrubber label — always mm:ss, never rounded up
 * into a unit, because it has to agree with the audio element's own clock. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Ask the browser how long an audio file is, without uploading it first.
 *
 * Resolves to '' rather than rejecting: a duration is a nicety, and a codec the
 * browser can't decode (some .amr, some .caf) must never block the upload of a
 * file the server would have stored perfectly well.
 */
export function readAudioDuration(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('audio');
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish(formatDuration(el.duration));
    el.onerror = () => finish('');
    // Some browsers never fire either event for a format they half-recognize.
    // The upload must not hang on a nicety.
    setTimeout(() => finish(''), 5000);
    el.src = url;
  });
}

/** Human date for a card. Undated recordings say so rather than showing a
 * bare fallback that reads like a real day. */
export function formatRecordingDate(date: string): string {
  if (!date) return 'No date';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function kindLabel(kind: string): string {
  if (!kind) return '';
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ');
}

/** The one-line summary under a card's title: what it's got, how big it is. */
export function attachmentSummary(rec: Recording): string {
  const parts: string[] = [];
  if (rec.audio) {
    parts.push(['Audio', rec.duration, formatBytes(rec.audio.bytes)].filter(Boolean).join(' · '));
  }
  if (rec.transcript) {
    const words = rec.transcript.words;
    parts.push(words ? `Transcript · ${words.toLocaleString()} words` : 'Transcript');
  }
  return parts.length ? parts.join('  |  ') : 'Nothing attached yet';
}

/**
 * Client-side filter for the list. Deliberately metadata-ONLY — title, tags,
 * notes, source, kind. Transcript bodies aren't here and mustn't be: they live
 * on the server (the list only ever holds a preview), and searching them is
 * /api/recordings/search's job. Two different searches, kept visibly separate,
 * so a page showing 3 of 40 cards is never secretly a partial full-text result.
 */
export function filterRecordings(items: Recording[], query: string, kind: string): Recording[] {
  const q = query.trim().toLowerCase();
  return items.filter((rec) => {
    if (kind !== 'all' && rec.kind !== kind) return false;
    if (!q) return true;
    const haystack = [rec.title, rec.notes, rec.source, rec.kind, ...(rec.tags || [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** Every kind actually present, so the filter chips describe the real shelf
 * rather than the full vocabulary. */
export function presentKinds(items: Recording[]): string[] {
  const seen = new Set<string>();
  items.forEach((rec) => {
    if (rec.kind) seen.add(rec.kind);
  });
  return [...seen].sort();
}

export function todayStr(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
