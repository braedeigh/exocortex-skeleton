import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { addBuild, BUILDS_KEY, refreshBuild, removeBuild, useBuilds } from './buildsApi';
import { summaryLine, type BuildInfo } from './buildReport';
import styles from './TerrainBuildsView.module.css';

/**
 * TerrainBuildsView — the Builds room: every other git folder Terrain can
 * map, one card each, and the box that adds another.
 *
 * The main map covers the two folders this system is made of. A BUILD is
 * anything else — a project built in its own directory on this machine, or a
 * repo cloned from GitHub. Tapping a card opens that build's own map
 * (/terrain/files?build=<id>), which carries a written report of what happened
 * in it beside the dots (BuildReport.tsx). A build never joins the main map.
 *
 * Adding takes one line: a GitHub repo address (cloned in the background —
 * the card reads "cloning…" and flips by itself when the folder lands) or the
 * full path of a git folder already here. A refusal from the server is a
 * sentence, shown as written under the box.
 *
 * Removing asks first, and only takes the build off this list — the folder on
 * disk stays exactly as it is, and the confirm says so.
 *
 * Reads GET /api/observatory/terrain/builds (buildsApi.ts). Owner only: the
 * route redirects a visitor away before this mounts.
 *
 * Prompt that produced it: "ideally this becomes something where I can port
 * any repo into it from GitHub and see when it was built or edited. And I can
 * view all my builds in here separately."
 */

const STATE_NOTE: Record<BuildInfo['state'], string> = {
  ready: '',
  cloning: 'Cloning from GitHub…',
  failed: 'The clone failed',
  missing: 'The folder isn’t there',
};

export function TerrainBuildsView() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useBuilds();
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Which card has a request in flight, and what the last one said — kept per
  // build so one card's "pull failed" doesn't print under another.
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const reload = () => queryClient.invalidateQueries({ queryKey: BUILDS_KEY });

  // Add a build. The box is cleared only when the server took it, so a
  // refused address is still there to fix.
  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    const text = source.trim();
    if (!text || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await addBuild(text);
      setSource('');
      await reload();
    } catch (error) {
      setAddError(error instanceof ApiError ? error.message : 'Couldn’t add that.');
    } finally {
      setAdding(false);
    }
  };

  // Refresh one build: pull a clone, or restart a clone that failed.
  const onRefresh = async (build: BuildInfo) => {
    setBusy(build.id);
    try {
      const result = await refreshBuild(build.id);
      setNotes((prev) => ({ ...prev, [build.id]: result.detail ?? 'Up to date' }));
      await reload();
    } catch (error) {
      setNotes((prev) => ({
        ...prev,
        [build.id]: error instanceof ApiError ? error.message : 'Refresh failed.',
      }));
    } finally {
      setBusy(null);
    }
  };

  // Destructive actions confirm first — and say what is NOT being destroyed.
  const onRemove = async (build: BuildInfo) => {
    const ok = window.confirm(
      `Take “${build.name}” off the Builds list?\n\nOnly the list entry goes. The folder at ${build.root} stays exactly as it is.`,
    );
    if (!ok) return;
    setBusy(build.id);
    try {
      await removeBuild(build.id);
      await reload();
    } catch (error) {
      setNotes((prev) => ({
        ...prev,
        [build.id]: error instanceof ApiError ? error.message : 'Couldn’t remove it.',
      }));
    } finally {
      setBusy(null);
    }
  };

  const builds = data?.builds ?? [];

  return (
    <section className={styles.view} aria-label="Builds">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Builds</h2>
          <p className={styles.sub}>
            Other folders, each read as its own map and a report of what happened in it.
          </p>
        </div>
        <Link to="/terrain/files" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      <form className={styles.addRow} onSubmit={onAdd}>
        <input
          className={styles.input}
          type="text"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="https://github.com/owner/repo  or  /full/path/to/a/folder"
          aria-label="A GitHub repo address or a folder path"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" className={styles.add} disabled={adding || !source.trim()}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>
      {addError ? <p className={styles.error}>{addError}</p> : null}

      {isLoading ? <p className={styles.note}>Loading…</p> : null}
      {isError ? <p className={styles.note}>Couldn&rsquo;t load the builds.</p> : null}
      {data && builds.length === 0 ? (
        <p className={styles.note}>
          No builds yet. Paste a GitHub repo address or a folder path above to add the first one.
        </p>
      ) : null}

      <ul className={styles.list}>
        {builds.map((build) => (
          <li key={build.id} className={styles.card}>
            {/* The card's body is the door: a ready build opens its map. One
                that isn't ready has no map worth opening, so it is plain text. */}
            {build.state === 'ready' ? (
              <Link to="/terrain/files" search={{ build: build.id }} className={styles.open}>
                <span className={styles.name}>{build.name}</span>
                <span className={styles.line}>{summaryLine(build.summary)}</span>
                <span className={styles.where}>{build.source ?? build.root}</span>
              </Link>
            ) : (
              <div className={styles.open}>
                <span className={styles.name}>{build.name}</span>
                <span className={styles.line}>{STATE_NOTE[build.state]}</span>
                {build.detail ? <span className={styles.detail}>{build.detail}</span> : null}
                <span className={styles.where}>{build.source ?? build.root}</span>
              </div>
            )}
            <div className={styles.actions}>
              {/* Pulling only means something for a clone; a local folder is
                  somebody's working copy and is re-read every time it's opened. */}
              {build.source && build.state !== 'cloning' ? (
                <button
                  type="button"
                  className={styles.action}
                  disabled={busy === build.id}
                  onClick={() => void onRefresh(build)}
                >
                  {build.state === 'ready' ? 'Pull' : 'Try again'}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.action}
                disabled={busy === build.id}
                onClick={() => void onRemove(build)}
              >
                Remove
              </button>
            </div>
            {notes[build.id] ? <p className={styles.cardNote}>{notes[build.id]}</p> : null}
          </li>
        ))}
      </ul>

      {data ? <p className={styles.foot}>Clones from GitHub are kept in {data.clone_dir}</p> : null}
    </section>
  );
}
