/**
 * neighborhoodOnlyMode — spec §34 "Show neighborhood only" (census-media §36,
 * MD262), the WRITE-side gate.
 *
 * §34 lists five choices a person makes when they post. `neighborhood_only` is
 * the fifth, added to `post_location_privacy_mode` by migration 3350. What the
 * value DISCLOSES is decided where every other mode is decided —
 * lib/mediaLocationVisibility.locationPrivacyModeToCeiling (→ 'neighborhood')
 * and lib/postSchemas.mapPublicPost (venue name withheld) — and neither of
 * those is gated: a stored `neighborhood_only` post is held at neighborhood
 * whatever the flag says, so turning the flag off can never widen one.
 *
 * What IS gated is whether a person may CHOOSE it: the create and the
 * location-privacy PATCH both ask `neighborhoodOnlyModePermitted` before
 * writing, and refuse the value while `media_neighborhood_only_mode_enabled` is
 * off, absent or unreadable. That is also what keeps the value off a database
 * that 3350 has not been applied to, where Postgres would reject the label.
 *
 * Every OTHER mode is untouched by this module: the gate answers true for any
 * value that is not `neighborhood_only`, without a flag read.
 */
import { isFlagEnabled } from "../featureFlags.js";

/** The §34 "Show neighborhood only" value of `post_location_privacy_mode` (3350). */
export const NEIGHBORHOOD_ONLY_MODE = "neighborhood_only" as const;

/** Seeded FALSE by 3350. Read fail-closed. */
export const NEIGHBORHOOD_ONLY_MODE_FLAG = "media_neighborhood_only_mode_enabled";

export const NEIGHBORHOOD_ONLY_DISABLED_MESSAGE =
  "Showing only the neighbourhood is not available yet. Choose another location option.";

/**
 * May this location mode be WRITTEN now? True for every mode except
 * `neighborhood_only`, which needs the flag. No client and a failed flag read
 * both answer false — the value is refused, never written on a guess.
 */
export async function neighborhoodOnlyModePermitted(sc: unknown, mode: unknown): Promise<boolean> {
  if (mode !== NEIGHBORHOOD_ONLY_MODE) return true;
  if (sc == null) return false;
  try {
    return await isFlagEnabled(sc, NEIGHBORHOOD_ONLY_MODE_FLAG);
  } catch {
    return false;
  }
}
