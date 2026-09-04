/**
 * passportQrProjection — the deliberately MINIMAL projection behind the QR /
 * Bump share sheet (spec §25).
 *
 * "QR projection is deliberately minimal: photo, first name, @handle,
 *  verification, permitted home country/interests, Follow/Connect."
 *
 * Two privacy invariants are enforced HERE, in pure code, so they can be tested
 * in isolation and can never be widened by accident:
 *
 *   1. `buildQrProjection` is an ALLOW-LIST. It takes a full identity object
 *      (which may carry email, bio, current city, home base, coordinates, trust
 *      score, last name, …) and returns ONLY the six permitted fields. Anything
 *      else is dropped — the returned object has no other keys. Home country and
 *      interests are further gated on explicit per-field permission (TABLE 24:
 *      both are "user controlled").
 *
 *   2. `buildQrPayload` — the string actually ENCODED into the QR — is just the
 *      passport deep link. Scanning it opens the passport, which is then
 *      re-projected server-side under normal privacy policy (§25: "Scanning a QR
 *      never bypasses privacy policy"). No personal data is embedded in the code
 *      itself beyond the @handle needed to resolve it.
 *
 * Only first name is ever exposed — never the full or family name.
 */
import { makeDeepLink, makeWebFallback } from '../../services/passportShareUtils.ts';

/** Superset input — real callers pass a full profile/identity; extra keys are dropped. */
export interface QrProjectionInput {
  name?: string | null;
  firstName?: string | null;
  handle?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  verified?: boolean;
  verificationLevel?: string | null;
  homeCountry?: string | null;
  interests?: string[] | null;
  // NOTE: any other fields (email, bio, currentCity, homeBase, lat, lng,
  // trustScore, phone, lastName, …) are intentionally NOT read.
  [extra: string]: unknown;
}

export interface QrProjectionPermissions {
  /** TABLE 24: home country is user-controlled — include only when permitted. */
  homeCountryPermitted?: boolean;
  /** TABLE 24: interests (travel identity) are user-controlled. */
  interestsPermitted?: boolean;
}

/** The exact, closed shape a scanned Passport QR is allowed to reveal. */
export interface MinimalQrProjection {
  /** First name only — never full/family name. */
  firstName: string | null;
  handle: string | null;
  /** Profile photo URL. */
  avatarUrl: string | null;
  verified: boolean;
  verificationLevel: string | null;
  /** null when not permitted or unset. */
  homeCountry: string | null;
  /** [] when not permitted or unset. */
  interests: string[];
}

/** Derive a first name without ever leaking the family name. */
function firstNameOf(input: QrProjectionInput): string | null {
  if (typeof input.firstName === 'string' && input.firstName.trim().length > 0) {
    return input.firstName.trim().split(/\s+/)[0];
  }
  if (typeof input.name === 'string' && input.name.trim().length > 0) {
    return input.name.trim().split(/\s+/)[0];
  }
  return null;
}

/**
 * Build the minimal, closed QR projection. The returned object contains ONLY
 * the six permitted fields — construct it as an explicit literal (not by
 * copying the input) so no extraneous profile data can ride along.
 */
export function buildQrProjection(
  input: QrProjectionInput,
  perms: QrProjectionPermissions = {},
): MinimalQrProjection {
  const homeCountryPermitted = perms.homeCountryPermitted !== false;
  const interestsPermitted = perms.interestsPermitted !== false;

  const handle =
    (typeof input.handle === 'string' && input.handle.length > 0 && input.handle) ||
    (typeof input.username === 'string' && input.username.length > 0 && input.username) ||
    null;

  const interests =
    interestsPermitted && Array.isArray(input.interests)
      ? input.interests.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];

  return {
    firstName: firstNameOf(input),
    handle,
    avatarUrl: typeof input.avatarUrl === 'string' && input.avatarUrl.length > 0 ? input.avatarUrl : null,
    verified: input.verified === true,
    verificationLevel:
      typeof input.verificationLevel === 'string' && input.verificationLevel.length > 0
        ? input.verificationLevel
        : null,
    homeCountry:
      homeCountryPermitted && typeof input.homeCountry === 'string' && input.homeCountry.length > 0
        ? input.homeCountry
        : null,
    interests,
  };
}

/** The exact set of keys a MinimalQrProjection may ever contain (test guard). */
export const MINIMAL_QR_FIELDS: ReadonlyArray<keyof MinimalQrProjection> = [
  'firstName',
  'handle',
  'avatarUrl',
  'verified',
  'verificationLevel',
  'homeCountry',
  'interests',
];

/**
 * The string ENCODED into the QR image. Deliberately just the passport deep
 * link — no personal data — so scanning resolves through normal privacy policy
 * rather than carrying a self-contained profile payload.
 */
export function buildQrPayload(username: string): string {
  return makeQrDeepLink(username);
}

/**
 * The query marker the QR image carries so the app can tell a scan from a
 * tapped link and emit §32 `passport_qr_scanned` (scanner side). It is the
 * ONLY difference between the QR payload and the plain share link, carries no
 * data about anyone, and changes nothing about what is shown — the passport
 * is still re-projected under normal privacy policy (§25).
 */
export const QR_SCAN_PARAM = 'via';
export const QR_SCAN_VALUE = 'qr';

/** The passport deep link with the scan marker appended. */
export function makeQrDeepLink(username: string): string {
  return `${makeDeepLink(username)}?${QR_SCAN_PARAM}=${QR_SCAN_VALUE}`;
}

/** True when a route's `via` param says the app was opened by scanning a Passport QR. */
export function isQrScanEntry(via: unknown): boolean {
  return typeof via === 'string' && via === QR_SCAN_VALUE;
}

/** Deep link + web fallback for the Share Link / Copy Link actions. */
export function buildShareUrls(username: string): { deepLink: string; webFallback: string } {
  return { deepLink: makeDeepLink(username), webFallback: makeWebFallback(username) };
}
