/**
 * "Save to a Memory" from the viewer's OWN post — census-media MD385, lead
 * ruling D-26j, the client half.
 *
 * The server half is `POST /api/memories/:id/items/from-post`
 * (routes/memories.ts): it accepts only the caller's own live post, picks the
 * media SERVER-side by index from the post's own `media_urls` (the client never
 * sends a URL), refuses someone else's post with the same `not_found` a missing
 * one gets, and is behind `memory_from_own_media_enabled` (seeded FALSE by
 * 3999). This module only calls it and says, in a person's words, what came
 * back. Nothing here decides ownership: the server does, and the screen shows
 * the action only on one's own post as a courtesy, not as the guard.
 */
import { freshToken as freshApiToken } from './apiToken.ts';
import { newMemoryOperationId } from './memories.ts';

/** The client flag, read through FeatureFlagsContext (`isEnabled`). Off: nothing shows. */
export const MEMORY_FROM_OWN_MEDIA_FLAG = 'memory_from_own_media_enabled';

/** The most media one post carries that the server will index into (MAX_POST_MEDIA_INDEX + 1). */
export const MAX_POST_MEDIA = 50;

export type SaveFromPostRefusal =
  /** 403 feature_disabled — the switch is off on the server. Not retryable. */
  | 'disabled'
  /** 404 — not the caller's post (or it was deleted or held), or the Memory is gone. Not retryable. */
  | 'not_found'
  /** 403 forbidden — the Memory is not the caller's. Not retryable. */
  | 'forbidden'
  /** 400 — the post has no media at that position. Not retryable. */
  | 'no_media'
  /** 409 — that photo is already in this Memory. Nothing to do. */
  | 'already_saved'
  /** 503 — the server could not attempt it right now. Retryable. */
  | 'unavailable'
  /** The request never reached the server. Retryable. */
  | 'network'
  /** Anything else. Retryable. */
  | 'failed';

export type SaveFromPostResult =
  | { ok: true; itemId: string | null; mediaCount?: number }
  | { ok: false; kind: SaveFromPostRefusal; message: string; mediaCount?: number };

/** The sentence a person sees for each outcome. The server's own words are kept where it sent them. */
export const SAVE_FROM_POST_COPY: Readonly<Record<SaveFromPostRefusal, string>> = {
  disabled: 'Saving a post to a Memory is turned off right now.',
  not_found: 'This post can’t be saved to a Memory — it may have been removed.',
  forbidden: 'That Memory isn’t yours, so nothing was added to it.',
  no_media: 'This post has no photo or video to save.',
  already_saved: 'That photo is already in this Memory.',
  unavailable: 'Saving to a Memory isn’t available right now. Nothing was saved — try again.',
  network: 'You’re offline. Nothing was saved — try again when you’re connected.',
  failed: 'Something went wrong. Nothing was saved — try again.',
};

