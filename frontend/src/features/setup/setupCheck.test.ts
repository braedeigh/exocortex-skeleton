import { describe, expect, it } from 'vitest';
import { childFolderPath, looksLikeRepoAddress, readSetup, setupGate, type StandaloneStatus } from './setupCheck';

/** A machine where everything is in place. Each test breaks one thing. */
const ALL_SET: StandaloneStatus = {
  standalone: true,
  claude: { found: true, bin: '/usr/local/bin/claude', version: '2.1.220', signed_in: true },
  git: { found: true, version: '2.43.0' },
  project: { path: '/home/someone/project', ok: true, state: 'ready', detail: '', error: null, name: 'project' },
  ready: true,
};

const withClaude = (claude: StandaloneStatus['claude']): StandaloneStatus => ({ ...ALL_SET, claude });
const withProject = (project: StandaloneStatus['project']): StandaloneStatus => ({ ...ALL_SET, project });

describe('what the first-run check reports', () => {
  it('says both steps are done on a machine that is set up, with nothing left to do', () => {
    const reading = readSetup(ALL_SET);
    expect(reading.folder.state).toBe('done');
    expect(reading.folder.headline).toContain('project');
    expect(reading.claude.state).toBe('done');
    expect(reading.folder.advice).toEqual([]);
    expect(reading.claude.advice).toEqual([]);
    expect(reading).toMatchObject({ canOpen: true, canChat: true, stillWorking: false });
  });

  it('tells a person with no Claude Code to install it, sign in, and check again', () => {
    const reading = readSetup(withClaude({ found: false }));
    expect(reading.claude.state).toBe('problem');
    expect(reading.claude.advice.join(' ')).toMatch(/install/i);
    expect(reading.claude.advice.join(' ')).toMatch(/sign in/i);
    expect(reading.claude.advice.join(' ')).toMatch(/check again/i);
    // The map still works without it, so the app can be opened.
    expect(reading).toMatchObject({ canOpen: true, canChat: false });
  });

  it('shows the version as a plain number, however the program prints it', () => {
    const printed = readSetup(withClaude({ found: true, version: '2.1.289 (Claude Code)', signed_in: true }));
    expect(printed.claude.headline).toBe('Claude Code is installed (2.1.289) and signed in.');
    const none = readSetup(withClaude({ found: true, version: null, signed_in: true }));
    expect(none.claude.headline).toBe('Claude Code is installed and signed in.');
  });

  it('tells a signed-out person to sign in, not to install', () => {
    const reading = readSetup(withClaude({ found: true, version: '2.1.220', signed_in: false }));
    expect(reading.claude.state).toBe('problem');
    expect(reading.claude.headline).toMatch(/not signed in/);
    expect(reading.claude.advice.join(' ')).not.toMatch(/install it/i);
    expect(reading.canChat).toBe(false);
  });

  it('does not claim a sign-in it could not confirm', () => {
    const reading = readSetup(withClaude({ found: true, signed_in: null }));
    expect(reading.claude.state).toBe('unknown');
    expect(reading.claude.headline).not.toMatch(/and signed in/);
    // Not knowing is not a failure: sessions are allowed to try.
    expect(reading.canChat).toBe(true);
  });

  it('keeps the app shut until there is a folder, and says so', () => {
    const reading = readSetup(withProject({ path: null, ok: false, state: 'none' }));
    expect(reading.folder.state).toBe('todo');
    expect(reading.folder.advice.length).toBeGreaterThan(0);
    expect(reading.canOpen).toBe(false);
  });

  it('adds the missing-git instruction only when git is missing', () => {
    const none = { path: null, ok: false, state: 'none' as const };
    expect(readSetup({ ...ALL_SET, project: none }).folder.advice.join(' ')).not.toMatch(/isn’t installed/);
    const noGit = readSetup({ ...ALL_SET, project: none, git: { found: false } });
    expect(noGit.folder.advice.join(' ')).toMatch(/Git isn’t installed/);
  });

  it('shows the server’s own progress line while downloading or reading, and keeps asking', () => {
    for (const state of ['downloading', 'loading'] as const) {
      const reading = readSetup(withProject({ ok: false, state, detail: 'Reading 1,240 of 3,000 commits' }));
      expect(reading.folder.state).toBe('working');
      expect(reading.folder.headline).toBe('Reading 1,240 of 3,000 commits');
      expect(reading).toMatchObject({ canOpen: false, stillWorking: true });
    }
  });

  it('shows the server’s own sentence when a download fails, and stops asking', () => {
    const reading = readSetup(withProject({ ok: false, state: 'failed', error: 'That address has no repository.' }));
    expect(reading.folder.state).toBe('problem');
    expect(reading.folder.headline).toBe('That address has no repository.');
    expect(reading).toMatchObject({ canOpen: false, stillWorking: false });
  });

  it('offers the app’s own code only when the server says it can', () => {
    expect(readSetup(ALL_SET).ownCode).toBeNull();
    expect(readSetup({ ...ALL_SET, own: { available: false, name: 'Exocortex' } }).ownCode).toBeNull();
    expect(readSetup({ ...ALL_SET, own: { available: true, name: 'Exocortex' } }).ownCode).toEqual({ name: 'Exocortex' });
  });

  it('lists only the other projects that are ready to switch to', () => {
    const status: StandaloneStatus = {
      ...ALL_SET,
      project: { ...ALL_SET.project, id: 'mine', current: true },
      projects: [
        { id: 'mine', name: 'project', state: 'ready', current: true },
        { id: 'own', name: 'Exocortex', state: 'ready' },
        { id: 'half', name: 'still coming', state: 'downloading' },
        { id: 'bad', name: 'broken', state: 'failed' },
      ],
    };
    expect(readSetup(status).otherProjects).toEqual([{ id: 'own', name: 'Exocortex' }]);
    expect(readSetup(ALL_SET).otherProjects).toEqual([]);
  });

  it('reports whether sessions ask first only when the server says, never a guess', () => {
    expect(readSetup(ALL_SET).asksFirst).toBeNull();
    expect(readSetup({ ...ALL_SET, settings: {} }).asksFirst).toBeNull();
    expect(readSetup({ ...ALL_SET, settings: { ask_first: false } }).asksFirst).toBe(false);
    expect(readSetup({ ...ALL_SET, settings: { ask_first: true } }).asksFirst).toBe(true);
    // The idle check is its own setting: one being reported says nothing about the other.
    expect(readSetup({ ...ALL_SET, settings: { ask_first: true } }).checksIdle).toBeNull();
    expect(readSetup({ ...ALL_SET, settings: { idle_check: true } }).checksIdle).toBe(true);
    expect(readSetup({ ...ALL_SET, settings: { idle_check: false } }).asksFirst).toBeNull();
  });

  it('walks the journal step from a new journal to an open Keeper', () => {
    // No journal on this desktop app: no step at all.
    expect(readSetup(ALL_SET).keeper).toBeNull();
    // New journal: the first wake is the setup conversation.
    const fresh = readSetup({ ...ALL_SET, journal: { setup_done: false, keeper: null } }).keeper;
    expect(fresh?.action).toBe('Start the journal');
    expect(fresh?.canStart).toBe(true);
    // Set up, nothing open: wake one.
    expect(readSetup({ ...ALL_SET, journal: { setup_done: true, keeper: null } }).keeper?.action).toBe('Wake the Keeper');
    // One is open: the button goes to it, by its id.
    const openKeeper = readSetup({ ...ALL_SET, journal: { setup_done: true, keeper: '2026-10-06.1' } }).keeper;
    expect(openKeeper?.sessionId).toBe('2026-10-06.1');
    // The Keeper is a session, so it can't be started without Claude Code.
    const noClaude = readSetup({ ...ALL_SET, claude: { found: false }, journal: { setup_done: false, keeper: null } });
    expect(noClaude.keeper?.canStart).toBe(false);
  });

  it('still produces sentences from an empty or missing answer', () => {
    for (const status of [null, {}, { claude: {}, project: {} }] as const) {
      const reading = readSetup(status);
      expect(reading.folder.headline.length).toBeGreaterThan(0);
      expect(reading.claude.headline.length).toBeGreaterThan(0);
      expect(reading.claude.state).toBe('unknown');
      expect(reading.canOpen).toBe(false);
    }
  });
});

