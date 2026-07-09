/**
 * "Add timestamp" support for the journal's manual-edit textareas (BlobEditor,
 * EntryCard, RefCard) — dev note: an explicit button to drop in the current
 * time while hand-editing, instead of typing it out.
 *
 * Format matches the vault's own rendering exactly, not just cardClock's bare
 * "8:46 AM" label: tulku/_system/stream.py's `_clock()` (`%-I:%M %p`, no
 * zero-padded hour) wrapped the same way `render_day_text()` wraps a
 * time-gap header — `*[8:46 AM]*` — so a hand-typed timestamp is
 * indistinguishable from one the card-pool renderer would have produced.
 */

/** "8:46 AM" — no zero-pad on the hour, uppercase AM/PM. Mirrors stream.py's
 * `_clock()` / EntryCard's `cardClock()`. */
function clockNow(): string {
  const d = new Date();
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "*[8:46 AM]*" — the exact marker stream.py's render_day_text() writes at
 * a time-gap boundary. */
export function timestampMarker(): string {
  return `*[${clockNow()}]*`;
}

/**
 * Insert `text` at a textarea's current cursor (replacing any selection),
 * update it via `setValue`, then restore focus and place the caret right
 * after the inserted text. Call synchronously from a click handler — reads
 * `el.selectionStart`/`End` before the DOM changes.
 */
export function insertAtCursor(el: HTMLTextAreaElement, current: string, text: string, setValue: (next: string) => void) {
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + text + current.slice(end);
  setValue(next);
  const caret = start + text.length;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}
