/**
 * setupCheck.ts — turn the desktop server's status into what the first-run
 * screen says. Pure logic, no drawing and no fetching, so it can be checked
 * without a browser (setupCheck.test.ts).
 *
 * The server's answer (GET /api/standalone, standalone_app.py) reports two
 * things a new person has to have before the app is any use: a code folder
 * for Terrain to draw, and Claude Code installed and signed in so a session
 * can answer. This file reads that answer and produces, for each of the two,
 * a state, one headline, and the plain steps to take when it isn't right.
 *
 * Claude Code is the only model runner checked today. The check is its own
 * function (readClaude) returning the same SetupStep as everything else, so
 * another runner can be added beside it later as one more step.
 *
 * Every field of the answer is treated as possibly missing. The screen is the
 * first thing a stranger sees, so a server that answers with less than
 * expected must still produce sentences rather than a blank page.
 *
 * Touches: setupApi.ts (fetches the status), FirstRunPage.tsx (draws what
 * this returns), routes/__root.tsx (asks setupGate whether to show it).
 */

/** Where the chosen code folder stands, in the server's words. */
export type ProjectState = 'none' | 'downloading' | 'loading' | 'ready' | 'failed';

/** One code folder the app can draw. The app's own code and a person's own
 * folder are separate projects, each with its own map; one is current. */
export interface ProjectStatus {
  path?: string | null;
  ok?: boolean;
  state?: ProjectState;
  /** One plain line of progress while downloading or loading. */
  detail?: string;
  error?: string | null;
  id?: string | null;
  name?: string | null;
  current?: boolean;
}

/** GET /api/standalone, as the page reads it. */
export interface StandaloneStatus {
  standalone?: boolean;
  version?: string;
  data_dir?: string;
  claude?: {
    found?: boolean;
    bin?: string | null;
    version?: string | null;
    /** null means the server couldn't tell. */
    signed_in?: boolean | null;
  };
  git?: { found?: boolean; version?: string | null };
  /** This app's own code, offered as the first thing to draw. */
  own?: { available?: boolean; name?: string };
  /** The current project: the one Terrain draws. */
  project?: ProjectStatus;
  /** Every project, the current one included. */
  projects?: ProjectStatus[];
  /** `ask_first`: new sessions stop and ask before they change anything.
   * `idle_check`: a session left alone for a day is asked whether it's done.
   * `keeper_rollover`: the Keeper's day closes by itself each night. */
  settings?: { ask_first?: boolean; idle_check?: boolean; keeper_rollover?: boolean };
  /** The journal, when this desktop app has one. `keeper` is the open Keeper
   * session's id, or null; `setup_done` is false until the Keeper has asked
   * who it is keeping for. */
  journal?: { folder?: string; setup_done?: boolean; keeper?: string | null };
  ready?: boolean;
}

/** How one step of the setup stands. `unknown` is "couldn't tell", which is
 * neither a pass nor a failure and is worded that way. */
export type StepState = 'done' | 'todo' | 'working' | 'problem' | 'unknown';

export interface SetupStep {
  state: StepState;
  /** One sentence: where this step stands. */
  headline: string;
  /** What to do about it, one instruction per line. Empty when nothing is needed. */
  advice: string[];
}

export interface SetupReading {
  folder: SetupStep;
  claude: SetupStep;
  /** The app can be opened: there is a folder for Terrain to draw. */
  canOpen: boolean;
  /** Sessions will be able to answer. False when Claude Code is missing or
   * signed out; true when it's fine or the server couldn't tell. */
  canChat: boolean;
  /** Something is in progress, so the screen should keep asking the server. */
  stillWorking: boolean;
  /** The server can hand over this app's own code to draw, and under what
   * name. Null when it can't, so the screen leaves that option out. */
  ownCode: { name: string } | null;
  /** The other projects that are ready to draw, for switching to. Empty when
   * there is only the current one. */
  otherProjects: Array<{ id: string; name: string }>;
  /** Whether new sessions ask before changing anything, or null when the
   * server didn't say — the screen then says nothing rather than guess. */
  asksFirst: boolean | null;
  /** Is a session left alone for a day asked whether it's finished? Null
   * when the server didn't say, so the page shows no switch rather than a guess. */
  checksIdle: boolean | null;
  /** Does the Keeper's day close by itself each night? Null when the server
   * didn't say, so the page shows no switch rather than a guess. */
  rollsOver: boolean | null;
  /** The journal step, or null when this desktop app has no journal. */
  keeper: KeeperReading | null;
}

