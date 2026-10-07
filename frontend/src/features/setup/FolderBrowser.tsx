/**
 * FolderBrowser.tsx — a folder picker drawn in the page, for the first-run
 * screen's "a folder on this computer".
 *
 * A web page can't ask the browser for a folder's full path, and the desktop
 * window's own choose-a-folder dialog only exists inside that window. So the
 * desktop server lists folders instead (GET /api/standalone/folders), and
 * this file draws that list: where you are, a way up, and one button per
 * folder inside. It starts in the home folder. Hidden folders are not listed.
 *
 * It doesn't choose anything itself. Every step tells the first-run screen
 * the folder now open (`onLook`), which puts that path in the screen's own
 * box; the screen's "Use this folder" button is still what sends it.
 *
 * Touches: setupApi.ts (listFolders), setupCheck.ts (childFolderPath),
 * FirstRunPage.tsx (shows this under the path box).
 *
 * Prompt that produced it: "paste an address or point to one in your library
 * maybe" — the library being, in her later words, GitHub projects and folders
 * on the computer both.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { childFolderPath } from './setupCheck';
import { listFolders, type FolderListing } from './setupApi';
import styles from './FirstRunPage.module.css';

export function FolderBrowser({
  startPath,
  onLook,
  disabled,
}: {
  /** Where to open. Empty opens the home folder. */
  startPath: string;
  /** Called with each folder as it is opened. */
  onLook: (path: string) => void;
  disabled: boolean;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [looking, setLooking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /** Open one folder: ask the server what's inside and show it. A folder
   * that can't be opened leaves the last good list on screen, with the
   * server's sentence above it. */
  const look = (path: string, report: boolean) => {
    setLooking(true);
    setRefusal(null);
    listFolders(path)
      .then((answer) => {
        setListing(answer);
        if (report) onLook(answer.path);
      })
      .catch((error: unknown) => {
        setRefusal(error instanceof ApiError && error.message ? error.message : 'Couldn’t reach the app’s server.');
      })
      .finally(() => setLooking(false));
  };

  // Open on the path already in the box, or the home folder. If that path
  // isn't a folder (half-typed, say), fall back to home rather than show
  // nothing. The box is left alone on this first look: nothing was picked.
  useEffect(() => {
    let alive = true;
    setLooking(true);
    listFolders(startPath)
      .catch(() => listFolders(''))
      .then((answer) => {
        if (alive) setListing(answer);
      })
      .catch((error: unknown) => {
        if (alive) setRefusal(error instanceof ApiError && error.message ? error.message : 'Couldn’t reach the app’s server.');
      })
      .finally(() => {
        if (alive) setLooking(false);
      });
    return () => {
      alive = false;
    };
    // Only on opening: later typing in the box shouldn't move the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blocked = disabled || looking;

  return (
    <div className={styles.browser}>
      {refusal ? (
        <div className={styles.refusal} role="alert">
          {refusal}
        </div>
      ) : null}
      {listing ? (
        <>
          <div className={styles.browserHere}>
            <span className={styles.browserPath}>{listing.path}</span>
            {listing.parent ? (
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => look(listing.parent as string, true)}
                disabled={blocked}
              >
                ↑ Up
              </button>
            ) : null}
          </div>
          <p className={styles.hint}>
            {listing.git
              ? 'This folder holds a git project. Press “Use this folder” to draw it.'
              : 'No git project in this folder itself. Open the one that holds your project.'}
          </p>
          {listing.folders.length > 0 ? (
            <ul className={styles.repoList}>
              {listing.folders.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className={styles.repoBtn}
                    onClick={() => look(childFolderPath(listing.path, name), true)}
                    disabled={blocked}
                  >
                    <span className={styles.repoName}>{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>No folders inside this one.</p>
          )}
        </>
      ) : looking ? (
        <p className={styles.hint}>Looking…</p>
      ) : null}
    </div>
  );
}
