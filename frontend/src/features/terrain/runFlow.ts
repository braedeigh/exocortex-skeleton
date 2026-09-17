/**
 * runFlow.ts — how code actually runs through this app, as data.
 *
 * THE CONFUSION THIS EXISTS TO CLEAR UP. Reading this codebase it's natural to
 * expect a call chain: this function fires that one, which fires the next, all
 * the way down. That is NOT how work moves here, and looking for it is why the
 * shape of the app is hard to see. What actually happens is:
 *
 *     something FIRES a runner  ->  the runner writes a COLLECTION
 *                               ->  later, other code READS that collection
 *
 * The store is a mailbox, not a phone call. A runner writes and exits; whoever
 * reads next arrives minutes or hours later and never meets it. Nothing is
 * "called". That decoupling is the entire point of having a store, and it's why
 * a call-graph drawing of this app would be mostly true and completely
 * misleading.
 *
 * So this module builds the picture that IS true: three columns, left to right.
 * RUNNERS (who executes) -> COLLECTIONS (where it lands) -> READERS (who picks
 * it up later). One hop each way, which is as far as the evidence honestly
 * reaches.
 *
 * WHY A RUNNER CAN BE NAMED AT ALL. Every store write is journaled with the
 * PROCESS that made it (writelog.py's `caller`), and a background job is its
 * own process with its own name — so `extract_footprints` writing
 * `bot_chats/footprints` is recorded fact, not inference. The creek payload
 * already carries this per collection (`collections[].callers[]`), including
 * the caller's resolved source file where there is one. This module pivots that
 * caller-inside-collection shape into a collection-inside-caller one, which is
 * the direction a person actually asks the question in.
 *
 * THE ONE PLACE IT CANNOT NAME ANYONE is `gunicorn`. Every web request runs in
 * the same worker process, so all ~60 route modules report under that single
 * name. It is kept, labelled honestly as the web app rather than as a file, and
 * never resolved to a guess — see TRIGGERS below.
 *
 * Fed by GET /api/creek and GET /api/automations, both of which the app already
 * served. Drawn by RunsView.tsx. Tested in runFlow.test.ts.
 *
 * Prompt that produced it: "this cron job fired, it touched these pieces of
 * code, this is where the data was stored" / "I just am confused about how code
 * runs through the app. And I want to visualize it."
 */
import type { CreekData } from '../creek/api';
import type { ScheduledRun } from '../automations/api';

/** What sets a runner going. Not a guess — each is read off a different record,
 * and anything we can't source lands on 'unknown' rather than a plausible
 * story. */
export type TriggerKind = 'schedule' | 'request' | 'turn' | 'unknown';

export interface RunnerCollection {
  id: string;
  writes: number;
  reads: number;
  /** When this collection last changed — by ANY runner, not necessarily this
   * one. The journal stamps the write, not the intent behind it. */
  lastWrite: string | null;
  /** Files whose source contains a read of this collection. Static wiring: they
   * are wired to pick it up, not observed doing so. */
  readers: string[];
}

export interface Runner {
  /** The process name the write journal recorded. */
  caller: string;
  /** Its source file, when the caller resolves to one (`scripts/<name>.py`).
   * Null for gunicorn and anything else that isn't one of our scripts. */
  file: string | null;
  label: string;
  trigger: TriggerKind;
  /** Human trigger detail — a cron phrase, or what kind of thing fires it. */
  triggerDetail: string;
  /** From the automations registry, when this runner is a registered job. */
  lastRun: string | null;
  lastStatus: 'ok' | 'error' | null;
  writes: number;
  reads: number;
  collections: RunnerCollection[];
}

/**
 * Runners the journal names but that aren't scripts, with what actually fires
 * them. Kept as a table rather than inferred, because the honest answer for
 * each is different in kind: one is the web app, one is an agent turn.
 */
const KNOWN_RUNNERS: Readonly<
  Record<string, { label: string; trigger: TriggerKind; detail: string }>
