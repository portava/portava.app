/**
 * generalVideoPoster — §37 "Thumbnail generation" for a video uploaded through
 * `POST /api/media/upload` (services/media.ts `uploadMedia`).
 *
 * The server has no video decoder in this tier, so the frame is cut on the
 * device. Where it goes is the server's decision: `POST /api/media/upload/poster
 * ?path=<the video's storage path>` re-encodes it without metadata, stores it
 * at the video's own derived poster path (so exactly the video's audience can
 * see it, no wider) and records it on the video's canonical `media_assets` row.
 *
 * FALLBACK, and why it is the old behaviour rather than nothing. An app build
 * can reach an API that predates the poster route. Anything other than 201 or
 * 409 therefore falls back to what uploadMedia did before this existed: upload
 * the frame as an ordinary image through `/api/media/upload` and use its URL.
 * That keeps every grid tile that had a poster yesterday having one today; it
 * just does not reach the canonical row.
 *
 * Never throws; a video without a poster still posts.
 */

export interface PosterHttpResult {
  status: number;
  body: unknown;
}

export interface GeneralPosterDeps {
  /** Cut a frame from the local video; null when the device cannot. */
  extract(videoUri: string): Promise<string | null>;
  /** POST the frame to the poster route for `videoPath`. Throws only when no response arrived. */
  postPoster(videoPath: string, frameUri: string): Promise<PosterHttpResult>;
  /** The pre-existing path: upload the frame as a plain image; its URL or null. */
  uploadAsImage(frameUri: string): Promise<string | null>;
}

export type PosterRoute = 'derived' | 'already_had_one' | 'legacy_image' | 'none';

export interface PosterOutcome {
  thumbnailUrl: string | null;
  route: PosterRoute;
}

const POSTER_SUFFIX = '.poster.jpg';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function attachVideoPoster(
  videoPath: string | null,
  videoUri: string,
  deps: GeneralPosterDeps,
): Promise<PosterOutcome> {
  let frame: string | null = null;
  try {
    frame = await deps.extract(videoUri);
  } catch {
    frame = null;
  }
  if (!frame) return { thumbnailUrl: null, route: 'none' };

  if (videoPath) {
    try {
      const res = await deps.postPoster(videoPath, frame);
      if (res.status === 201) {
        const url = str((res.body as { thumbnailUrl?: unknown } | null)?.thumbnailUrl);
        if (url) return { thumbnailUrl: url, route: 'derived' };
      } else if (res.status === 409) {
        // Written once, server-side: a retry after a lost response lands here,
        // and the frame that is already there is the video's poster.
        return { thumbnailUrl: `post-media/${videoPath}${POSTER_SUFFIX}`, route: 'already_had_one' };
      }
    } catch {
      /* no answer at all — fall back below */
    }
  }

  try {
    const url = await deps.uploadAsImage(frame);
    return url ? { thumbnailUrl: url, route: 'legacy_image' } : { thumbnailUrl: null, route: 'none' };
  } catch {
    return { thumbnailUrl: null, route: 'none' };
  }
}

/** The device's poster deps, over `fetch`, for an API base and a bearer token. */
export function deviceGeneralPosterDeps(
  apiBase: string,
  token: string,
  extract: (videoUri: string) => Promise<string | null>,
): GeneralPosterDeps {
  const frameBlob = async (uri: string): Promise<Blob> => (await fetch(uri)).blob();
  return {
    extract,
    async postPoster(videoPath, frameUri) {
      const res = await fetch(`${apiBase}/api/media/upload/poster?path=${encodeURIComponent(videoPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
        body: await frameBlob(frameUri),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    async uploadAsImage(frameUri) {
      const res = await fetch(`${apiBase}/api/media/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
        body: await frameBlob(frameUri),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { url?: unknown };
      return str(body?.url);
    },
  };
}
