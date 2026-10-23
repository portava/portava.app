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
