/**
 * activityMath.ts — the Activity pane's logic, with no React in it: turning
 * the server's flat event feed into the steps the pane draws, and the counts
 * and warnings above them.
 *
 * The server (activityfeed.py, served by routes/observatory.py) sends small
 * events in log order: a tool CALL, later its RESULT, a heartbeat saying a
 * tool is still going, an API retry, the turn's END. Pairing happens here
 * rather than on the server because a call and its result often arrive in
 * different polls, a few seconds apart. So the state keeps an index from
 * each call's id to its step, and a result that arrives later lands on the
 * row that's already on screen.
 *
 * Pure and immutable (a new state per fold), so it's tested directly in
 * activityMath.test.ts and React sees every change.
 *
 * Touches: api.ts (the event types), useActivityFeed.ts (folds each poll in),
 * ActivityPage.tsx (draws the steps).
 */
import type { ActivityEvent } from './api';

export interface ToolResult {
  at: string | null;
  output: string;
  outputCut: boolean;
  chars: number;
  isError: boolean;
}

export interface CallStep {
  kind: 'call';
  key: string;
  id: string;
  at: string | null;
  parent: string | null;
  name: string;
  target: string | null;
  input: string | null;
  inputCut: boolean;
  result: ToolResult | null;
  /** Seconds the last heartbeat said this tool had been running. */
  elapsed: number | null;
  /** Set when the permission check refused the call. */
  denied: { reason: string | null; text: string | null } | null;
  /** Set when the call went to the background (a long Bash, a subagent). */
  task: { status: string | null; text: string | null } | null;
}

export type OtherStep = {
  key: string;
  at: string | null;
  parent?: string | null;
} & Exclude<ActivityEvent, { kind: 'call' | 'result' | 'progress' | 'denied' | 'task' }>;

export type Step = CallStep | OtherStep;

export interface ActivityState {
  steps: Step[];
  /** Call id → its position in `steps`. */
  callIndex: Record<string, number>;
  /** The last timestamp seen. Events the log doesn't date inherit it. */
  clock: string | null;
}

export function emptyActivity(): ActivityState {
  return { steps: [], callIndex: {}, clock: null };
}

/** An empty call row, for a result or heartbeat whose call fell outside the
 *  window the pane first read (a long session is read from near its end). */
function placeholderCall(id: string, at: string | null): CallStep {
  return {
    kind: 'call', key: `call:${id}`, id, at, parent: null, name: '?', target: null,
    input: null, inputCut: false, result: null, elapsed: null, denied: null, task: null,
  };
}

/** Fold one poll's events into the state. Returns a new state. */
export function foldEvents(state: ActivityState, events: readonly ActivityEvent[]): ActivityState {
  if (events.length === 0) return state;
  const steps = [...state.steps];
  const callIndex = { ...state.callIndex };
  let clock = state.clock;

  // Update a call already on screen, copying it so React sees the change.
  // A call that isn't there yet gets a placeholder row first.
  const patchCall = (id: string | null, patch: (call: CallStep) => CallStep) => {
    if (!id) return;
    let i = callIndex[id];
    if (i === undefined) {
      i = steps.length;
      callIndex[id] = i;
      steps.push(placeholderCall(id, clock));
    }
    steps[i] = patch(steps[i] as CallStep);
  };

  for (const event of events) {
    if ('at' in event && event.at) clock = event.at;
    const at = ('at' in event && event.at) || clock;
    switch (event.kind) {
      case 'call': {
        // The same call can be read twice (a subagent's log echoes it);
        // the first reading is the row.
        if (callIndex[event.id] !== undefined) break;
        callIndex[event.id] = steps.length;
        steps.push({
          kind: 'call', key: `call:${event.id}`, id: event.id, at,
          parent: event.parent, name: event.name, target: event.target,
          input: event.input, inputCut: event.input_cut, result: null,
          elapsed: null, denied: null, task: null,
        });
        break;
      }
      case 'result':
        patchCall(event.id, (call) =>
          call.result
            ? call
            : {
                ...call,
                result: {
                  at, output: event.output ?? '', outputCut: event.output_cut,
                  chars: event.chars, isError: event.is_error,
                },
              },
        );
        break;
      case 'progress':
        patchCall(event.id, (call) => ({ ...call, elapsed: event.elapsed }));
        break;
      case 'denied':
        patchCall(event.id, (call) => ({ ...call, denied: { reason: event.reason, text: event.text } }));
        break;
      case 'task':
        patchCall(event.id, (call) => ({ ...call, task: { status: event.status, text: event.text } }));
        break;
      default:
        steps.push({ ...event, key: `${event.kind}:${steps.length}`, at } as OtherStep);
    }
  }
  return { steps, callIndex, clock };
}

