/**
 * playbackAuthorization — "may this viewer still read this video?", asked of
 * the SERVER, never of a cache (Telegraph §6.3, census-telegraph T62).
 *
 * The media sign endpoint is the authority on message media: it re-decides
 * every request (`artifacts/api-server/src/lib/mediaAccess.ts` — blocks in
 * both directions, fail-closed; message media only for an ACTIVE member of
 * the thread; post-media is never allow-cached server-side). The client keeps
 * signed URLs for up to 55 minutes (`lib/batchSignMedia.ts`), so a sign that
 * hits that cache says nothing about now. This evicts the reference first, so
 * the request always reaches the server.
 *
 *   'allowed'  the server signed it just now
 *   'refused'  the server answered and refused (block, no longer a member,
 *              the message's object no longer the viewer's to read)
 *   'unknown'  the server could not be asked (offline). NOT a refusal: the
 *              video's own bytes need the same network.
 *
 * With no session at all `batchSignUrls` asks nothing and `lastSignOutcome`
 * still holds the previous answer; sign-out is its own stop (the host's
 * account check), so that stale answer is never what ends or keeps a session.
 *
 * Never throws.
 */
import { _evictBatchSignEntry, batchSignUrls, lastSignOutcome } from '../../../lib/batchSignMedia.ts';

export type PlaybackAuthorization = 'allowed' | 'refused' | 'unknown';

export async function recheckPlaybackAuthorization(mediaRef: string): Promise<PlaybackAuthorization> {
  if (!mediaRef) return 'refused';
  try {
    _evictBatchSignEntry(mediaRef);
    await batchSignUrls([mediaRef]);
    const outcome = lastSignOutcome(mediaRef);
    if (outcome === 'denied') return 'refused';
    if (outcome === 'signed') return 'allowed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Forget the cached signature for a reference (a stopped session's). */
export function forgetPlaybackSignature(mediaRef: string): void {
  try { _evictBatchSignEntry(mediaRef); } catch { /* a cache that cannot evict is a cache miss later */ }
}
