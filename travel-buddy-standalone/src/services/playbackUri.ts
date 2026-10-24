/**
 * playbackUri — may a player be handed this URI? (2026-10-24, owner-reported "video media still not playing")
 *
 * The owner's video never played after its row existed. SharedVideoPlayer mounted <Video> with the BARE
 * `post-media/<uid>/<ts>.mov` while useHydratedMedia was still resolving it. AVPlayer cannot load a reference with
 * no scheme, so the error latched "Video unavailable", and the signed URL that arrived a moment later was never
 * handed to a player (production edge logs, 2026-10-24 10:11Z: the server signed the .mov, and the phone never
 * requested the signed URL).
 *
 * Every <Video> in the app decides through `isLoadablePlaybackUri` / `playbackUriState`. They live here, beside
 * services/mediaUrl.ts (which re-exports them), with NO imports, so a player can ask without loading the sign
 * client — and so the private-bucket rule exists exactly once: mediaUrl.ts's `isPrivateMediaRef` delegates here.
 */

/** The two Supabase storage buckets that are private. */
export const PRIVATE_MEDIA_BUCKETS: readonly string[] = ['post-media', 'profile-media'];

// Matches: .../storage/v1/object/public/<bucket>/…
const STORAGE_PUBLIC_BUCKET_RE = /\/storage\/v1\/object\/public\/([^/?#]+)\//;

/**
 * The storage bucket a URL or bare storage path names, or null.
 *   1. Supabase public URL: `https://…/storage/v1/object/public/<bucket>/…`
 *   2. Bare storage path: `<bucket>/<path>` — what the upload endpoints return (no scheme, bucket first).
 */
export function storageBucketOf(url: string): string | null {
  const m = STORAGE_PUBLIC_BUCKET_RE.exec(url);
  if (m) return m[1] ?? null;
  if (!url.startsWith('//') && !url.includes('://')) {
    const slash = url.indexOf('/');
    if (slash > 0) return url.slice(0, slash);
  }
  return null;
}

/** True for a reference into one of the PRIVATE buckets (it must be signed to load). */
export function isPrivateMediaRefOf(url: string): boolean {
  const bucket = storageBucketOf(url);
  return bucket !== null && PRIVATE_MEDIA_BUCKETS.includes(bucket);
}

const LOADABLE_SCHEME = /^(https?|file|data|content|blob|assets-library|ph):/i;

/** True for a URI a player can load as it is: a scheme it understands (or a same-origin absolute path, which web resolves against the page), and not a private-bucket ref that must be signed first. A bare `post-media/…` ref is never loadable. */
export function isLoadablePlaybackUri(uri: unknown): uri is string {
  return typeof uri === 'string' && uri.length > 0 && (LOADABLE_SCHEME.test(uri) || (uri.startsWith('/') && !uri.startsWith('//'))) && !isPrivateMediaRefOf(uri);
}

export type PlaybackUriState =
  | { state: 'ready'; uri: string }
  | { state: 'resolving' }
  | { state: 'unavailable' };

/**
 * Where a video source stands, given useHydratedMedia's `resolved` map:
 *   ready        a loadable URI: the signed one once it has arrived, or the raw one if it was loadable already
 *   resolving    a private-bucket ref whose signature has not arrived yet: mount NO player, show the poster
 *   unavailable  the server refused to sign it, it signed to something unloadable, or the ref names nothing a
 *                player could ever load
 */
export function playbackUriState(raw: string | null | undefined, resolved: Record<string, string | null | undefined>): PlaybackUriState {
  if (typeof raw !== 'string' || raw.length === 0) return { state: 'unavailable' };
  const hydrated = resolved[raw];
  if (hydrated === null) return { state: 'unavailable' };
  if (typeof hydrated === 'string') return isLoadablePlaybackUri(hydrated) ? { state: 'ready', uri: hydrated } : { state: 'unavailable' };
  if (isLoadablePlaybackUri(raw)) return { state: 'ready', uri: raw };
  return isPrivateMediaRefOf(raw) ? { state: 'resolving' } : { state: 'unavailable' };
}