/** Milliseconds between two local ISO stamps, or null. */
export function msBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

/** "340ms", "12s", "3m 05s", "1h 02m" — short enough for a row's edge. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Where a call stands: still going, done, failed, or refused. A call with
 *  no result in a session that's stopped didn't finish — it was cut off. */
export type CallStatus = 'running' | 'ok' | 'error' | 'denied' | 'cut off';

export function callStatus(call: CallStep, sessionRunning: boolean): CallStatus {
  if (call.denied) return 'denied';
  if (call.result) return call.result.isError ? 'error' : 'ok';
  return sessionRunning ? 'running' : 'cut off';
}

/** Is this step one of the things that explain a drop or a failure? */
export function isProblem(step: Step, sessionRunning: boolean): boolean {
  switch (step.kind) {
    case 'call': {
      const status = callStatus(step, sessionRunning);
      return status === 'error' || status === 'denied' || status === 'cut off';
    }
    case 'end':
      return step.is_error;
    case 'error':
    case 'retry':
    case 'limit':
      return true;
    default:
      return false;
  }
}

export interface Tally {
  calls: number;
  running: number;
  errors: number;
  retries: number;
  denied: number;
}

/** The counts shown above the list. */
export function tally(steps: readonly Step[], sessionRunning: boolean): Tally {
  const out: Tally = { calls: 0, running: 0, errors: 0, retries: 0, denied: 0 };
  for (const step of steps) {
    if (step.kind === 'call') {
      out.calls += 1;
      const status = callStatus(step, sessionRunning);
      if (status === 'running') out.running += 1;
      if (status === 'error') out.errors += 1;
      if (status === 'denied') out.denied += 1;
    } else if (step.kind === 'retry') {
      out.retries += 1;
    } else if ((step.kind === 'end' && step.is_error) || step.kind === 'error') {
      out.errors += 1;
    }
  }
  return out;
}

/**
 * The one-line answer to "is it stuck?", or null when nothing looks wrong.
 *
 * A running session that hasn't written anything for a while is the silent
 * drop she's trying to catch. If a tool is still open, the wait is probably
 * that tool, and it's named; otherwise nothing is visibly happening.
 */
export function stallWarning(
  steps: readonly Step[],
  sessionRunning: boolean,
  quietMs: number | null,
): string | null {
  if (!sessionRunning || quietMs === null || quietMs < STALL_AFTER_MS) return null;
  const quiet = formatDuration(quietMs);
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind === 'call' && callStatus(step, true) === 'running') {
      return `Waiting on ${step.name} — nothing new written for ${quiet}.`;
    }
  }
  return `Running, but nothing new written for ${quiet}.`;
}

/** How long a running session can be silent before the pane says so. Long
 *  thinking can run a minute or more, so less than this is just thinking. */
export const STALL_AFTER_MS = 90_000;

/**
 * A call's input, made readable: a Bash call is its command, and anything
 * else is its JSON. A cut input isn't valid JSON, so it's shown as it came.
 */
export function readableInput(call: Pick<CallStep, 'name' | 'input'>): string {
  if (!call.input) return '';
  try {
    const parsed: unknown = JSON.parse(call.input);
    if (call.name === 'Bash' && parsed && typeof parsed === 'object' && 'command' in parsed) {
      const command = (parsed as { command: unknown }).command;
      if (typeof command === 'string') return command;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return call.input;
  }
}
