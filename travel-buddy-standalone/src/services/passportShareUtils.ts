/**
 * Pure helpers for the passport share feature.
 *
 * Extracted from usePassportShare.ts so these functions can be imported and
 * tested in Node.js without React/React Native native module bindings.
 *
 * The web origin comes from `constants/canonicalUrl.ts` — the single resolver
 * for every shareable link in the tree. Do not reintroduce a local copy.
 */
import { canonicalUrl } from '../constants/canonicalUrl.ts';

export function makeDeepLink(username: string): string {
  return `travelbuddy://passport/@${encodeURIComponent(username)}`;
}

export function makeWebFallback(username: string): string {
  return canonicalUrl(`/u/${encodeURIComponent(username)}`);
}

/** Ensure the URI has exactly one file:// prefix regardless of what captureRef returns. */
export function toFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}
