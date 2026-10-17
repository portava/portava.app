/**
 * Global Input Intelligence — the POST body builder for `/input-assistance/suggest`.
 *
 * Extracted from `inputAssistance.ts` (which imports the RN/Supabase token
 * helper and therefore cannot be imported by node:test) so the body-shaping
 * logic — especially the §22 opt-in — is a PURE function that is unit-testable
 * on its own. `inputAssistance.ts` calls this to build the request body.
 *
 * OPT-IN INVARIANT (§22): `aiAssist` is included in the body ONLY when it is
 * strictly `true`. Absent/false/undefined ⇒ the key is omitted, so an ambiguous
 * value can never turn AI-assisted writing on. Mirrors the backend route, which
 * treats the flag as opted-in ONLY for boolean `true`.
 *
 * Pure module (no React, no network, no RN) — safe under node:test.
 */
import type { SuggestRequest } from '../types/inputSuggestion.ts';

/**
 * Build the exact JSON body for the suggest endpoint from a request. Only the
 * fields the gateway reads are emitted; the coarse, opt-in AI fields (`aiAssist`,
 * `city`, `draft`, `tz`) are included only when meaningfully set so a default
 * request stays byte-for-byte identical to the pre-Phase-7 body.
 */
export function buildSuggestBody(req: SuggestRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    context: req.context,
    fieldId: req.fieldId,
    text: req.text,
    limit: req.limit,
    sessionContext: sessionWithoutPosition(req.sessionContext),
  };

  // §15/§28 (census G176) — the viewer's position rides at the TOP LEVEL, the
  // one place the route reads it, coarsened; never inside the session object.
  const origin = suggestOrigin(req.sessionContext?.lat, req.sessionContext?.lng);
  if (origin) {
    body.lat = origin.lat;
    body.lng = origin.lng;
  }

  // §22 opt-in — ONLY a literal true opts in. Anything else omits the key.
  if (req.aiAssist === true) body.aiAssist = true;
  // §45 outcome-learning hint — ONLY a literal true; the server re-checks consent.
  if (req.outcomeLearning === true) body.outcomeLearning = true;

  // Coarse city-level writing context (§29) — omitted unless present.
  if (typeof req.city === 'string' && req.city.trim().length > 0) {
    body.city = req.city.trim();
  }
  if (typeof req.tz === 'string' && req.tz.trim().length > 0) {
    body.tz = req.tz.trim();
  }
  if (req.draft && Object.keys(req.draft).length > 0) {
    body.draft = req.draft;
  }

  // §48 capability handshake (census G343). Omitted unless the caller declared
  // something, so a caller that does not participate produces the same body it
  // always did — which is what keeps the handshake additive rather than a
  // flag day for every surface at once.
  if (req.client && (req.client.suggestionTypes?.length || req.client.actionTypes?.length)) {
    body.client = req.client;
  }

  return body;
}

// ── §15/§28 the viewer's position on the wire (census G176) ──────────────────
//
// THE DEFECT. Two callers hold a position the user already granted — the shared
// GlobalPlacePicker (silent nearby detection: an already-granted permission and
// the last known fix) and the search screen (`useGlobalSearchSuggestions`, only
// while permission is granted) — and both put it in `sessionContext.lat/lng`,
// which is where `InputSessionContext` declares it. This builder forwarded that
// object verbatim, so the fix went over the wire at full device precision, and
// the route — which reads the position from the top-level `lat`/`lng` only, as
// the Map search client (`search/mapSearch.ts`) sends it — dropped it. No real
// client ever got the §28 distance band or the nearby ordering.
//
// ONE TRANSPORT. The position goes where the route reads it: the top-level pair.
// It is stripped from the forwarded session object, so it cannot reach any
// server consumer of the session (task constraint, AI writing context, paste)
// by riding inside it; the server's `SuggestSessionContext` stays ID-only.
//
// PRECISION. Rounded to SUGGEST_ORIGIN_DECIMALS = 3 (~110 m), the codebase's
// neighbourhood-level rule (`lib/meetupPin.ts`). The finest band edge is 0.5 km,
// and 3 decimals move a point by at most ~78 m, so the band stays meaningful;
// the device fix itself never leaves the device. The hook's cache key is coarser
// still (2 decimals, `SuggestionCache.key`) and the scope key excludes the pair
// (`inputSessionScopeKey`), so neither the raw fix nor this value is a key.
//
// VALIDITY. Both halves or neither: finite numbers, |lat| <= 90, |lng| <= 180.
// Anything else sends no position at all, never half of one.

/** Decimal places kept on the suggest request's viewer position (~110 m). */
export const SUGGEST_ORIGIN_DECIMALS = 3;

const ORIGIN_FACTOR = 10 ** SUGGEST_ORIGIN_DECIMALS;

/** The coarse, validated pair for the wire, or null when there is no usable pair. */
export function suggestOrigin(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Math.round(lat * ORIGIN_FACTOR) / ORIGIN_FACTOR, lng: Math.round(lng * ORIGIN_FACTOR) / ORIGIN_FACTOR };
}

/** The session as forwarded: identical when it carries no position, otherwise without `lat`/`lng`. */
function sessionWithoutPosition(session: SuggestRequest['sessionContext']): SuggestRequest['sessionContext'] {
  if (!session || (!('lat' in session) && !('lng' in session))) return session;
  const { lat: _lat, lng: _lng, ...rest } = session;
  return rest;
}
