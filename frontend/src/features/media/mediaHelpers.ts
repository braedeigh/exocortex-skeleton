/** Pure filter/sort/search + formatting logic for the media backlog —
 * extracted from static/js/media.js (_mediaVisibleItems and friends) so it
 * can be unit-tested. */
import { MEDIA_TYPES } from './types';
import type { MediaFilterState, MediaItem } from './types';

export const MEDIA_TYPE_LABELS: Record<string, string> = {
  book: '📖 Book',
  movie: '🎬 Movie',
  show: '📺 Show',
  podcast: '🎧 Podcast',
  article: '📄 Article',
  game: '🎮 Game',
  other: '✦ Other',
};

export function mediaTypeLabel(type: string | undefined): string {
  return MEDIA_TYPE_LABELS[type ?? ''] || MEDIA_TYPE_LABELS.other;
}

/** "Jul 4, 2026" from YYYY-MM-DD; 'undated' when missing; unparseable input
 * passes through untouched. Noon avoids timezone date-shift. */
export function formatMediaDate(iso: string | null | undefined): string {
  if (!iso) return 'undated';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Local YYYY-MM-DD — same as core.js todayStr() without a server date. */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Types that actually occur in the backlog, in canonical MEDIA_TYPES order —
 * drives which filter chips appear. */
export function presentMediaTypes(items: MediaItem[]): string[] {
  const present = new Set(items.map((it) => it.type));
  return MEDIA_TYPES.filter((t) => present.has(t));
}

export function countByType(items: MediaItem[], type: string): number {
  return items.filter((it) => it.type === type).length;
}

/** Port of _mediaVisibleItems: type filter, then title/author search, then
 * sort with not-done always first; the sort control only picks the ordering
 * within done/not-done. 'date' (and ties in the other modes) fall through to
 * date desc, then id desc. */
export function visibleMediaItems(items: MediaItem[], filter: MediaFilterState): MediaItem[] {
  const q = (filter.query || '').trim().toLowerCase();
  let visible = items.filter((it) => filter.type === 'all' || it.type === filter.type);
  if (q) {
    visible = visible.filter(
      (it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.author || '').toLowerCase().includes(q),
    );
  }
  return [...visible].sort((a, b) => {
    // Not-done first, always.
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (filter.sort === 'title') {
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
    if (filter.sort === 'type') {
      const at = mediaTypeLabel(a.type);
      const bt = mediaTypeLabel(b.type);
      if (at !== bt) return at.localeCompare(bt);
    }
    // date desc, then id desc — undated sorts as oldest.
    const av = a.date || '0000-00-00';
    const bv = b.date || '0000-00-00';
    if (av !== bv) return bv.localeCompare(av);
    return (b.id || '').localeCompare(a.id || '');
  });
}
