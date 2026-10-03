/**
 * unreadCount — how the client shows a count or a per-viewer flag the server
 * could not read (census-media §47).
 *
 * Since §47 the media and post feeds answer a count they could not read as
 * `null` (and name the read in `failedSources`) instead of a cached or made-up
 * 0, and a per-viewer flag (saved, stamped, following) as `null` instead of
 * false. The client must not turn that `null` back into 0 or false:
 *
 *   - a measured count above 0 renders as its compact number;
 *   - a measured 0 renders nothing (unchanged: zero counts were never drawn);
 *   - an UNREAD count renders the mark "—" with an accessibility label that
 *     says the count is unavailable, so it can never be read as zero;
 *   - an optimistic +1/−1 over an unread count stays unread until the server
 *     answers with a measured count;
 *   - an unread flag is never written into a client store as false.
 */
import { formatCompactCount } from './counterFormat.ts';

/** The mark drawn in place of a count the server could not read. */
export const UNREAD_COUNT_MARK = '—';

/**
 * Display text for a count: `null` when nothing is drawn (absent, or a
 * measured 0), the mark for an unread count, else the compact number.
 * `undefined` means the caller is not showing a count at all.
 */
export function countText(count: number | null | undefined): string | null {
  if (count === undefined) return null;
  if (count === null) return UNREAD_COUNT_MARK;
  return count > 0 ? formatCompactCount(count) : null;
}

/** Sublabel form of `countText` for surfaces that always draw a string. */
export function countSublabel(count: number | null | undefined): string {
  return countText(count) ?? '';
}

/** Accessibility label for an action whose count could not be read. */
export function unreadCountLabel(action: string): string {
  return `${action}, count unavailable`;
}

/**
 * One optimistic step of a counter. An unread base stays unread: adding one
 * to a count nobody measured would draw a made-up number.
 */
export function stepCount(count: number | null, add: boolean): number | null {
  if (count === null) return null;
  return add ? count + 1 : Math.max(0, count - 1);
}

/** True only for a flag the server measured as set; unread is not "set". */
export function isKnownTrue(flag: boolean | null | undefined): boolean {
  return flag === true;
}

/** True only for a flag the server measured as unset; unread is not "unset". */
export function isKnownFalse(flag: boolean | null | undefined): boolean {
  return flag === false;
}
