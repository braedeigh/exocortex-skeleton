/**
 * SourcePdf.tsx — a "📄 PDF" button beside a study, opening the study's own
 * PDF right there at the highlighted passage that backs the number.
 *
 * What this file does: asks the server whether the commons holds this
 * source's PDF and which page each passage is on (GET
 * /api/exposure/sources/<id>/pdf-info, routes/exposure.py). If it does, shows
 * a button; a tap opens ./PdfPassage.tsx below it, at the passage's page with
 * the passage highlighted, and a second tap closes it. A source with no PDF
 * (a web article) shows nothing — its link still opens the original.
 *
 * Used by features/research/FoodPage.tsx (the evidence list's studies) and
 * features/research/TableDetail.tsx (the study behind a number). The Claims
 * page has its own fuller source pane (features/research/ClaimsPage.tsx).
 *
 * Prompt that produced this file: "i want pdfs to be downloaded so they can
 * pop up next to the claim and highlight exactly where in the claim that it
 * was" — carried from the Claims page to every place a study is listed.
 */
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { getSourcePdfInfo } from './api';
import styles from './SourcePdf.module.css';

// The PDF viewer (and pdf.js with it) loads only when a PDF is opened.
const PdfPassage = lazy(() => import('./PdfPassage').then((module) => ({ default: module.PdfPassage })));

export function SourcePdf({
  sourceId,
  passage,
}: {
  sourceId: string;
  passage: { id: string; exact: string | null } | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Same query key as the Claims page, so a PDF checked there isn't asked about twice.
  const info = useQuery({
    queryKey: ['exposure', 'source-pdf', sourceId],
    queryFn: ({ signal }) => getSourcePdfInfo(sourceId, signal),
    staleTime: 60_000,
  });
  if (!info.data?.pdf) return null;
  const page = passage ? (info.data.passages?.[passage.id] ?? null) : null;

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '× close the PDF' : passage ? '📄 PDF, at the passage' : '📄 PDF'}
      </button>
      {open ? (
        <div className={styles.pane}>
          <Suspense fallback={<span className={styles.note}>Opening the PDF&hellip;</span>}>
            <PdfPassage
              sourceId={sourceId}
              page={page}
              passage={passage?.exact ?? null}
              pageCount={info.data.pages ?? null}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
