/**
 * googlePlacesReason — machine-readable failure reasons for the Google Places
 * routes.
 *
 * WHY THIS EXISTS
 * ===============
 * `/places/google-autocomplete` and `/places/google-details` collapsed FOUR
 * distinct conditions into one indistinguishable wire shape:
 *
 *   | condition            | autocomplete           | details            |
 *   |----------------------|------------------------|--------------------|
 *   | missing API key      | { places: [] }         | { details: null }  |
 *   | non-OK HTTP          | { places: [] }         | { details: null }  |
 *   | non-OK status body   | { places: [] }         | { details: null }  |
 *   | genuinely no match   | { places: [] }         | { details: null }  |
 *
 * A caller could not tell *"there is no such city"* from *"the API is switched
 * off"*. `places.ts` documented that as graceful degradation, and it is
 * graceful — it is also **silent**, and it is why destination search returned
 * empty for Barcelona, Madrid and New York with a demonstrably working key and
 * nobody noticed.
 *
 * That is the governing invariant's third face:
 *
 *   ABSENCE OF EVIDENCE MUST NEVER SILENTLY BECOME EVIDENCE OF ABSENCE.
 *
 * And it is why the fix is *this* rather than a change of endpoint: the endpoint
 * question is answerable, but only by a system that reports what the endpoint
 * said. The sibling routes already prove the pattern — `/places/photo` and
 * `/places/fsq-photo` return a `reason` on every failure path (#61, #62, #64),
 * which is exactly why the Foursquare 429 and the Google key state were
 * detectable at all.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE
 * ============================================
 * `ZERO_RESULTS` is NOT a failure. It is Google saying "I looked, there is
 * nothing." Every other non-`OK` status is the API declining to answer. Folding
 * those together is the original defect, so they are separated here and the
 * separation is pinned by test.
 */

/**
 * A `reason` describing why a Google Places call produced no usable result.
 * `null` means "no failure to report" — the caller had a genuine empty result
 * and should say so rather than inventing a fault.
 */
export type GooglePlacesReason = string | null;

/**
 * Prefix marking the legacy `maps.googleapis.com` Places API surface.
 *
 * STATUS 2026-08-15: **no route calls the legacy surface any more.** Both
 * `google-autocomplete` and `google-details` migrated to Places API (New).
 *
 * `legacyStatusReason` and `legacyHttpReason` are retained deliberately and on
 * a condition, not indefinitely: the migration is NOT yet confirmed to be the
 * remedy, because the legacy failure's exact cause is still unknown — the
 * observability fix that would reveal it has not reached production. If the
 * fault turns out to be key- or referer-scoped rather than API-enablement, it
 * applies to the New surface too and the migration may have to be reverted.
 * These keep that revert cheap.
 *
 * **DELETE THEM once a live `reason` from the New surface confirms the
 * migration worked.** An unused export with no expiry condition is how dead
 * code starts looking load-bearing.
 */
export const LEGACY_PREFIX = "google_places_legacy";

/** Prefix marking the Places API (New) `places.googleapis.com` surface. */
export const NEW_PREFIX = "google_places_new";

function normalise(status: string): string {
  return status.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Map a legacy Places API `status` field to a reason.
 *
 * Returns `null` for `OK` and for `ZERO_RESULTS` — a real, successful empty
 * answer is not a fault and must not be reported as one. Reporting it as a
 * fault would be the mirror image of the defect this module fixes: evidence of
 * absence becoming absence of evidence.
 */
export function legacyStatusReason(status: string | null | undefined): GooglePlacesReason {
  if (!status) return `${LEGACY_PREFIX}_no_status`;
  const s = status.trim().toUpperCase();
  if (s === "OK" || s === "ZERO_RESULTS") return null;
  return `${LEGACY_PREFIX}_${normalise(s)}`;
}

/** Reason for a non-2xx HTTP response from the legacy surface. */
export function legacyHttpReason(httpStatus: number): string {
  return `${LEGACY_PREFIX}_http_${httpStatus}`;
}

/**
 * Map a Places API (New) error body to a reason.
 *
 * The New API reports failures as an `error` object, with the useful
 * discriminator at `error.details[].reason` (e.g. `SERVICE_DISABLED`) and a
 * numeric-ish `error.status` (e.g. `PERMISSION_DENIED`) alongside. Prefer the
 * detail reason; fall back to the status; fall back to the HTTP code.
 */
export function newApiErrorReason(body: unknown, httpStatus: number): string {
  const b = body as
    | { error?: { status?: string; details?: Array<{ reason?: string }> } }
    | null
    | undefined;
  const detail = b?.error?.details?.find((d) => typeof d?.reason === "string")?.reason;
  if (detail) return `${NEW_PREFIX}_${normalise(detail)}`;
  const status = b?.error?.status;
  if (typeof status === "string" && status.trim() !== "") {
    return `${NEW_PREFIX}_${normalise(status)}`;
  }
  return `${NEW_PREFIX}_http_${httpStatus}`;
}

/**
 * True when a reason denotes the API refusing to serve us, as opposed to
 * serving us an empty answer.
 *
 * This is the predicate an alert or a health check should use. It deliberately
 * does NOT include `no_status`-style parse problems as "working" — an
 * unparseable response is a failure to observe, and under the governing
 * invariant a failure to observe is never treated as evidence that things are
 * fine.
 */
export function isProviderRefusal(reason: GooglePlacesReason): boolean {
  if (!reason) return false;
  return reason.startsWith(LEGACY_PREFIX) || reason.startsWith(NEW_PREFIX);
}
