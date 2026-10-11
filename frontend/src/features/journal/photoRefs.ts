/**
 * Finds the photos in a journal card's text.
 *
 * A photo handed to a conversation lands in the card as a marker like
 * `[uploaded: /…/uploads/20260918_204338_IMG_3467.png]`, sometimes followed by
 * a description the Keeper wrote: `[uploaded: /…/x.jpeg — mirror selfie…]`.
 * `splitPhotos` takes those markers out of the text and returns them as a
 * list, so the card can show the words as words and the photos as
 * thumbnails. Uploads that aren't photos (pasted text, PDFs) are left in the
 * text untouched.
 *
 * The file name is all the server needs: routes/photos.py looks it up in the
 * uploads inbox and then the archive, since the path in the marker goes
 * stale once the daily sweep files the photo away.
 *
 * Prompt: "every time i've uploaded a photo, i'm wanting them to show up as
 * clickable thumbnails in the journal"
 */

export interface PhotoRef {
  /** The bare file name, e.g. "20260918_204338_677011_IMG_3467.png". */
  name: string;
  /** The Keeper's description, when the marker carried one; else "". */
  caption: string;
}

// One photo marker: the path (no spaces), ending in an image type, then an
// optional " — description" up to the closing bracket.
const PHOTO_MARKER = /\[uploaded: (?:[^\]\s]*\/)?([^/\]\s]+\.(?:png|jpe?g|gif|webp))(?:\s+[—–-]+\s+([^\]]*))?\]/gi;

/** Pull the photo markers out of a card body: the remaining text, plus each
 * photo in the order it appeared. Blank lines left behind are tidied up. */
export function splitPhotos(body: string): { text: string; photos: PhotoRef[] } {
  const photos: PhotoRef[] = [];
  const text = body.replace(PHOTO_MARKER, (_marker, name: string, caption?: string) => {
    photos.push({ name, caption: (caption ?? '').trim() });
    return '';
  });
  if (!photos.length) return { text: body, photos };
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), photos };
}

/** The server addresses for one photo: its small thumbnail and full size. */
export function photoUrls(name: string): { thumb: string; full: string } {
  const safe = encodeURIComponent(name);
  return { thumb: `/api/photos/${safe}/thumb`, full: `/api/photos/${safe}` };
}
