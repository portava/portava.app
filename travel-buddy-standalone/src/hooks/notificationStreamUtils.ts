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
