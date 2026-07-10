/**
 * Reader.tsx — the library reader overlay: one research/*.md file rendered
 * read-only with the shared tiny markdown renderer (the old page used
 * md.js's mdToHtml; features/journal/markdown.ts is its verbatim port). The
 * ✎ head button jumps into the annotator over the same file (note:<path>).
 */

import { useQuery } from '@tanstack/react-query';
import { getLibraryFile } from './api';
import readerStyles from './Reader.module.css';
import { mdToHtml } from '../journal/markdown';

export interface ReaderProps {
  path: string;
  onAnnotate: (doc: string, title: string) => void;
  onClose: () => void;
}

export function Reader({ path, onAnnotate, onClose }: ReaderProps) {
  const query = useQuery({
    queryKey: ['research', 'library-file', path],
    queryFn: ({ signal }) => getLibraryFile(path, signal),
    staleTime: 0,
  });

  const title = query.data?.title || path;

  return (
    <div
      className={readerStyles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={readerStyles.panel}>
        <div className={readerStyles.head}>
          <div className={readerStyles.headText}>
            <div className={readerStyles.title}>{title}</div>
            <div className={readerStyles.file}>{path}</div>
          </div>
          <button
            type="button"
            className={readerStyles.annotateBtn}
            title="Annotate this file"
            aria-label="Annotate"
            onClick={() => onAnnotate(`note:${path}`, title)}
          >
            &#9998;
          </button>
          <button type="button" className={readerStyles.headBtn} title="Close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        {query.isLoading ? (
          <div className={readerStyles.loading}>Loading&hellip;</div>
        ) : query.isError ? (
          <div className={readerStyles.loading}>Could not open file.</div>
        ) : (
          <div className={readerStyles.body} dangerouslySetInnerHTML={{ __html: mdToHtml(query.data?.text ?? '') }} />
        )}
      </div>
    </div>
  );
}
