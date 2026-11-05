/**
 * guideApplication — the pure half of the Become a Local Guide screen
 * (app/gems/become-guide.tsx). No React, no network, so node:test can pin it.
 *
 * POST /api/hidden-gems/guides/apply is idempotent: a person who already has a
 * guide profile gets that profile back instead of a new application. So the
 * answer's `status` is what the screen reports, whatever was typed.
 */

/** The apply route keeps at most this many cities (routes/hiddenGems.ts). */
export const MAX_GUIDE_CITIES = 10;
/** The apply route cuts the bio at this length. */
export const MAX_GUIDE_BIO = 500;
/** One city name; longer than this is not a city. */
const MAX_CITY_LENGTH = 60;

/**
 * "Cebu, Manila,  cebu" → ["Cebu", "Manila"]: comma or newline separated,
 * trimmed, duplicates dropped regardless of case, first spelling kept, at most
 * MAX_GUIDE_CITIES.
 */
export function parseCityList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const city = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_CITY_LENGTH);
    if (!city) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
    if (out.length === MAX_GUIDE_CITIES) break;
  }
  return out;
}

export type GuideApplicationOutcome = 'active' | 'pending' | 'paused';

/**
 * What a guide profile's status means for the person who applied:
 *   active                 → they are a Local Guide
 *   applicant              → a reviewer has the application
 *   suspended / demoted /… → the profile exists but is not active
 */
export function guideApplicationOutcome(status: string | null | undefined): GuideApplicationOutcome {
  if (status === 'active') return 'active';
  if (status === 'applicant' || status == null) return 'pending';
  return 'paused';
}

/** The words for a failed apply. A switched-off feature is not a retry. */
export function guideApplyErrorCopy(code: string | undefined): string {
  if (code === 'feature_disabled') return 'Local Guide applications are not open right now.';
  if (code === 'unauthenticated') return 'Sign in to apply.';
  return 'Your application could not be sent. Check your connection and try again.';
}