/** Where the journal's Keeper stands, and what its one button does. */
export interface KeeperReading {
  /** The open Keeper session to show, or null when none is open. */
  sessionId: string | null;
  /** One sentence: where it stands. */
  headline: string;
  /** The button's words. */
  action: string;
  /** False when pressing would start a session that can't answer. */
  canStart: boolean;
}

/** Read the journal step. Three states: a Keeper is open (go to it), none is
 * open on a set-up journal (wake one), or the journal is new (the first wake
 * is the setup conversation). Waking needs Claude Code ready, because the
 * Keeper is a session. */
function readKeeper(status: StandaloneStatus | null, claudeReady: boolean): KeeperReading | null {
  const journal = status?.journal;
  if (!journal) return null;
  if (journal.keeper) {
    return { sessionId: journal.keeper, headline: 'The Keeper is open.', action: 'Go to the Keeper', canStart: true };
  }
  if (journal.setup_done) {
    return { sessionId: null, headline: 'The journal is set up. No Keeper session is open.', action: 'Wake the Keeper', canStart: claudeReady };
  }
  return {
    sessionId: null,
    headline: 'The journal is new. The Keeper’s first conversation sets it up: it explains itself and asks who it is keeping for.',
    action: 'Start the journal',
    canStart: claudeReady,
  };
}

/** Where Claude Code's own instructions live. */
export const CLAUDE_CODE_LINK = 'https://claude.com/claude-code';

/** Read the code-folder step. A folder that is downloading or being read is
 * `working` and shows the server's own progress line. */
function readFolder(status: StandaloneStatus | null): SetupStep {
  const project = status?.project;
  const state: ProjectState = project?.state ?? (project?.ok ? 'ready' : 'none');
  const name = project?.name || project?.path || 'the folder';

  if (state === 'ready' && project?.ok !== false) {
    return { state: 'done', headline: `Terrain will draw ${name}.`, advice: [] };
  }
  if (state === 'downloading') {
    return { state: 'working', headline: project?.detail || 'Downloading the code…', advice: [] };
  }
  if (state === 'loading') {
    return { state: 'working', headline: project?.detail || 'Reading its history…', advice: [] };
  }
  if (state === 'failed') {
    return {
      state: 'problem',
      headline: project?.error || 'That didn’t work.',
      advice: ['Check the folder or the address and try again.'],
    };
  }
  const advice = ['Start with this app’s own code, choose a folder that holds a git project, or download one from its address.'];
  if (status?.git?.found === false) {
    advice.push('Git isn’t installed on this computer. Install it first: the map is drawn from a project’s git history.');
  }
  return { state: 'todo', headline: 'No code folder chosen yet.', advice };
}

/** Read the Claude Code step: not installed, installed but signed out,
 * installed and couldn't tell, or fine. */
