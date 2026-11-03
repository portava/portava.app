/**
 * videoPosterRef — whether a media ref names a video file, and where that video's poster frame lives.
 *
 * A video uploaded through POST /api/media/upload gets its poster at the video's own path plus `.poster.jpg`
 * (services/media/generalVideoPoster.ts, the derived poster route; on production `<ts>.mov.poster.jpg` sits beside
 * `<ts>.mov`). A post that never recorded that poster still names the `.mov` as its only media, and two things went
 * wrong with it: an <Image> cannot draw a video, and Supabase's image transform answers 400 for one. The owner's camera
 * videos (2026-10-23) were published and showed no picture at all. Pure — no React Native imports — so node:test can
 * load it.
 */

/** The suffix the derived poster route stores a video's poster under. */
export const VIDEO_POSTER_SUFFIX = '.poster.jpg';

const VIDEO_FILE = /\.(mov|mp4|m4v|webm|qt)$/i;

/** The ref without its query string or fragment (a signed URL's token is not part of the file name). */
function pathOf(ref: string): string {
  return ref.split(/[?#]/)[0] ?? ref;
}

/** True when `ref` names a video file by its extension. */
export function isVideoRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.length > 0 && VIDEO_FILE.test(pathOf(ref));
}

/** The derived poster of a video ref (query and fragment dropped), or null for anything that is not a video file. */
export function derivedVideoPosterRef(ref: string | null | undefined): string | null {
  return isVideoRef(ref) ? `${pathOf(ref as string)}${VIDEO_POSTER_SUFFIX}` : null;
}
const IMAGE_FILE = /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i;

/**
 * Should this ref be PLAYED? A video file by extension, yes; an image file by
 * extension, no; anything else (no recognisable extension) follows what the post
 * itself declares — `posts.media_type` (a MIME such as `video/quicktime`) or
 * `has_video`. Used where a post arrives with no `media` item (2026-10-24: posts
 * whose upload sat only in `media_urls` reached the detail screen with
 * `media: []`, and a `.mov` was handed to an <Image>).
 */
export function refPlaysAsVideo(
  ref: string | null | undefined,
  declared: { mediaType?: string | null; hasVideo?: boolean | null } = {},
): boolean {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  if (isVideoRef(ref)) return true;
  if (IMAGE_FILE.test(pathOf(ref))) return false;
  return (typeof declared.mediaType === 'string' && declared.mediaType.toLowerCase().startsWith('video')) || declared.hasVideo === true;
}
