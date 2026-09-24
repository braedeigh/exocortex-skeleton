/**
 * windowBus.ts — "open this over there", where *there* may be another tile, or
 * another browser window on another monitor.
 *
 * THE PROBLEM IT SOLVES. Clicking a file in a session used to navigate the one
 * routed half of the screen, because there was only one place a page could go.
 * With a workspace of tiles — and with two windows open on two monitors — the
 * question "where does this open?" has a real answer that changes minute to
 * minute: in the code tile if one is open, on the other monitor if that's
 * where the code tile lives, and otherwise the old behaviour of navigating.
 *
 * HOW IT DECIDES, in order:
 *   1. A tile in THIS window that accepts this kind of thing. Most recently
 *      touched tile wins, so with two code tiles open it lands in the one you
 *      were last working in rather than an arbitrary one.
 *   2. A tile in ANOTHER window that accepts it, over a BroadcastChannel.
 *   3. Nobody — the caller falls back to navigating, exactly as before.
 *
 * WHY WINDOWS ANNOUNCE THEMSELVES RATHER THAN THE SENDER ASKING. A sender
 * needs its answer NOW, to decide synchronously whether to navigate instead;
 * asking other windows and waiting for a reply would mean every click paused
 * on a timeout. So instead each window broadcasts what it can accept whenever
 * that changes, everyone keeps a small map of everyone else, and dispatch is a
 * lookup. A new window says hello and the others re-announce, which is how it
 * learns about windows that were already open.
 *
 * A window that vanishes without saying goodbye (a crash, a killed tab) would
 * otherwise keep collecting intents that go nowhere. Announcements carry a
 * timestamp and go stale, so a dead window drops out on its own.
 *
 * Touches: PaneStack.tsx and RoutePanel.tsx (register as targets),
 * paneConversation.ts (the conversation seam), sessionIntent.ts (the terminal
 * seam), TerrainPage/JournalPage/SessionCard (senders).
 *
 * Prompt that produced it: "fix the cross window bus then I want to be able to
 * open multiple of the same thing".
 */

/** The kinds of thing one part of the app can hand to another. */
export type Intent =
  | { kind: 'conversation'; convId: string }
  | {
      kind: 'code';
      repo: string;
      path: string;
      /** Where in the file to land: the lines that name `mentionsOf`, 1-based
       * and ascending. Set when the file was opened from a SQL table's card;
       * absent for a plain "open this file". */
      mentions?: readonly number[];
      /** What those lines name — a table, shown in the file's mention strip. */
      mentionsOf?: string;
    }
  | { kind: 'session'; name: string }
  /** A session's Activity pane (features/activity/), opened beside it. */
  | { kind: 'activity'; convId: string };

export type IntentKind = Intent['kind'];

/** Where a dispatch ended up — the caller only has to care about 'none'. */
export type DispatchResult = 'local' | 'remote' | 'none';

const CHANNEL = 'exo-window-bus';
/** An announcement older than this is from a window that stopped talking.
 *  Generous, because windows only re-announce when something changes. */
const STALE_MS = 30_000;

interface Target {
  kinds: ReadonlySet<IntentKind>;
  handle: (intent: Intent) => void;
  /** Higher wins. Bumped when the tile is touched, so the last tile you
   *  worked in is the one that catches the next intent. */
  rank: number;
}

const targets = new Set<Target>();
/** What other windows say they accept, and when they last said it. */
const remotes = new Map<string, { kinds: Set<IntentKind>; at: number }>();

let channel: BroadcastChannel | null = null;
let myId = '';
let rankCounter = 0;

/* ---------- wiring up ---------- */

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  // Absent in SSR and in the node test environment; the bus still works
  // within a single window without it.
  if (typeof BroadcastChannel === 'undefined') return null;
  myId = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent) => onMessage(e.data);
  // Tell everyone we exist and ask them to say the same, so a window opened
  // second learns about the one opened first.
  post({ t: 'hello', from: myId });
  announce();
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => post({ t: 'bye', from: myId }));
  }
  return channel;
}

type Message =
  | { t: 'hello'; from: string }
  | { t: 'bye'; from: string }
  | { t: 'caps'; from: string; kinds: IntentKind[] }
  | { t: 'intent'; to: string; intent: Intent };

function post(msg: Message): void {
  try {
    channel?.postMessage(msg);
  } catch {
    // A window mid-teardown can refuse to post; nothing here is worth throwing
    // over — the sender falls back to navigating.
  }
}

function onMessage(msg: Message): void {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello' && msg.from !== myId) {
    announce(); // a newcomer — tell it what we hold
    return;
  }
  if (msg.t === 'bye') {
    remotes.delete(msg.from);
    return;
  }
  if (msg.t === 'caps' && msg.from !== myId) {
    if (msg.kinds.length === 0) remotes.delete(msg.from);
    else remotes.set(msg.from, { kinds: new Set(msg.kinds), at: Date.now() });
    return;
  }
  if (msg.t === 'intent' && msg.to === myId) {
    deliverLocal(msg.intent);
  }
}

/** Say what this window currently accepts. Called whenever targets change. */
function announce(): void {
  if (!channel) return;
  const kinds = new Set<IntentKind>();
  for (const t of targets) for (const k of t.kinds) kinds.add(k);
  post({ t: 'caps', from: myId, kinds: [...kinds] });
}

/* ---------- the public surface ---------- */

/**
 * Claim "things of these kinds can open here". Returns an unregister for the
 * effect cleanup.
 *
 * `bump` raises this target above its peers — a tile calls it when it's
 * touched, which is what makes two tiles of the same kind behave sensibly
 * instead of one of them silently always winning.
 */
export function registerIntentTarget(
  kinds: IntentKind[],
  handle: (intent: Intent) => void,
): { unregister: () => void; bump: () => void } {
  ensureChannel();
  rankCounter += 1;
  const target: Target = { kinds: new Set(kinds), handle, rank: rankCounter };
  targets.add(target);
  announce();
  return {
    unregister: () => {
      targets.delete(target);
      announce();
    },
    bump: () => {
      rankCounter += 1;
      target.rank = rankCounter;
    },
  };
}

function bestLocal(kind: IntentKind): Target | null {
  let best: Target | null = null;
  for (const t of targets) {
    if (!t.kinds.has(kind)) continue;
    if (!best || t.rank > best.rank) best = t;
  }
  return best;
}

function deliverLocal(intent: Intent): boolean {
  const target = bestLocal(intent.kind);
  if (!target) return false;
  target.handle(intent);
  return true;
}

function bestRemote(kind: IntentKind): string | null {
  const now = Date.now();
  let found: string | null = null;
  for (const [id, cap] of remotes) {
    if (now - cap.at > STALE_MS) {
      remotes.delete(id); // that window stopped talking
      continue;
    }
    if (cap.kinds.has(kind)) found = id;
  }
  return found;
}

/**
 * Send something where it should go. 'none' means nowhere would take it and
 * the caller should do whatever it did before this bus existed — usually
 * navigate the primary tile.
 */
export function dispatchIntent(intent: Intent): DispatchResult {
  ensureChannel();
  if (deliverLocal(intent)) return 'local';
  const remote = bestRemote(intent.kind);
  if (remote) {
    post({ t: 'intent', to: remote, intent });
    return 'remote';
  }
  return 'none';
}

/** Test seam: forget every target and every remote window. */
export function resetBusForTests(): void {
  targets.clear();
  remotes.clear();
  channel?.close();
  channel = null;
  myId = '';
  rankCounter = 0;
}
