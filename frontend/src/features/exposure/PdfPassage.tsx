/**
 * PdfPassage.tsx — a source's own PDF, opened at a highlighted passage, with
 * the passage highlighted on the page itself.
 *
 * What this file does: loads the source's PDF from the commons (GET
 * /api/exposure/sources/<id>/pdf, routes/exposure.py) with pdf.js, draws the
 * page the passage is on (the server worked the page out: passage_pages,
 * pdfpages.py) to fit the pane, lays pdf.js's invisible text layer over it,
 * and colours the pieces of text the passage runs through
 * (./passageSpans.ts), scrolling them into view. Previous/next buttons turn
 * pages. pdf.js loads only when a PDF is actually opened, so it stays out of
 * the rest of the app's bundle.
 *
 * Used by features/research/ClaimsPage.tsx (the source pane: PDF by default,
 * the extracted text a tap away). A source with no PDF (a web article) never
 * gets here — the pane keeps its text view.
 *
 * Prompt that produced this file: "i want pdfs to be downloaded so they can
 * pop up next to the claim and highlight exactly where in the claim that it
 * was."
 */
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { passageSpans } from './passageSpans';
import styles from './PdfPassage.module.css';

// pdf.js and its worker, fetched the first time any PDF opens and shared after.
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
      ([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
      },
    );
  }
  return pdfjsPromise;
}

export function PdfPassage({
  sourceId,
  page: startPage,
  passage,
  pageCount,
}: {
  sourceId: string;
  page: number | null;
  passage: string | null;
  pageCount: number | null;
}) {
  const [page, setPage] = useState(startPage ?? 1);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<boolean | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);

  useEffect(() => setPage(startPage ?? 1), [startPage, sourceId]);

  // Load the document once per source.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(null);
    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url: `/api/exposure/sources/${encodeURIComponent(sourceId)}/pdf` }).promise)
      .then((doc) => {
        loaded = doc;
        if (!cancelled) setPdf(doc);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(String(problem));
      });
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [sourceId]);

  // Draw the page to fit the pane, then its text layer, then the highlight.
  useEffect(() => {
    if (!pdf || !holder.current || !canvas.current || !textLayer.current) return;
    let cancelled = false;
    const layerElement = textLayer.current;
    const draw = async () => {
      const pdfjs = await loadPdfjs();
      const pdfPage = await pdf.getPage(Math.min(Math.max(page, 1), pdf.numPages));
      const width = holder.current?.clientWidth || 600;
      const scale = width / pdfPage.getViewport({ scale: 1 }).width;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const target = canvas.current!;
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      holder.current!.style.setProperty('--total-scale-factor', String(scale));
      await pdfPage.render({ canvas: target, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
        .promise;
      if (cancelled) return;
      layerElement.replaceChildren();
      const layer = new pdfjs.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: layerElement,
        viewport,
      });
      await layer.render();
      if (cancelled || !passage) return;
      const hits = passageSpans(layer.textContentItemsStr, passage);
      setFound(hits.length > 0);
      hits.forEach((index) => layer.textDivs[index]?.classList.add(styles.hit));
      layer.textDivs[hits[0]]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    draw().catch((problem: unknown) => {
      if (!cancelled) setError(String(problem));
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page, passage]);

  const total = pdf?.numPages ?? pageCount ?? null;
  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <button type="button" className={styles.navButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ‹ Prev
        </button>
        <span className={styles.pageWords}>
          page {page}
          {total ? ` of ${total}` : ''}
          {startPage && page !== startPage ? (
            <button type="button" className={styles.backLink} onClick={() => setPage(startPage)}>
              back to the passage
            </button>
          ) : null}
        </span>
        <button
          type="button"
          className={styles.navButton}
          disabled={total !== null && page >= total}
          onClick={() => setPage(page + 1)}
        >
          Next ›
        </button>
      </div>
      {error ? <p className={styles.note}>Couldn’t open the PDF: {error}</p> : null}
      {!pdf && !error ? <p className={styles.note}>Opening the PDF&hellip;</p> : null}
      {found === false && page === startPage ? (
        <p className={styles.note}>The passage couldn’t be matched on this page’s text; it’s shown in the text view.</p>
      ) : null}
      <div ref={holder} className={styles.page}>
        <canvas ref={canvas} className={styles.canvas} />
        <div ref={textLayer} className={`textLayer ${styles.textLayer}`} />
      </div>
    </div>
  );
}
