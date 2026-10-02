/**
 * mediaInteractions — API calls for media save, share, report, and
 * owner controls (visibility change, delete).
 *
 * All mutations go through the API server (bearer token auth).
 * Never calls Supabase directly.
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

export interface MediaActionResult {
  ok: boolean;
  data?: Record<string, unknown>;
  message?: string;
  errorKind?: string;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: object,
): Promise<MediaActionResult> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated', errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: (json as any)?.message ?? `HTTP ${res.status}`, errorKind: (json as any)?.error };
    }
    return { ok: true, data: json };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, message: 'Network error', errorKind: 'network' };
    return { ok: false, message: e instanceof Error ? e.message : 'Unknown error', errorKind: 'unknown' };
  }
}

// ── Like — RETIRED (MD424; testing-mode WP-17, census-media §46) ────────────
//
// likeMedia / unlikeMedia called POST/DELETE /api/media/:id/like and had no
// caller. Heart/Like is on the Media spec's anti-pattern list, and the server
// route is itself a compat wrapper over Stamp. Media reactions are Stamp
// (StampButton / useStamp through /stamps). These comment lines keep the
// former line span: this file is cited by line number.
//
//

// ── Save ─────────────────────────────────────────────────────────────────────

export async function saveMedia(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/save`);
}

export async function unsaveMedia(mediaId: string): Promise<MediaActionResult> {
  return call('DELETE', `/api/media/${encodeURIComponent(mediaId)}/save`);
}

// ── Share ─────────────────────────────────────────────────────────────────────

export async function recordMediaShare(
  mediaId: string,
  target: 'native' | 'copy_link' | 'telegraph',
): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/share`, { target });
}

// ── Report ────────────────────────────────────────────────────────────────────

export async function reportMedia(
  mediaId: string,
  reason: string,
  notes?: string,
): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/report`, { reason, notes });
}

// ── Owner: visibility change ──────────────────────────────────────────────────

/**
 * Owner-only visibility change.
 *
 * The accepted set mirrors the server schema, which mirrors the column: only
 * labels of the `post_visibility` enum can be written. 'friends' is not one —
 * it was accepted here and by the route, and rejected by Postgres every single
 * time (22P02 → db_error).
 */
export async function updateMediaVisibility(
  mediaId: string,
  visibility: 'public' | 'private',
): Promise<MediaActionResult> {
  return call('PATCH', `/api/media/${encodeURIComponent(mediaId)}`, { visibility });
}

// ── Owner: delete ─────────────────────────────────────────────────────────────

export async function deleteMedia(mediaId: string): Promise<MediaActionResult> {
  return call('DELETE', `/api/media/${encodeURIComponent(mediaId)}`);
}

// ── Not Interested / Hide ─────────────────────────────────────────────────────

export async function hideMedia(mediaId: string): Promise<MediaActionResult> {
  return call('POST', `/api/media/${encodeURIComponent(mediaId)}/report`, {
    reason: 'not_interested',
  });
}

// ── Stamp It reaction — RETIRED (MD424; testing-mode WP-17) ─────────────────

/**
 * reactToMediaStampIt called POST /api/media/:id/react (media_stamp_reactions)
 * and had no caller. It was a second, separately counted stamp gesture beside
 * Stamp — two stamps and two counts for one act, against the spec's single
 * Stamp control and its minimal vanity metrics (MD408). Stamp is the one media
 * reaction; Comments open the post comment sheet (MediaCommentSheet).
 *
 * The server route stays for API callers; census-media §46 records the
 * decision. These lines keep the former line span (the file is cited by line).
 */




// ── §44 signals from surfaces that hold no analytics hook (census-media §21) ──

/**
 * Send ONE §44 client signal straight to POST /media/analytics/batch — for a
 * list row or a navigation that leaves the screen before a debounced hook
 * would flush. The payload is built by features/media/telemetry's
 * `emitMediaSignal`, which drops any forbidden key before this is called; the
 * server applies its own event and payload allow-lists and its
 * MEDIA_ANALYTICS_ENABLED gate on top. Fire-and-forget: never throws.
 */
export async function recordMediaSignal(
  type: string,
  payload: object,
): Promise<MediaActionResult> {
  return call('POST', '/api/media/analytics/batch', { events: [{ type, payload }] });
}

/** A recorder with the shape `emitMediaSignal` takes, sending each signal on its own. */
export function mediaSignalRecorder(type: string, payload?: object): void {
  void recordMediaSignal(type, payload ?? {}).catch(() => {});
}
