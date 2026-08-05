/**
 * api.ts — endpoints for the recordings page. Matches routes/recordings.py.
 *
 * Two transports, because audio can't ride in JSON: metadata edits go through
 * the shared JSON client, and anything carrying a file goes through postForm()
 * below (same semantics — same-origin, credentials, 401 -> /login, a JSON
 * {error} surfaced as ApiError — just a multipart body).
 */

import { ApiError, api } from '../../api/client';
import type { RecordingFields, RecordingsResponse, Recording, SearchResponse } from './types';

/** Multipart POST. No Content-Type header: the browser has to set the
 * multipart boundary itself. Mirrors inventory/api.ts's postForm. */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'include', body: form });

  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    let message = res.statusText || `Request failed with status ${res.status}`;
    // A file bigger than nginx's client_max_body_size never reaches Flask — it
    // dies at the proxy with an HTML 413, so there's no {error} to unwrap and
    // the raw statusText ("Request Entity Too Large") tells her nothing about
    // what to do. Name the actual cause.
    if (res.status === 413) {
      message = 'That file is too large to upload. Trim the recording, or raise the server upload limit.';
    } else {
      try {
        const data: unknown = await res.clone().json();
        if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
          message = data.error;
        }
      } catch {
        // not JSON — keep statusText
      }
    }
    throw new ApiError(res.status, message);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function getRecordings(signal?: AbortSignal): Promise<RecordingsResponse> {
  return api.get<RecordingsResponse>('/api/recordings', signal);
}

/** One recording WITH its full transcript text — what opening a card fetches. */
export function getRecording(id: string, signal?: AbortSignal): Promise<{ recording: Recording }> {
  return api.get<{ recording: Recording }>(`/api/recordings/${encodeURIComponent(id)}`, signal);
}

/** Create. Multipart throughout so audio and/or a transcript file can ride
 * along; the server accepts a plain JSON body too, but one path is simpler
 * than two and an empty FormData costs nothing. */
export function addRecording(
  fields: RecordingFields,
  opts: { audio?: File | null; transcriptFile?: File | null; transcriptText?: string } = {},
): Promise<{ recording: Recording }> {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  if (opts.audio) fd.append('audio', opts.audio);
  if (opts.transcriptFile) fd.append('transcript', opts.transcriptFile);
  else if (opts.transcriptText) fd.append('transcript_text', opts.transcriptText);
  return postForm<{ recording: Recording }>('/api/recordings/add', fd);
}

/** Partial patch: only the keys passed are touched. Passing an empty
 * `transcript_text` is how you CLEAR a transcript — omitting it leaves it be. */
export function updateRecording(
  id: string,
  patch: Partial<RecordingFields> & { transcript_text?: string },
): Promise<{ recording: Recording }> {
  return api.post<{ recording: Recording }>('/api/recordings/update', { id, ...patch });
}

export function removeRecording(id: string): Promise<unknown> {
  return api.post('/api/recordings/remove', { id });
}

export function attachAudio(id: string, file: File): Promise<unknown> {
  const fd = new FormData();
  fd.append('audio', file);
  return postForm(`/api/recordings/${encodeURIComponent(id)}/audio`, fd);
}

export function removeAudio(id: string): Promise<unknown> {
  return api.post(`/api/recordings/${encodeURIComponent(id)}/audio/remove`, {});
}

export function attachTranscriptFile(id: string, file: File): Promise<unknown> {
  const fd = new FormData();
  fd.append('transcript', file);
  return postForm(`/api/recordings/${encodeURIComponent(id)}/transcript`, fd);
}

export function searchRecordings(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  return api.get<SearchResponse>(`/api/recordings/search?q=${encodeURIComponent(q)}`, signal);
}

/** Streamed by the server with Range support, so seeking a long recording
 * doesn't re-download it. */
export function audioUrl(filename: string): string {
  return `/recordings/audio/${encodeURIComponent(filename)}`;
}