/** Retryable outcomes get a Try again; the rest are final. */
export function isRetryable(kind: SaveFromPostRefusal): boolean {
  return kind === 'unavailable' || kind === 'network' || kind === 'failed';
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function refusalFor(status: number, body: any): SaveFromPostRefusal {
  const code = typeof body?.error === 'string' ? body.error : '';
  if (code === 'feature_disabled') return 'disabled';
  if (code === 'forbidden' || status === 403) return 'forbidden';
  if (code === 'not_found' || status === 404) return 'not_found';
  if (code === 'conflict' || status === 409) return 'already_saved';
  if (code === 'invalid_payload' || status === 400) return 'no_media';
  if (code === 'degraded_unavailable' || status === 503) return 'unavailable';
  return 'failed';
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('failed to fetch') || m.includes('network request failed') || m.includes('networkerror') || m.includes('load failed');
}

/**
 * Copy one of the caller's own post's media into one of the caller's Memories.
 * `operationId` is the §19 idempotency key; a retry of the same intent reuses it.
 */
export async function saveOwnPostMediaToMemory(input: {
  memoryId: string;
  postId: string;
  mediaIndex: number;
  position?: number;
  operationId?: string;
}): Promise<SaveFromPostResult> {
  const operationId = input.operationId ?? newMemoryOperationId('from-post');
  try {
    const token = await freshApiToken();
    const res = await fetch(`${apiBase()}/api/memories/${encodeURIComponent(input.memoryId)}/items/from-post`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        'Idempotency-Key': operationId,
      },
      body: JSON.stringify({ postId: input.postId, mediaIndex: input.mediaIndex, position: input.position ?? input.mediaIndex }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, itemId: typeof body?.item?.id === 'string' ? body.item.id : null, ...serverMediaCount(body) };
    const kind = refusalFor(res.status, body);
    return { ok: false, kind, message: SAVE_FROM_POST_COPY[kind], ...serverMediaCount(body) };
  } catch (e) {
    const kind: SaveFromPostRefusal = isNetworkError(e) ? 'network' : 'failed';
    return { ok: false, kind, message: SAVE_FROM_POST_COPY[kind] };
  }
}

export interface SavePostReport {
  /** Media newly added. */
  saved: number;
  /** Media that were already in the Memory. */
  alreadyThere: number;
  /** How many media the post has (capped at MAX_POST_MEDIA). */
  total: number;
  /** The first refusal that stopped or interrupted the copy, if any. */
  refusal: SaveFromPostRefusal | null;
}

/**
 * Copy every media item of the post, in order. A final refusal on the first
 * item (off, not yours, gone, not your Memory) stops at once — nothing else
 * would succeed. A retryable failure part-way stops too, and the report says
 * exactly how many made it, so the screen can say "2 of 3 saved" rather than
 * "saved" or "failed".
 *
 * THE COUNT (2026-10-25, #808 verdict finding 2). `mediaCount` is the screen's
 * estimate and only opens the copy at index 0. From the first answer on, the
 * server's own count (`mediaCount` on every answer about the caller's post)
 * replaces it, so no index past the server's list is ever asked for. Should
 * the server answer "no media at that position" for an index at or past the
 * count it states, the post simply has fewer media: the copy ends there and
 * reports the server's total — it is not a refusal (fail closed, never a
 * half-saved error the person cannot act on).
 */
export async function saveOwnPostToMemory(input: { memoryId: string; postId: string; mediaCount: number }): Promise<SavePostReport> {
  const cap = (n: number) => Math.max(0, Math.min(MAX_POST_MEDIA, Math.floor(n)));
  const report: SavePostReport = { saved: 0, alreadyThere: 0, total: cap(input.mediaCount), refusal: null };
  for (let i = 0; i < report.total; i++) {
    const r = await saveOwnPostMediaToMemory({ memoryId: input.memoryId, postId: input.postId, mediaIndex: i });
    if (r.mediaCount !== undefined) report.total = cap(r.mediaCount);
    if (r.ok) { report.saved++; continue; }
    if (r.kind === 'already_saved') { report.alreadyThere++; continue; }
    if (r.kind === 'no_media' && r.mediaCount !== undefined && i > 0 && i >= r.mediaCount) break; // past the server's list: done, not refused
    report.refusal = r.kind;
    break;
  }
  return report;
}

/** The sentence for a finished copy. */
export function describeSavePostReport(report: SavePostReport, memoryTitle: string | null): string {
  const where = memoryTitle ? `“${memoryTitle}”` : 'your Memory';
  const done = report.saved + report.alreadyThere;
  if (report.refusal) {
    if (done === 0) return SAVE_FROM_POST_COPY[report.refusal];
    return isRetryable(report.refusal)
      ? `${done} of ${report.total} saved to ${where}. The rest weren’t — try again.`
      : `${done} of ${report.total} saved to ${where}. ${SAVE_FROM_POST_COPY[report.refusal]}`;
  }
  if (report.saved === 0 && report.alreadyThere > 0) return `Already in ${where}.`;
  return report.total === 1 ? `Saved to ${where}.` : `All ${report.total} saved to ${where}.`;
}

// ── 2026-10-25, PR #808 verdict finding 2 — appended at the TAIL so no cited line above moves ──

/**
 * How many media the SERVER says the post has (2026-10-25, #808 verdict finding 2). The route stamps `mediaCount` on
 * every answer about the caller's own post (api-server memoryFromOwnMedia.ts stampPostMediaCount); it is the one
 * count this module follows. Anything that is not a whole number ≥ 0 is no count at all.
 */
function serverMediaCount(body: any): { mediaCount?: number } {
  const n = body?.mediaCount;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? { mediaCount: n } : {};
}
