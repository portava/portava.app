/**
 * The viewer's time-left label for a Highlight.
 *
 * census H98: a §4 PERMANENT Highlight has no expiry (`expires_at` NULL,
 * migration 2975). `new Date(null)` is the epoch, so the old inline formatter
 * read a permanent Highlight as "0m left". It is labelled as what it is.
 */
export const PERMANENT_HIGHLIGHT_LABEL = 'Permanent';

export function highlightExpiryLabel(expiresAt: string | null, nowMs: number): string {
  if (expiresAt === null) return PERMANENT_HIGHLIGHT_LABEL;
  const diff = Math.max(0, new Date(expiresAt).getTime() - nowMs);
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `${hrs}h left`;
  return `${mins}m left`;
}