> = {
  gunicorn: {
    label: 'the web app',
    trigger: 'request',
    // Deliberately not resolved to a route file. Every request runs in the same
    // worker, so this one name covers ~60 route modules and naming any of them
    // would be a guess dressed as a fact.
    detail: 'any HTTP request — all route modules share this one process',
  },
  turn_host: {
    label: 'an agent turn',
    trigger: 'turn',
    detail: 'spawned per conversation turn, outside the web worker',
  },
  adhoc: {
    label: 'a hand-run script',
    trigger: 'unknown',
    detail: 'run by hand, not on a schedule',
  },
};

/** A runner's own source file, when it has one. Never guessed — the creek
 * resolves this server-side (only `scripts/<caller>.py` ever resolves) and we
 * pass it through, narrowing to that directory so a future looser resolver
 * can't quietly start naming route files for gunicorn. */
function fileFor(resolved: string | null): string | null {
  return resolved && resolved.startsWith('scripts/') ? resolved : null;
}

/**
 * Pivot the creek payload from collection-first to runner-first, and hang the
 * schedule off each runner that the automations registry knows about.
 *
 * Sorted by how much each runner actually moves — the busiest first — because
 * the question "how does this app work" is answered fastest by whatever is
 * doing the most, not by whatever sorts first alphabetically.
 */
export function buildRunners(
  creek: CreekData | null | undefined,
  automations: readonly ScheduledRun[] = [],
): Runner[] {
  if (!creek) return [];

  // Static wiring: who READS each collection. Their own source says so; nothing
  // observes them doing it, which is why they're the faintest claim on screen.
  const readersOf = new Map<string, string[]>();
  for (const f of creek.files) {
    for (const call of f.calls) {
      if (call.verb !== 'read') continue;
      const list = readersOf.get(call.collection) ?? [];
      if (!list.includes(f.path)) list.push(f.path);
      readersOf.set(call.collection, list);
    }
  }

  const byId = new Map(automations.map((a) => [a.id, a]));
  const runners = new Map<string, Runner>();

  for (const coll of creek.collections) {
    for (const caller of coll.callers) {
      // A caller that only ever read this collection isn't running anything
      // into it — it belongs on the READERS side, which the static scan covers.
      if (caller.writes <= 0) continue;
      let runner = runners.get(caller.name);
      if (!runner) {
        const known = KNOWN_RUNNERS[caller.name];
        const job = byId.get(caller.name);
        runner = {
          caller: caller.name,
          file: fileFor(caller.file),
          label: known?.label ?? caller.name.replace(/_/g, ' '),
          trigger: known?.trigger ?? (job ? 'schedule' : 'unknown'),
          triggerDetail:
            job?.schedule_human ?? known?.detail ?? 'no schedule on record',
          lastRun: job?.last_run ?? null,
          lastStatus: job?.last_status ?? null,
          writes: 0,
          reads: 0,
          collections: [],
        };
        runners.set(caller.name, runner);
      }
      runner.writes += caller.writes;
      runner.reads += caller.reads;
      runner.collections.push({
        id: coll.id,
        writes: caller.writes,
        reads: caller.reads,
        lastWrite: coll.last_write ?? coll.last_write_day ?? null,
        readers: (readersOf.get(coll.id) ?? []).filter((p) => p !== runner!.file),
      });
    }
  }

  for (const r of runners.values()) {
    r.collections.sort((a, b) => b.writes - a.writes || a.id.localeCompare(b.id));
  }

  return [...runners.values()].sort(
    (a, b) => b.writes - a.writes || a.caller.localeCompare(b.caller),
  );
}

/**
 * Every distinct file downstream of a runner — the union of its collections'
 * readers. Used for the count on the runner's own row, so the third column can
 * stay collapsed until asked for without hiding how wide the fan-out is.
 */
export function downstreamFiles(runner: Runner): string[] {
  const out = new Set<string>();
  for (const c of runner.collections) for (const r of c.readers) out.add(r);
  return [...out].sort();
}

/** Compact age for a timestamp the journal or the registry gave us. Null in,
 * "never" out — an unknown time is never rendered as "just now". */
export function sinceLabel(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (!Number.isFinite(ms)) return 'never';
  const sec = Math.max(0, (nowMs - ms) / 1000);
  if (sec < 90) return 'just now';
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