describe('whether the first-run screen stands in front of the app', () => {
  const noFolder = withProject({ path: null, ok: false, state: 'none' });

  it('shows nothing until the server has answered', () => {
    expect(setupGate({ status: null, unreachable: false, finishedBefore: false })).toBe('waiting');
    expect(setupGate({ status: null, unreachable: false, finishedBefore: true })).toBe('waiting');
  });

  it('shows the screen to a new person even when everything is already in place', () => {
    expect(setupGate({ status: ALL_SET, unreachable: false, finishedBefore: false })).toBe('setup');
  });

  it('goes straight to the app for someone who finished setup before', () => {
    expect(setupGate({ status: ALL_SET, unreachable: false, finishedBefore: true })).toBe('app');
  });

  it('brings the screen back when the folder is gone', () => {
    expect(setupGate({ status: noFolder, unreachable: false, finishedBefore: true })).toBe('setup');
  });

  it('does not bring the screen back just because Claude Code went missing', () => {
    const status = withClaude({ found: false });
    expect(setupGate({ status, unreachable: false, finishedBefore: true })).toBe('app');
  });

  it('never locks a returning person out when the check itself fails', () => {
    expect(setupGate({ status: null, unreachable: true, finishedBefore: true })).toBe('app');
    expect(setupGate({ status: null, unreachable: true, finishedBefore: false })).toBe('setup');
  });
});

describe('telling an address from something else', () => {
  it('accepts the usual git addresses', () => {
    for (const address of [
      'https://github.com/someone/project',
      'https://gitlab.com/group/sub/project.git',
      'git@github.com:someone/project.git',
      'ssh://git@example.org/someone/project',
      '  https://github.com/someone/project  ',
    ]) {
      expect(looksLikeRepoAddress(address), address).toBe(true);
    }
  });

  it('refuses blanks, local paths and half-typed addresses', () => {
    for (const text of ['', '   ', '/home/someone/project', 'github.com', 'https://github.com', 'someone/project', 'two words https://github.com/a/b']) {
      expect(looksLikeRepoAddress(text), text).toBe(false);
    }
  });
});

describe('walking into a folder in the in-page folder list', () => {
  it('joins with the separator the path already uses, never doubling it at a root', () => {
    expect(childFolderPath('/home/someone', 'projects')).toBe('/home/someone/projects');
    expect(childFolderPath('/', 'home')).toBe('/home');
    expect(childFolderPath('C:\\Users\\someone', 'projects')).toBe('C:\\Users\\someone\\projects');
    expect(childFolderPath('C:\\', 'Users')).toBe('C:\\Users');
  });
});

describe('the switches, which are only drawn for settings the server reports', () => {
  it('reads each setting the server names and leaves the rest unknown', () => {
    const none = readSetup({ settings: {} });
    expect([none.asksFirst, none.checksIdle, none.rollsOver]).toEqual([null, null, null]);
    const all = readSetup({ settings: { ask_first: false, idle_check: true, keeper_rollover: true } });
    expect([all.asksFirst, all.checksIdle, all.rollsOver]).toEqual([false, true, true]);
  });
});
