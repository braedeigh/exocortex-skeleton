import { useCallback, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { parsePersonalitySections, sectionIsEmpty } from './personalityDoc';
import { SectionDetail } from './SectionDetail';
import { usePersonalityDoc, useSaveSection } from './usePersonalityData';
import styles from './PersonalityPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * /personality — port of templates/personality.html: the goal-personality.md
 * doc split into ## section cards (with <!-- summary: --> annotations shown
 * on the cards), each opening into a Read/Edit detail with debounced
 * whole-doc autosave. The legacy page's inline dev-notes footer becomes the
 * shared floating NotesPill on the same 'personality' dev-notes bucket
 * (/api/devnotes/personality), like every other native page; its "← back /
 * Goal Personality" title bar is dropped — the SPA shell owns navigation.
 */
export function PersonalityPage() {
  const isPublic = isPublicMode();

  const docQuery = usePersonalityDoc(!isPublic);
  const saveSection = useSaveSection();
  const { toasts, push, dismiss } = useToasts();

  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const docMd = docQuery.data?.content ?? '';
  const sections = useMemo(() => parsePersonalitySections(docMd), [docMd]);

  // An edit can dissolve the open section (heading deleted → fewer sections);
  // fall back to the list instead of a dead detail view.
  const openSection = openIdx !== null ? sections[openIdx] : undefined;

  const save = useCallback(
    (newBlock: string) => {
      if (openIdx === null) return Promise.reject(new Error('No section open'));
      return saveSection(openIdx, newBlock);
    },
    [saveSection, openIdx],
  );

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>The personality doc isn&rsquo;t available here.</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.titleBar}>
          <span className={styles.title}>Goal Personality</span>
        </div>

        {openSection && openIdx !== null ? (
          <SectionDetail key={openIdx} section={openSection} save={save} onBack={() => setOpenIdx(null)} />
        ) : (
          <div className={styles.sectionsView}>
            {docQuery.isLoading ? (
              <p className={styles.emptyMsg}>Loading&hellip;</p>
            ) : docQuery.isError ? (
              <p className={styles.emptyMsg}>Load error</p>
            ) : sections.length === 0 ? (
              <p className={styles.emptyMsg}>No sections found. Add ## headings via Edit on a section.</p>
            ) : (
              sections.map((sec, i) => {
                const isEmpty = sectionIsEmpty(sec);
                return (
                  <button type="button" key={i} className={styles.sectionCard} onClick={() => setOpenIdx(i)}>
                    <span className={styles.scTitle}>
                      <span>{sec.title}</span>
                      <span className={styles.scChev}>&rsaquo;</span>
                    </span>
                    {sec.summary ? (
                      // Legacy parity: the summary annotation was injected as
                      // raw HTML, so inline markup in it keeps rendering.
                      <span className={styles.scSummary} dangerouslySetInnerHTML={{ __html: sec.summary }} />
                    ) : (
                      <span className={styles.scSummary}>
                        <em>{isEmpty ? 'Empty section.' : 'No summary yet.'}</em>
                      </span>
                    )}
                    {isEmpty ? <span className={styles.scEmpty}>Empty &mdash; tap to fill</span> : null}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Dev notes about this page land in the legacy 'personality' bucket. */}
      {!openSection ? <NotesPill tab="personality" onError={push} /> : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
