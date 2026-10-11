/**
 * exposureMath.ts — turning the exposure numbers into words for the page.
 *
 * What this does: the score's working arrives as raw numbers (a residue in
 * ppb, a DRI — one serving's share of the EPA chronic safe daily dose). These
 * helpers say them plainly ("2.1× the safe dose", "2.9 ppm", "found in 627
 * of 693"), put each pesticide in its verdict band the same way exposure.py
 * does, and order the list so the ones that matter come first. No numbers
 * are made here; everything shown is the server's, only worded.
 *
 * Touches: ./types.ts; used by ExposureCard.tsx and ContaminantPage.tsx;
 * tested in exposureMath.test.ts. The bands mirror exposure.VERDICT_BANDS.
 *
 * Prompt that produced this file: "i want any possible contaminant to be
 * listed with potential values next to any of them".
 */
import type { OrganicVerdict } from '../kitchen/types';
import type { ExposureTerm } from './types';

/** One serving's share of the safe daily dose, in words. */
export function shareWords(dri: number | null): string {
  if (dri === null) return 'no EPA safe dose to compare';
  if (dri >= 1) return `${dri >= 10 ? Math.round(dri) : dri.toFixed(1)}× the safe daily dose`;
  const percent = dri * 100;
  if (percent >= 10) return `${Math.round(percent)}% of the safe daily dose`;
  if (percent >= 0.1) return `${percent.toFixed(1)}% of the safe daily dose`;
  return 'under 0.1% of the safe daily dose';
}

/** A residue in the unit that reads best: ppm from 1000 ppb up. */
export function residueWords(ppb: number | null): string {
  if (ppb === null) return '—';
  if (ppb >= 1000) return `${(ppb / 1000).toFixed(ppb >= 10000 ? 0 : 1)} ppm`;
  if (ppb >= 10) return `${Math.round(ppb)} ppb`;
  if (ppb >= 0.1) return `${ppb.toFixed(1)} ppb`;
  return ppb > 0 ? `${ppb.toFixed(2)} ppb` : '0 ppb';
}

/** "2017,2018" → "2017 + 2018"; a single year stays as it is. */
export function yearsWords(years: string): string {
  return years.split(',').join(' + ');
}

/** Which verdict band one pesticide falls in — the same lines exposure.py draws. */
export function termBand(term: ExposureTerm, bands: [number, OrganicVerdict][]): OrganicVerdict {
  if (!term.samples_detected) return 'conventional';
  if (term.dri === null) return 'open';
  for (const [line, verdict] of bands) if (term.dri > line) return verdict;
  return 'conventional';
}

/** Found pesticides first, biggest share of the safe dose first; then the
 * found ones with no dose, most often found first; then the never-found. */
export function orderTerms(terms: ExposureTerm[]): ExposureTerm[] {
  const rank = (term: ExposureTerm) => (!term.samples_detected ? 2 : term.dri === null ? 1 : 0);
  return [...terms].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.dri ?? 0) - (a.dri ?? 0) ||
      b.samples_detected - a.samples_detected ||
      a.pesticide.localeCompare(b.pesticide),
  );
}

/** How the bar beside a pesticide is drawn: its share of the safe dose on a
 * log scale from 0.001 to 10, so a 0.002 and a 2.0 are both visible. */
export function barWidth(dri: number | null): number {
  if (dri === null || dri <= 0) return 0;
  const low = Math.log10(0.001);
  const high = Math.log10(10);
  const at = Math.min(Math.max(Math.log10(dri), low), high);
  return Math.round(((at - low) / (high - low)) * 100);
}
