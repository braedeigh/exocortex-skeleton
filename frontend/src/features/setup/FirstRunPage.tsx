/**
 * FirstRunPage.tsx — what a new person sees when the desktop app opens for
 * the first time, and what the Setup tab shows afterwards.
 *
 * Two steps, each a card:
 *
 *   1. Code to draw — start with this app's own code (the first option, when
 *      the server offers it), pick a folder already on this computer, or
 *      download a project from its git address. Terrain draws it from its git
 *      history, so there is something to look at before any session has run.
 *   2. Claude Code — is it installed and signed in? Every session's reply is
 *      Claude Code running on this machine, so without it the app can show
 *      the map but nothing can answer. This screen only checks and explains;
 *      it doesn't install anything or sign anyone in.
 *
 * Under them, one notice a new person has to see before starting anything:
 * sessions act without asking, with the switch to make them ask first.
 *
 * The wording for both steps comes from setupCheck.ts; this file only draws it and
 * sends the two requests. "Open the app" turns on once there is a folder.
 *
 * The folder button uses the desktop window's own choose-a-folder dialog when
 * the page is inside that window (window.exoDesktop.chooseFolder). In a plain
 * browser there is no such dialog — a web page can't learn a folder's full
 * path — so the box to type or paste a path is always there as well.
 *
 * Touches: setupCheck.ts (the words), setupApi.ts (the calls),
 * routes/__root.tsx (shows this before the app), routes/observatory_.setup.tsx
 * (shows it again later).
 *
 * Prompts that produced it: "What would it take to turn the observatory and
 * terrain into a downloadable desktop app?", "I will also need something to
 * download a repo with their commit data so they can visual something right
 * off the bat", and "I want the file they interact with first to be the
 * exocortex files.".
 */
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { CLAUDE_CODE_LINK, looksLikeRepoAddress, readSetup, type SetupStep, type StepState } from './setupCheck';
import { markSetupFinished, useProjectActions, useStandaloneStatus } from './setupApi';
import { listGithubRepos, type GithubRepo } from './setupApi';
import styles from './FirstRunPage.module.css';

/** The mark each state wears, beside its headline. Never colour alone. */
const STATE_MARK: Record<StepState, string> = {
  done: '✓',
  todo: '○',
  working: '…',
  problem: '!',
  unknown: '?',
};

const STATE_WORD: Record<StepState, string> = {
  done: 'Ready',
  todo: 'To do',
  working: 'Working',
  problem: 'Needs you',
  unknown: 'Not sure',
};

