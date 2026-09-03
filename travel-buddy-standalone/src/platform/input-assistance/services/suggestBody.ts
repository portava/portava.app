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
    sessionContext: req.sessionContext,
  };

  // §22 opt-in — ONLY a literal true opts in. Anything else omits the key.
  if (req.aiAssist === true) body.aiAssist = true;

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

  return body;
}
