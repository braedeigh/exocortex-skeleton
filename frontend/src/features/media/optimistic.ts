/** Optimistic cache appliers for the media query — mirror routes/media.py's
 * add/update/remove semantics so the instant UI matches what the next poll
 * returns. */
import type { MediaItemPatch } from './api';
import type { MediaData, MediaItem } from './types';

function withItems(data: MediaData, fn: (items: MediaItem[]) => MediaItem[]): MediaData {
  const items = data.media?.items || [];
  return { ...data, media: { ...data.media, items: fn(items) } };
}

export function applyMediaAdd(data: MediaData, item: MediaItem): MediaData {
  return withItems(data, (items) => [...items, item]);
}

/** Only the fields present in the patch change — same "if key in body"
 * semantics as update_media_item. Empty date stores as null. */
export function applyMediaUpdate(data: MediaData, patch: MediaItemPatch): MediaData {
  return withItems(data, (items) =>
    items.map((it) => {
      if (it.id !== patch.id) return it;
      const next = { ...it };
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.type !== undefined) next.type = patch.type;
      if (patch.author !== undefined) next.author = patch.author;
      if (patch.recommended_by !== undefined) next.recommended_by = patch.recommended_by;
      if (patch.notes !== undefined) next.notes = patch.notes;
      if (patch.date !== undefined) next.date = patch.date || null;
      if (patch.done !== undefined) next.done = patch.done;
      return next;
    }),
  );
}

export function applyMediaRemove(data: MediaData, id: string): MediaData {
  return withItems(data, (items) => items.filter((it) => it.id !== id));
}