/** One step's standing: its mark, its headline, and what to do about it. */
function StepStanding({ step }: { step: SetupStep }) {
  return (
    <div className={styles.standing}>
      <div className={styles.headlineRow}>
        <span className={[styles.mark, styles[`mark_${step.state}`]].join(' ')} title={STATE_WORD[step.state]}>
          <span aria-hidden="true">{STATE_MARK[step.state]}</span>
          <span className={styles.srOnly}>{STATE_WORD[step.state]}:</span>
        </span>
        <span className={styles.headline}>{step.headline}</span>
      </div>
      {step.advice.length > 0 ? (
        <ol className={styles.advice}>
          {step.advice.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function FirstRunPage({
  onOpen,
  appName,
  returning = false,
}: {
  /** Called when the person presses "Open the app". */
  onOpen: () => void;
  appName?: string;
  /** Opened from the Setup tab rather than on first launch. */
  returning?: boolean;
}) {
  const statusQuery = useStandaloneStatus(true);
  const { drawOwnCode, drawProject, drawFolder, download, setAsksFirst, setChecksIdle } = useProjectActions();
  const status = statusQuery.data ?? null;
  const reading = readSetup(status);
  const unreachable = statusQuery.isError && !status;

  const [folderPath, setFolderPath] = useState('');
  const [address, setAddress] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The GitHub picker: the account typed, and its projects once listed
  // (null = not asked yet, so "none found" is only said after an answer).
  const [githubUser, setGithubUser] = useState('');
  const [githubRepos, setGithubRepos] = useState<GithubRepo[] | null>(null);
  const [listing, setListing] = useState(false);

  const hasNativeDialog = typeof window.exoDesktop?.chooseFolder === 'function';
  const busy = sending || reading.stillWorking;

  /** Send one of the two requests and show the server's own sentence if it
   * refuses (a missing folder, a bad address). */
  const send = (request: Promise<unknown>) => {
    setSending(true);
    setRefusal(null);
    request
      .catch((error: unknown) => {
        setRefusal(error instanceof ApiError && error.message ? error.message : 'Couldn’t reach the app’s server.');
      })
      .finally(() => setSending(false));
  };

  /** List a GitHub account's public projects under the box. A refusal (no
   * such account, no network) shows the server's sentence like any other. */
  const listRepos = () => {
    setListing(true);
    setRefusal(null);
    setGithubRepos(null);
    listGithubRepos(githubUser.trim())
      .then(setGithubRepos)
      .catch((error: unknown) => {
        setRefusal(error instanceof ApiError && error.message ? error.message : 'Couldn’t reach the app’s server.');
      })
      .finally(() => setListing(false));
  };

  /** Ask the desktop window for a folder, then use it. Cancelling the dialog
   * changes nothing. */
  const chooseWithDialog = () => {
    const choose = window.exoDesktop?.chooseFolder;
    if (!choose) return;
    void choose({ title: 'Choose a code folder' }).then((path) => {
      if (!path) return;
      setFolderPath(path);
      send(drawFolder(path));
    });
  };

  const open = () => {
    markSetupFinished();
    onOpen();
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1 className={styles.title}>{returning ? 'Setup' : `Welcome to ${appName || 'the app'}`}</h1>
        <p className={styles.lede}>
          Two things to set up: some code for the map to draw, and Claude Code so sessions can answer.
        </p>

        {unreachable ? (
          <div className={styles.notice} role="alert">
            Couldn’t reach the setup check. The steps below can’t be confirmed right now.
            <button type="button" className={styles.quietBtn} onClick={() => void statusQuery.refetch()}>
              Try again
            </button>
          </div>
        ) : null}

        <section className={styles.card} aria-labelledby="setup-folder">
          <h2 className={styles.cardTitle} id="setup-folder">
            1. Code to draw
          </h2>
          <StepStanding step={reading.folder} />

          {reading.ownCode ? (
            <div className={styles.choice}>
              <div className={styles.label}>Start here</div>
              <div className={styles.row}>
                <button type="button" className={styles.primaryBtn} onClick={() => send(drawOwnCode())} disabled={busy}>
                  Start with {reading.ownCode.name}’s own code
                </button>
              </div>
              <p className={styles.hint}>
                The code of the app you’re looking at, with its history. Nothing to find or type.
              </p>
            </div>
          ) : null}

          <div className={styles.choice}>
            <label className={styles.label} htmlFor="setup-folder-path">
              {reading.ownCode ? 'Or a folder on this computer' : 'A folder on this computer'}
            </label>
            <div className={styles.row}>
              <input
                id="setup-folder-path"
                className={styles.input}
                placeholder="/home/you/projects/my-project"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
              />
              {hasNativeDialog ? (
                <button type="button" className={styles.secondaryBtn} onClick={chooseWithDialog} disabled={busy}>
                  Browse…
                </button>
              ) : null}
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => send(drawFolder(folderPath.trim()))}
                disabled={busy || !folderPath.trim()}
              >
                Use this folder
              </button>
            </div>
          </div>

          <div className={styles.choice}>
            <label className={styles.label} htmlFor="setup-address">
              Or download a project from its git address
            </label>
            <div className={styles.row}>
              <input
                id="setup-address"
                className={styles.input}
                placeholder="https://github.com/someone/project"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
              />
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => send(download(address.trim()))}
                disabled={busy || !looksLikeRepoAddress(address)}
              >
                Download
              </button>
            </div>
            <p className={styles.hint}>Its whole history comes with it, so the map has something to show at once.</p>
          </div>

          {/* Her ask: "paste an address or point to one in your library". The
              library here is a GitHub account's public projects; each button
              downloads that project the same way a pasted address does. */}
          <div className={styles.choice}>
            <label className={styles.label} htmlFor="setup-github-user">
              Or pick one from a GitHub account
            </label>
            <div className={styles.row}>
              <input
                id="setup-github-user"
                className={styles.input}
                placeholder="GitHub username"
                value={githubUser}
                onChange={(event) => setGithubUser(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && githubUser.trim() && !listing) listRepos();
                }}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
              />
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={listRepos}
                disabled={busy || listing || !githubUser.trim()}
              >
                {listing ? 'Looking…' : 'Show projects'}
              </button>
            </div>
            {githubRepos && githubRepos.length === 0 ? (
              <p className={styles.hint}>No public projects on that account.</p>
            ) : null}
            {githubRepos && githubRepos.length > 0 ? (
              <ul className={styles.repoList}>
                {githubRepos.map((repo) => (
                  <li key={repo.url}>
                    <button
                      type="button"
                      className={styles.repoBtn}
                      onClick={() => send(download(repo.url))}
                      disabled={busy}
                    >
                      <span className={styles.repoName}>{repo.name}</span>
                      {repo.description ? <span className={styles.repoAbout}>{repo.description}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {reading.otherProjects.length > 0 ? (
            <div className={styles.choice}>
              <div className={styles.label}>Or one that’s already here</div>
              <div className={styles.row}>
                {reading.otherProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => send(drawProject(project.id))}
                    disabled={busy}
                  >
                    Draw {project.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {refusal ? (
            <div className={styles.refusal} role="alert">
              {refusal}
            </div>
          ) : null}
        </section>

        <section className={styles.card} aria-labelledby="setup-claude">
          <h2 className={styles.cardTitle} id="setup-claude">
            2. Claude Code
          </h2>
          <StepStanding step={reading.claude} />
          <div className={styles.row}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => void statusQuery.refetch()}
              disabled={statusQuery.isFetching}
            >
              {statusQuery.isFetching ? 'Checking…' : 'Check again'}
            </button>
            {reading.claude.state !== 'done' ? (
              <a className={styles.link} href={CLAUDE_CODE_LINK} target="_blank" rel="noopener noreferrer">
                About Claude Code ↗
              </a>
            ) : null}
          </div>
        </section>

        {/* The settings card. Each switch is drawn only when the server
            reported that setting, so an older server shows fewer switches
            instead of a guessed one. */}
        {reading.asksFirst !== null || reading.checksIdle !== null ? (
          <section className={styles.card} aria-labelledby="setup-behaviour">
            <h2 className={styles.cardTitle} id="setup-behaviour">
              How sessions behave
            </h2>
            {reading.asksFirst !== null ? (
              <>
                <p className={styles.plain}>
                  {reading.asksFirst
                    ? 'A session stops and asks you before it changes a file or runs a command.'
                    : 'A session acts without asking: it can change files and run commands in the folder it works in, on its own.'}
                </p>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={reading.asksFirst}
                    onChange={(event) => send(setAsksFirst(event.target.checked))}
                    disabled={sending}
                  />
                  <span>Ask me first</span>
                </label>
                <p className={styles.hint}>Applies to sessions you start from now on. You can change it here any time.</p>
              </>
            ) : null}
            {/* Her ask: "on by default with the option to turn it off next to it". */}
            {reading.checksIdle !== null ? (
              <>
                <p className={styles.plain}>
                  {reading.checksIdle
                    ? 'A session left alone for a day gets one message asking whether its job is over. If it is, the session closes itself.'
                    : 'A session left alone stays open until you close it. Nothing checks on it.'}
                </p>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={reading.checksIdle}
                    onChange={(event) => send(setChecksIdle(event.target.checked))}
                    disabled={sending}
                  />
                  <span>Check on idle sessions</span>
                </label>
              </>
            ) : null}
          </section>
        ) : null}

        <div className={styles.finish}>
          <button
            type="button"
            className={styles.openBtn}
            onClick={open}
            disabled={!reading.canOpen && !unreachable}
          >
            {returning ? 'Back to the app' : 'Open the app'}
          </button>
          {!reading.canOpen && !unreachable ? (
            <p className={styles.hint}>Choose or download a code folder first.</p>
          ) : !reading.canChat ? (
            <p className={styles.hint}>
              You can look around the map now. Sessions can’t answer until Claude Code is installed and signed in.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
