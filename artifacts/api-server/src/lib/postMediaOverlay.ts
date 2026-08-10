/**
 * Optional-column probes for post_media.
 *
 * Both columns here are optional, non-destructive metadata projected into feed
 * media arrays. Environments that have not applied the owning migration yet
 * must keep serving feeds — so, mirroring the `artCol()` precedent in
 * routes/stamps.ts, we probe once per process and append the column to select
 * strings only when it exists.
 *
 *   stamp_overlay  (0129)
 *   feed_url       (0208)
 */

let _hasStampOverlayCol: boolean | null = null;
let _hasFeedVariantCol: boolean | null = null;

/**
 * Returns ", stamp_overlay" when post_media.stamp_overlay exists, "" otherwise.
 * Append the result to post_media select column strings.
 */
export async function stampOverlayCol(sc: any): Promise<string> {
  if (_hasStampOverlayCol === null) {
    try {
      const { error } = await sc.from('post_media').select('stamp_overlay').limit(1);
      _hasStampOverlayCol = !error;
    } catch {
      _hasStampOverlayCol = false;
    }
  }
  return _hasStampOverlayCol ? ', stamp_overlay' : '';
}

/**
 * Returns ", feed_url" when post_media.feed_url exists (migration 0208),
 * "" otherwise. Append the result to post_media select column strings.
 *
 * Probed rather than hardcoded for the same reason as stamp_overlay, but the
 * consequence of getting it wrong is worse here: two of the four feed reads in
 * routes/posts.ts wrap their select in a fail-OPEN `catch`, so selecting a
 * column that does not exist would not error loudly — it would serve every post
 * with an empty media array and look like "those posts have no media". The
 * post-detail read is not wrapped at all and would 500 outright.
 *
 * Absent column degrades to exactly the pre-0208 behaviour: no feed_url in the
 * projection, so the client falls back to the original.
 */
export async function feedVariantCol(sc: any): Promise<string> {
  if (_hasFeedVariantCol === null) {
    try {
      const { error } = await sc.from('post_media').select('feed_url').limit(1);
      _hasFeedVariantCol = !error;
    } catch {
      _hasFeedVariantCol = false;
    }
  }
  return _hasFeedVariantCol ? ', feed_url' : '';
}

/** Test-only: clear the probe caches. */
export function _resetStampOverlayColCache(): void {
  _hasStampOverlayCol = null;
  _hasFeedVariantCol = null;
}
