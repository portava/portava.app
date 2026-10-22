/**
 * notificationStreamUtils.ts
 *
 * Pure helpers for the SSE notification stream connection logic.
 * Kept in a separate file so they can be imported in node:test without
 * pulling in React Native (AppState etc.) through useNotifications.ts.
 */

/**
 * _connectOnce — core of `useNotificationStream`'s connect logic.
 *
 * Given a pre-resolved token and API base URL, either:
 *   • returns null immediately (when token or base is absent / falsy), or
 *   • creates an XHR, sets the Authorization/Accept/Cache-Control headers,
 *     opens the SSE endpoint, and returns the XHR (without calling .send()).
 *
 * The optional `xhrFactory` lets tests inject a fake XHR instead of the real
 * global constructor.
 */
export function _connectOnce(
  token: string | null,
  base: string | null,
  xhrFactory?: () => XMLHttpRequest,
): XMLHttpRequest | null {
  if (!token || !base) return null;
  const factory = xhrFactory ?? (() => new XMLHttpRequest());
  const xhr = factory();
  xhr.open('GET', `${base}/api/me/notifications/stream`, true);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  xhr.setRequestHeader('Cache-Control', 'no-cache');
  return xhr;
}

/** First reconnect delay; also the delay after a stream that delivered data. */
export const STREAM_RECONNECT_BASE_MS = 5_000;
/** Longest wait between reconnect attempts while the stream keeps failing. */
export const STREAM_RECONNECT_MAX_MS = 300_000;

/**
 * When to reconnect after the stream ended with `httpStatus` (0 = network error), or null for "not until the app
 * comes back to the foreground". It used to be every 5 s forever: a revoked or signed-out session (401 / 403) asked
 * again twelve times a minute for as long as the app stayed open. Auth refusals stop; anything else backs off from
 * `currentDelay`, and the caller doubles the next one (`grownReconnectDelay`) until data flows again.
 */
export function nextStreamReconnectDelay(currentDelay: number, httpStatus: number): number | null {
  if (httpStatus === 401 || httpStatus === 403) return null;
  return Math.min(Math.max(currentDelay, STREAM_RECONNECT_BASE_MS), STREAM_RECONNECT_MAX_MS);
}

/** The delay to use after `delay` if the next attempt fails too: doubled, capped. */
export function grownReconnectDelay(delay: number): number {
  return Math.min(delay * 2, STREAM_RECONNECT_MAX_MS);
}
