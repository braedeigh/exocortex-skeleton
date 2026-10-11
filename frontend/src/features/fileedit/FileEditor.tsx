/**
 * FileEditor — one file as a text box she can change and save.
 *
 * What this is, in plain English: the /code page shows a file read-only; its
 * Edit button swaps the code for this. It reads the whole file fresh from disk
 * (routes/file_edit.py), she types, and Save writes it back. If something else
 * changed the file while she had it open (an agent, most likely), the save is
 * refused rather than replacing that change, and she is offered the file as it
 * is now.
 *
 * It also opens settings files the read-only view refuses, such as `.env`.
 * That is the point of it: a session asks her to fill in a key, and she types
 * it here instead of into a chat.
 *
 * Used by: features/terrain/FileCodePage.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { Button } from '../../ui';
import { FILE_REQUESTS_KEY, readFile, saveFile } from './fileEditApi';
import styles from './FileEditor.module.css';

export function FileEditor({ repo, path, onDone }: { repo: string; path: string; onDone: () => void }) {
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState<{ content: string; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const dirty = loaded !== null && text !== loaded.content;

  // Read the file as it is on disk now. Runs when the editor opens, and again
  // when she asks for the newer version after a refused save.
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setMessage('');
      setConflict(false);
      try {
        const file = await readFile(repo, path, signal);
        setLoaded({ content: file.content, version: file.version });
        setText(file.content);
      } catch (err) {
        if (signal?.aborted) return;
        setMessage(err instanceof Error ? `Can’t open this file: ${err.message}.` : 'Can’t open this file.');
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [repo, path],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Warn before the tab closes with unsaved changes. The browser shows its
  // own wording; all this does is ask for the prompt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Save, then say plainly what happened. A file that changed on disk keeps
  // her text in the box and offers the newer file; nothing was written.
  async function save() {
    if (!loaded) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await saveFile(repo, path, text, loaded.version);
      setLoaded({ content: text, version: result.version });
      setMessage(
        result.woken > 0 ? 'Saved. The session that asked has been told.' : 'Saved.',
      );
      // The read-only view and the request card both show what is now stale.
      void client.invalidateQueries({ queryKey: ['terrain-file', repo, path] });
      void client.invalidateQueries({ queryKey: FILE_REQUESTS_KEY });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setMessage('Not saved: this file changed on disk while you had it open.');
      } else {
        setMessage(err instanceof Error ? `Not saved: ${err.message}.` : 'Not saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  // Leaving with unsaved changes confirms first.
  function done() {
    if (dirty && !window.confirm('Leave without saving your changes?')) return;
    onDone();
  }

  return (
    <div className={styles.editor}>
      <textarea
        className={styles.text}
        aria-label={`Contents of ${path}`}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        disabled={loaded === null}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.bar}>
        <Button type="button" disabled={busy || !dirty || conflict} data-track="file-edit-save" onClick={() => void save()}>
          {busy && loaded ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="secondary" data-track="file-edit-done" onClick={done}>
          {dirty ? 'Cancel' : 'Done'}
        </Button>
        {conflict ? (
          <Button
            type="button"
            variant="secondary"
            data-track="file-edit-reload"
            onClick={() => {
              if (window.confirm('Load the file as it is now? What you typed here will be lost.')) void load();
            }}
          >
            Load the newer file
          </Button>
        ) : null}
        {message ? <p className={styles.message}>{message}</p> : null}
      </div>
    </div>
  );
}
