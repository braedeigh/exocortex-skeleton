import { useMemo, useState } from 'react';
import { ConfirmModal } from './ConfirmModal';
import { DeityEditor } from './DeityEditor';
import { deityDisplayName, parseDeityMantra, sortProfiles } from './deityHelpers';
import { deityMdToHtml } from './deityMarkdown';
import type { DeityProfile } from './types';
import { useDeityActions } from './useMeditationData';
import styles from './DeitiesView.module.css';

type DeityView =
  | { mode: 'list' }
  | { mode: 'detail'; id: string }
  | { mode: 'new' }
  | { mode: 'edit'; id: string };

export interface DeitiesViewProps {
  profiles: DeityProfile[];
  onError: (message: string) => void;
}

/**
 * The Deities sub-app — port of renderDeities() and friends: a list of
 * profile cards -> markdown detail (with links) -> paste-markdown editor.
 * View state is in-memory only (the old window._deityView also reset to the
 * list on every page load). Deletion goes through the shared ConfirmModal
 * instead of the old native confirm(), keeping the two-step confirm.
 */
export function DeitiesView({ profiles, onError }: DeitiesViewProps) {
  const [view, setView] = useState<DeityView>({ mode: 'list' });
  const [pendingDelete, setPendingDelete] = useState<DeityProfile | null>(null);
  const actions = useDeityActions(onError);

  const sorted = useMemo(() => sortProfiles(profiles), [profiles]);

  async function handleSave(id: string | null, payload: Parameters<typeof actions.save>[1]) {
    const finalId = await actions.save(id, payload);
    setView({ mode: 'detail', id: finalId });
  }

  if (view.mode === 'new' || view.mode === 'edit') {
    const editing = view.mode === 'edit' ? profiles.find((p) => p.id === view.id) || null : null;
    return (
      <DeityEditor
        profile={editing}
        onSave={handleSave}
        onCancel={() => setView(editing ? { mode: 'detail', id: editing.id } : { mode: 'list' })}
        onError={onError}
      />
    );
  }

  if (view.mode === 'detail') {
    const p = profiles.find((x) => x.id === view.id);
    if (!p) {
      // Profile vanished (deleted elsewhere) — fall back to the list like
      // the old _deityRenderDetail did.
      return renderList();
    }
    return (
      <div>
        <div className={styles.detailBar}>
          <button type="button" className={styles.barBtn} onClick={() => setView({ mode: 'list' })}>
            &larr; All deities
          </button>
          <div className={styles.barGroup}>
            <button type="button" className={styles.barBtn} onClick={() => setView({ mode: 'edit', id: p.id })}>
              Edit
            </button>
            <button type="button" className={`${styles.barBtn} ${styles.barBtnDanger}`} onClick={() => setPendingDelete(p)}>
              Delete
            </button>
          </div>
        </div>
        {p.body ? (
          <div className={styles.mdBody} dangerouslySetInnerHTML={{ __html: deityMdToHtml(p.body) }} />
        ) : (
          <div className={styles.empty}>(empty)</div>
        )}
        {Array.isArray(p.links) && p.links.length ? (
          <div className={styles.linksSection}>
            <div className={styles.linksLabel}>Links</div>
            {p.links.map((l, i) => (
              <div className={styles.linkItem} key={l.id || i}>
                <a className={styles.linkAnchor} href={l.url || '#'} target="_blank" rel="noopener noreferrer">
                  {l.title || l.url || 'Link'}
                </a>
                {l.description ? <div className={styles.linkDesc}>{l.description}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {deleteModal()}
      </div>
    );
  }

  return renderList();

  function renderList() {
    return (
      <div>
        <button type="button" className={styles.newBtn} onClick={() => setView({ mode: 'new' })}>
          + New deity
        </button>
        {sorted.length === 0 ? (
          <div className={styles.emptyList}>No deity profiles yet. Add one above.</div>
        ) : (
          sorted.map((p) => {
            const mantra = p.mantra || parseDeityMantra(p.body);
            return (
              <button
                type="button"
                className={styles.profileCard}
                key={p.id}
                onClick={() => setView({ mode: 'detail', id: p.id })}
              >
                <div className={styles.profileName}>{deityDisplayName(p)}</div>
                {mantra ? <div className={styles.profileMantra}>{mantra}</div> : null}
              </button>
            );
          })
        )}
        {deleteModal()}
      </div>
    );
  }

  function deleteModal() {
    return (
      <ConfirmModal
        open={!!pendingDelete}
        text={
          pendingDelete ? (
            <>
              Delete the &ldquo;<b>{deityDisplayName(pendingDelete)}</b>&rdquo; deity profile? This can&rsquo;t be
              undone.
            </>
          ) : null
        }
        confirmLabel="Yes, delete"
        onConfirm={() => {
          if (pendingDelete) actions.remove(pendingDelete.id);
          setPendingDelete(null);
          setView({ mode: 'list' });
        }}
        onCancel={() => setPendingDelete(null)}
      />
    );
  }
}