function readClaude(status: StandaloneStatus | null): SetupStep {
  const claude = status?.claude;
  if (!claude || claude.found === undefined) {
    return {
      state: 'unknown',
      headline: 'Couldn’t check for Claude Code.',
      advice: ['Sessions need Claude Code installed and signed in on this computer.'],
    };
  }
  if (!claude.found) {
    return {
      state: 'problem',
      headline: 'Claude Code isn’t installed, or this app can’t find it.',
      advice: [
        `Install it: see ${CLAUDE_CODE_LINK}`,
        'Open a terminal, run “claude”, and sign in.',
        'Come back here and press Check again.',
      ],
    };
  }
  // The program prints its version as "2.1.289 (Claude Code)"; keep the number.
  const number = (claude.version ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
  const version = number ? ` (${number})` : '';
  if (claude.signed_in === false) {
    return {
      state: 'problem',
      headline: `Claude Code is installed${version}, but not signed in.`,
      advice: ['Open a terminal, run “claude”, and sign in.', 'Come back here and press Check again.'],
    };
  }
  if (claude.signed_in !== true) {
    return {
      state: 'unknown',
      headline: `Claude Code is installed${version}. Couldn’t tell whether it’s signed in.`,
      advice: ['If a session answers with a sign-in error, open a terminal, run “claude”, and sign in.'],
    };
  }
  return { state: 'done', headline: `Claude Code is installed${version} and signed in.`, advice: [] };
}

/** Read the whole status into what the first-run screen shows. */
export function readSetup(status: StandaloneStatus | null): SetupReading {
  const folder = readFolder(status);
  const claude = readClaude(status);
  return {
    folder,
    claude,
    canOpen: folder.state === 'done',
    canChat: claude.state === 'done' || claude.state === 'unknown',
    stillWorking: folder.state === 'working',
    ownCode: status?.own?.available ? { name: status.own.name || 'this app' } : null,
    otherProjects: (status?.projects ?? []).flatMap((project) =>
      project.id && !project.current && project.id !== status?.project?.id && project.state === 'ready'
        ? [{ id: project.id, name: project.name || project.path || project.id }]
        : [],
    ),
    asksFirst: typeof status?.settings?.ask_first === 'boolean' ? status.settings.ask_first : null,
    checksIdle: typeof status?.settings?.idle_check === 'boolean' ? status.settings.idle_check : null,
    rollsOver: typeof status?.settings?.keeper_rollover === 'boolean' ? status.settings.keeper_rollover : null,
    keeper: readKeeper(status, claude.state === 'done'),
  };
}

/** What the window should show: nothing yet, the first-run screen, or the app. */
export type SetupGate = 'waiting' | 'setup' | 'app';

/**
 * Decide whether the first-run screen stands in front of the app.
 *
 * - No answer yet: `waiting`, so the app doesn't flash up and vanish.
 * - The server couldn't be asked: let a person who has been through setup
 *   before straight in, and show a new person the screen (it says the check
 *   failed and offers a way in).
 * - Never finished setup, or the folder is gone since: the screen.
 * - Otherwise the app. A missing or signed-out Claude Code does NOT bring the
 *   screen back: the map still works, and the Setup tab says what's wrong.
 */
export function setupGate(args: {
  status: StandaloneStatus | null;
  /** The status request failed. */
  unreachable: boolean;
  /** This person has pressed "Open the app" before, on this machine. */
  finishedBefore: boolean;
}): SetupGate {
  const { status, unreachable, finishedBefore } = args;
  if (unreachable) return finishedBefore ? 'app' : 'setup';
  if (!status) return 'waiting';
  if (!finishedBefore) return 'setup';
  return readSetup(status).canOpen ? 'app' : 'setup';
}

/** Does this look like an address to download from, rather than nothing or a
 * local path? Only a first check, so the button can stay off for an obvious
 * non-address — the server is the judge of whether it works. */
export function looksLikeRepoAddress(text: string): boolean {
  const trimmed = text.trim();
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)\S+\/\S+$/.test(trimmed);
}

/** The full path of a folder named `name` inside `parent`. Joined with the
 * separator the parent path already uses, so a Windows path stays a Windows
 * path, and without doubling it when the parent is a root ("/" or "C:\\"). */
export function childFolderPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(separator) ? parent + name : parent + separator + name;
}
