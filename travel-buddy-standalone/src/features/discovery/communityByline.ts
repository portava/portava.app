/**
 * communityByline — the client half of the community-byline redaction shape.
 * census-discovery C19 / §6 D2.
 *
 * THE SERVER'S DECISION IS THE ONE THAT COUNTS
 * ============================================
 * `artifacts/api-server/src/routes/discovery.ts` computes exactly ONE privacy
 * decision per submitter — `nameAllowed` (self-exemption first, then the
 * `allow_profile_discovery` opt-in) — and gives it two presentations on the
 * wire:
 *
 *   displayName   the CANONICAL shape. The submitter's real name iff
 *                 `nameAllowed`, otherwise `null`. Never a handle.
 *   name          the LEGACY shape, kept additively so no live byline blanked
 *                 during the rollout. When the name is withheld it carries the
 *                 literal `"@username"`; when there is no profile name at all
 *                 it carries `"Traveler"`.
 *
 * This module reads `displayName` and `handle`. It deliberately DOES NOT READ
 * `name`, and that omission is the requirement, not an oversight:
 *
 *   - `name` is a presentation, not a decision. A real name sitting in `name`
 *     while `displayName` is null is a contradiction the client must resolve in
 *     favour of the withholding side — otherwise a partial rollout, a stale
 *     cache entry or a future server regression turns into a leaked identity on
 *     a screen. Privacy failures must be fail-closed.
 *   - Reading `name` is also what PINS the legacy field in place. While a
 *     client renders it raw, the server cannot stop baking `@username` into it
 *     without blanking a live byline. Once nothing reads it, it can go.
 *
 * The fallback ladder itself is not invented here: it is
 * `src/lib/displayIdentity.ts#primaryIdentityText`, the universal client-side
 * display-name rule every other surface already uses (real name → `@handle` →
 * "Traveler"). This module's whole job is to choose what to HAND it.
 */
import { primaryIdentityText } from '../../lib/displayIdentity.ts';

/**
 * The two fields the byline is allowed to see.
 *
 * Both optional so a caller may pass a wider object (a served `submittedBy`, a
 * `TravelerPick.user`) without restating it. A caller that has no `displayName`
 * at all is treated as "the server withheld the name" — the safe reading.
 */
export interface CommunityBylineSubject {
  /** Canonical byline field. Real name iff the server authorised it, else null. */
  displayName?: string | null;
  /** Bare username, with or without a leading `@`. Not a name. */
  handle?: string | null;
}

/**
 * The one line a Discovery community byline renders.
 *
 * Resolved from (`displayName`, `handle`) only. Never blank: a withheld name
 * with no handle reads "Traveler", which is what the server itself falls back
 * to, rather than an empty string that would look like a rendering bug.
 */
export function communityBylineText(
  subject: CommunityBylineSubject | null | undefined,
): string {
  return primaryIdentityText({
    displayName: subject?.displayName ?? null,
    handle: subject?.handle ?? null,
  });
}
