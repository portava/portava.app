/**
 * canonicalUrl — the single source of truth for the origin of every shareable
 * link the app emits.
 *
 * ## Why this file exists
 *
 * Before 2026-08-07 there were seven independent URL builders: five hardcoded
 * `https://travelbuddy.app` inline, and two more (passportShareUtils,
 * stampShareUtils) each carried their own copy of an env-resolution helper with
 * `travelbuddy.app` as the fallback.
 *
 * `travelbuddy.app` is not ours. It resolves to an AWS host that 302-redirects
 * to a domain brokerage listing (`fortune.domains/name/TravelBuddy.app`), so
 * every link the app has ever shared pointed at a for-sale page. It is also
 * absent from the production CORS allowlist, which is a single value:
 * `ALLOWED_ORIGINS = "https://portava.replit.app"` (.replit [userenv.production]).
 *
 * ## Why portava.replit.app
 *
 * It is the origin the travel-buddy-standalone deployment actually serves, per
 * this tree's own configuration — not the legacy tree's:
 *
 *   - app.json  ios.associatedDomains = ["applinks:portava.replit.app"]
 *   - app.json  android.intentFilters autoVerify=true for
 *               https://portava.replit.app/passport and /u
 *   - eas.json  EXPO_PUBLIC_WEB_ORIGIN + EXPO_PUBLIC_API_BASE_URL, preview and
 *               production profiles
 *   - .env.example  EXPO_PUBLIC_WEB_ORIGIN, annotated "must match app.json"
 *   - .replit [userenv.production]  ALLOWED_ORIGINS
 *   - artifacts/travel-buddy/.replit-artifact/artifact.toml (archived at bc1bef404) — the deployment's
 *     production build/run commands point exclusively at
 *     travel-buddy-standalone/scripts/build.js and .../server/serve.js
 *
 * ## Resolution order
 *
 * Resolved at call time, not module-eval time, so tests can vary the env.
 * (In release builds Expo statically inlines `process.env.EXPO_PUBLIC_*`, so
 * the branch collapses to a literal anyway.)
 *
 *   1. EXPO_PUBLIC_WEB_ORIGIN            — explicit override; the documented input
 *   2. origin of EXPO_PUBLIC_API_BASE_URL — same host serves the API and the
 *                                           share landing pages
 *   3. CANONICAL_APP_URL                  — pinned default below
 *
 * ## The rule
 *
 * No web-origin literal belongs anywhere else in this tree. Build links with
 * `canonicalUrl('/posts/123')`. The `travelbuddy://` deep-link scheme is a
 * separate concern (app.json `scheme`) and is unaffected by this module.
 */

/** Pinned canonical origin. The only web-domain literal in the tree. */
export const CANONICAL_APP_URL = 'https://portava.replit.app';

function stripTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * The origin to use for shareable links right now.
 *
 * Always returns a usable origin with no trailing slash — never an empty
 * string, so callers never need their own `|| 'https://…'` fallback.
 */
export function canonicalOrigin(): string {
  const explicit = (process.env.EXPO_PUBLIC_WEB_ORIGIN ?? '').trim();
  if (explicit) return stripTrailingSlash(explicit);

  const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').trim();
  if (apiBase) {
    try {
      return stripTrailingSlash(new URL(apiBase).origin);
    } catch {
      // Malformed API base — fall through to the pinned default.
    }
  }

  return CANONICAL_APP_URL;
}

/**
 * Build an absolute shareable URL from an app-relative path.
 *
 *   canonicalUrl('/posts/abc')  → 'https://portava.replit.app/posts/abc'
 *   canonicalUrl('posts/abc')   → 'https://portava.replit.app/posts/abc'
 *
 * Callers are responsible for encoding their own path segments.
 */
export function canonicalUrl(path: string): string {
  if (!path) return canonicalOrigin();
  return `${canonicalOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}
