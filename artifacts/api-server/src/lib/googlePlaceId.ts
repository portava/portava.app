/**
 * googlePlaceId — the ONE definition of how a Google place id is namespaced.
 *
 * THE CONTRACT
 * ============
 *   `/places/google-autocomplete` OWNS the namespacing decision. It emits
 *   `google-<placeId>`, because `Place.id` is a cross-source identity in the
 *   client — `nominatim-…`, `fsq-…`, `google-…` — and the prefix is what keeps
 *   two sources from colliding on the same id.
 *
 *   `/places/google-details` AGREES WITH IT EXPLICITLY. It accepts the id in
 *   exactly the form autocomplete emits, and also accepts a bare id, and it
 *   does so by calling into this module rather than by knowing the prefix.
 *
 * WHY THIS FILE EXISTS RATHER THAN TWO STRING LITERALS
 * ====================================================
 * It already went wrong once, silently, for three weeks.
 *
 * `google-` was hardcoded in `routes/places.ts` (emitting it) and again in
 * `GlobalPlacePicker.tsx` (stripping it). The two halves of one user flow
 * therefore disagreed about the id format, and only a `.replace(/^google-/, '')`
 * on the client kept the flow working. Nothing on the server knew that strip
 * existed; nothing tested the round trip; and either side could have changed
 * without the other noticing.
 *
 * Measured on production 2026-08-15, after the Places API (New) migration:
 *
 *   place_id=google-ChIJ5TCOcRaYpBIRCmZHTz37sEQ
 *     -> {"details":null,"reason":"google_places_new_invalid_argument"}
 *   place_id=ChIJ5TCOcRaYpBIRCmZHTz37sEQ        (same id, prefix stripped)
 *     -> {"details":{"lat":41.3874…,"lng":2.1686…,"formattedAddress":"Barcelona, Spain"}}
 *
 * The contract predates the migration: the prefix has been emitted since
 * 2026-07-27 and details has always wanted a bare id. The migration did not
 * cause this — **the `reason` field made it audible.** Yesterday the failing
 * call returned a bare `{"details":null}` and said nothing at all.
 *
 * So: one definition, imported by both sides, with a round-trip test that fails
 * if they ever disagree again.
 */

/**
 * The source namespace for Google-sourced places.
 *
 * Change it here and both routes follow. Do NOT re-hardcode it at a call site;
 * that is the exact shape of the defect this module exists to prevent.
 */
export const GOOGLE_PLACE_ID_PREFIX = "google-";

/**
 * Wrap a raw Google place id in the namespace the client consumes.
 *
 * Idempotent: an already-namespaced id is returned unchanged, so this can never
 * produce `google-google-…` if a caller applies it twice.
 */
export function namespaceGooglePlaceId(rawPlaceId: string): string {
  if (rawPlaceId.startsWith(GOOGLE_PLACE_ID_PREFIX)) return rawPlaceId;
  return `${GOOGLE_PLACE_ID_PREFIX}${rawPlaceId}`;
}

/**
 * Recover the raw Google place id from either form.
 *
 * Accepting BOTH is deliberate and is not laxity for its own sake:
 *
 *   - the namespaced form is what `/places/google-autocomplete` emits, so a
 *     caller can round-trip our own output without transforming it;
 *   - the bare form is what the current client sends, because it strips the
 *     prefix itself. Rejecting it would break destination selection in
 *     production, which works today.
 *
 * Only ONE leading prefix is removed. A place id that legitimately began with
 * the literal text `google-` would otherwise be corrupted by repeated
 * stripping — Google's ids are opaque and we do not get to assume their shape.
 */
export function denamespaceGooglePlaceId(id: string): string {
  return id.startsWith(GOOGLE_PLACE_ID_PREFIX)
    ? id.slice(GOOGLE_PLACE_ID_PREFIX.length)
    : id;
}
