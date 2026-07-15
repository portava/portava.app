/**
 * Pure helpers for the passport share feature.
 *
 * Extracted from usePassportShare.ts so these functions can be imported and
 * tested in Node.js without React/React Native native module bindings.
 */

export function makeDeepLink(username: string): string {
  return `travelbuddy://passport/@${encodeURIComponent(username)}`;
}

export function makeWebFallback(username: string): string {
  const webOrigin =
    process.env.EXPO_PUBLIC_WEB_ORIGIN ||
    (() => {
      const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
      try {
        return new URL(apiBase).origin;
      } catch {
        return '';
      }
    })();
  const base = webOrigin.replace(/\/$/, '');
  return base
    ? `${base}/u/${encodeURIComponent(username)}`
    : `https://travelbuddy.app/u/${encodeURIComponent(username)}`;
}

/** Ensure the URI has exactly one file:// prefix regardless of what captureRef returns. */
export function toFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}
