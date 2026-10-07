/**
 * PlaceStampService — the ONE writer of a Passport Place stamp (census-passport
 * P61), under lead ruling D-84 (docs/ops/lead-rulings-20261007-media.md):
 *
 *   "A verified check-in (QR or geofence) at a canonical place earns a Place
 *    stamp. The stamp carries place_id; PassportPrivacyGuard.guardStamp keeps it
 *    from anyone but the owner [its Place-stamp clause, added after verifier N1]. One Place stamp per person per place. No Place
 *    stamp for a check-in inside the person's protected zones. It is earned,
 *    factual and shows why and when (OD-TRUST-7). It is written only after
 *    migration 2880 and a place-keyed uniqueness rule are applied."
 *
 * HOW EACH CLAUSE IS MET
 *   - The act: callers pass a check-in the server ALREADY verified (today the
 *     GPS-verified, non-suspicious hidden gem visit, whose gem carries a
 *     canonical_place_id). Plan geofence check-ins carry no canonical place
 *     (plan_geofences → trip_plan_items has no place id), so they earn none.
 *   - One per person per place: createStamp deduplicates a Place stamp on
 *     (user_id, place_id), mirroring 3800's passport_stamps_place_dedup_idx.
 *   - Protected zones: the check-in point is classified against the active
 *     protected-zone policy (lib/protectedZoneStore, the one reader). Anything
 *     but `allow` — and a policy that could not be read — writes nothing.
 *     There is no per-traveller zone store in this tree yet; when one exists it
 *     joins this check.
 *   - Why and when: source_type (the act) and awarded_at (the instant) are
 *     written on the stamp, as on every v1 stamp.
 *   - Ordering: `passport_place_stamps_enabled` (3800, seeded FALSE) is read
 *     first. Off, absent or unreadable: nothing is written, so no 'place'
 *     insert can reach a database where 2880's label is not yet applied and be
 *     rejected 23514 into a silent null.
 *
 * FAIL CLOSED THROUGHOUT. Every unreadable input is a reason not to award;
 * a check-in the traveller makes again can earn it later. Never throws.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "../../lib/featureFlags.js";
import { loadActiveProtectedZones } from "../../lib/protectedZoneStore.js";
import { classifyAgainstProtected } from "../../lib/protectedLocations.js";
import { point, type MapObject } from "../../lib/mapObjects.js";
import { createStamp } from "./PassportStampService.js";
import type { VisibilityTier } from "./PassportPrivacyGuard.js";

export const PASSPORT_PLACE_STAMPS_FLAG = "passport_place_stamps_enabled";

/** The verified acts that may earn a Place stamp. */
export type PlaceCheckinSource = "hidden_gem_visit";

export interface PlaceCheckin {
  userId: string;
  /** The canonical place the check-in was verified at. Null ⇒ no Place stamp. */
  placeId: string | null | undefined;
  /** Where the verified check-in was made — used only for the protected-zone check, never stored. */
  lat: number;
  lng: number;
  city?: string | null;
  country?: string | null;
  tripId?: string | null;
  sourceType: PlaceCheckinSource;
}

export type PlaceStampOutcome =
  | "awarded"
  | "already_held"
  | "no_place"
  | "flag_off"
  | "protected_zone"
  | "zone_policy_unreadable"
  | "visibility_unreadable"
  | "write_failed";

export async function awardPlaceStampForCheckin(
  sc: SupabaseClient | null | undefined,
  c: PlaceCheckin,
): Promise<PlaceStampOutcome> {
  try {
    if (typeof c.placeId !== "string" || c.placeId.trim() === "") return "no_place";
    if (!sc) return "flag_off";
    if (!(await isFlagEnabled(sc, PASSPORT_PLACE_STAMPS_FLAG))) return "flag_off";
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return "protected_zone";

    const zones = await loadActiveProtectedZones(sc);
    if (zones === null) return "zone_policy_unreadable";
    const at: MapObject = {
      id: `place-stamp:${c.placeId}`,
      kind: "place",
      geometry: point(c.lat, c.lng),
      title: "",
      privacyClass: "place_level",
      renderingPriority: 0,
    } as MapObject;
    if (classifyAgainstProtected(at, zones).action !== "allow") return "protected_zone";

    // The traveller's own default stamp visibility. createStamp falls back to
    // "public" when this read fails; a Place stamp does not — it is not written.
    const { data: pref, error: prefErr } = await sc
      .from("passport_visibility_preferences")
      .select("default_stamp_visibility")
      .eq("user_id", c.userId)
      .maybeSingle();
    if (prefErr) return "visibility_unreadable";
    const visibility = ((pref as { default_stamp_visibility?: VisibilityTier } | null)?.default_stamp_visibility ?? "public") as VisibilityTier;

    const result = await createStamp(sc, {
      userId: c.userId,
      stampType: "place",
      placeId: c.placeId,
      city: c.city ?? null,
      country: c.country ?? null,
      tripId: c.tripId ?? null,
      verificationLevel: "checkin",
      sourceType: c.sourceType,
      visibility,
    });
    if (!result) return "write_failed";
    return result.isNew ? "awarded" : "already_held";
  } catch {
    return "write_failed";
  }
}
