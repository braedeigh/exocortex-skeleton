/**
 * api.ts — the Activity pane's two server calls and the shapes they return.
 *
 * GET /api/observatory/conversation/<id>/activity?from=<byte> gives the
 * events written since that byte of the session's transcript, plus where to
 * resume next time. …/activity/output?id=<tool call id> gives one tool's
 * output uncut, for when the feed's copy was cut short. Both are served by
 * routes/observatory.py, parsed by activityfeed.py.
 *
 * Touches: activityMath.ts (folds the events), useActivityFeed.ts (polls).
 */
import { api } from '../../api/client';

/** One event from the transcript. `kind` says which; see activityfeed.py. */
export type ActivityEvent =
  | { kind: 'prompt'; at: string | null; text: string }
  | { kind: 'init'; model: string | null; cwd: string | null }
  | { kind: 'said'; at: string | null; parent: string | null; text: string }
  | { kind: 'thought'; at: string | null; parent: string | null; text: string }
  | {
      kind: 'call';
      at: string | null;
      parent: string | null;
      id: string;
      name: string;
      target: string | null;
      input: string | null;
      input_cut: boolean;
    }
  | {
      kind: 'result';
      at: string | null;
      parent: string | null;
      id: string | null;
      output: string | null;
      output_cut: boolean;
      chars: number;
      is_error: boolean;
    }
  | { kind: 'progress'; id: string | null; elapsed: number | null }
  | { kind: 'denied'; id: string | null; tool: string | null; reason: string | null; text: string | null }
  | { kind: 'task'; id: string | null; task: string | null; status: string | null; text: string | null }
  | {
      kind: 'retry';
      attempt: number | null;
      max: number | null;
      error: string | null;
      status: number | null;
      delay_ms: number | null;
    }
  | { kind: 'limit'; status: string | null; window: string | null; resets_at: number | null }
  | {
      kind: 'end';
      subtype: string | null;
      is_error: boolean;
      reason: string | null;
      duration_ms: number | null;
      turns: number | null;
      cost_usd: number | null;
      text: string | null;
    }
  | { kind: 'error'; text: string }
  | { kind: 'note'; subtype: string | null };

export interface ActivityPage {
  id: string;
  title: string;
  running: boolean;
  /** When the transcript last grew, local time. */
  mtime: string | null;
  /** Where this read really began. Not the `from` that was asked for →
   *  the file was rewritten or clipped, so the list starts over. */
  start: number;
  next: number;
  /** The session is long and this read started near its end. */
  clipped: boolean;
  events: ActivityEvent[];
}

export function getActivity(convId: string, from: number, signal?: AbortSignal) {
  return api.get<ActivityPage>(
    `/api/observatory/conversation/${encodeURIComponent(convId)}/activity?from=${from}`,
    signal,
  );
}

export function getFullOutput(convId: string, toolUseId: string) {
  return api.get<{ id: string; output: string }>(
    `/api/observatory/conversation/${encodeURIComponent(convId)}/activity/output?id=${encodeURIComponent(toolUseId)}`,
  );
}
