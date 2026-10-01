/**
 * linearNewsSeen — which Linear news she has already looked at, on this device.
 *
 * The Linear page's "New in Linear" list (LinearNews.tsx) marks rows she
 * hasn't seen, and the roster's Linear door (LinearDoor.tsx) counts them.
 * Both measure against one mark: the time of the newest piece of news that
 * was on screen the last time she opened the Linear page. It lives in
 * localStorage, so it is per device — a phone and a laptop each keep their own.
 */

// Where the mark is kept.
const SEEN_KEY = 'linear-news-seen';

/** The time of the newest news she has looked at, or '' when she never has. */
export function readLinearNewsSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remember that she has looked at everything up to this time. */
export function markLinearNewsSeen(newest: string) {
  if (newest <= readLinearNewsSeen()) return;
  try {
    localStorage.setItem(SEEN_KEY, newest);
  } catch {
    // No storage: the rows simply stay marked new.
  }
}

/** How many of these news times are newer than the last one she looked at. */
export function unseenLinearNews(times: string[]): number {
  const seen = readLinearNewsSeen();
  return times.filter((at) => at > seen).length;
}
