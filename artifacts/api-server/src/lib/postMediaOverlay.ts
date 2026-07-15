/**
 * post_media.stamp_overlay column support (migration 0129).
 *
 * The overlay is optional, non-destructive metadata projected into feed media
 * arrays. Environments that have not applied 0129 yet must keep serving feeds
 * — so, mirroring the `artCol()` precedent in routes/stamps.ts, we probe once
 * per process and append the column to select strings only when it exists.
 */

let _hasStampOverlayCol: boolean | null = null;

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

/** Test-only: clear the probe cache. */
export function _resetStampOverlayColCache(): void {
  _hasStampOverlayCol = null;
}
