/**
 * HiddenGemPrivacyGuard
 *
 * Single choke point for coordinate disclosure.
 * Rules by sensitivity_level:
 *   public              → full exact coords returned
 *   approximate         → approx_lat/lng centroid only (neighbourhood level)
 *   reveal_after_save   → exact coords only if caller has a hidden_gem_saves row
 *   reveal_after_acceptance → exact coords only if caller is an accepted trip member
 *   protected           → coords NEVER returned publicly (null always)
 *
 * Called by every route and service before serialising gem data.
 * Coordinates are NEVER passed to the LLM or Telegraph for protected gems.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SensitivityLevel =
  | "public"
  | "approximate"
  | "reveal_after_save"
  | "reveal_after_acceptance"
  | "protected";

export interface GemCoordContext {
  id?: string;
  sensitivity_level: SensitivityLevel;
  latitude: number | null;
  longitude: number | null;
  approx_latitude: number | null;
  approx_longitude: number | null;
}

export interface ResolvedCoords {
  lat: number | null;
  lng: number | null;
  coordsRevealed: boolean;
  /** "exact" | "approximate" | "hidden" */
  coordsPrecision: "exact" | "approximate" | "hidden";
}

/**
 * Resolve the coordinates to expose for a single gem, given caller context.
 *
 * @param gem            Raw gem row (must have sensitivity_level, latitude, longitude, approx_*)
 * @param db             Service-role client (for save/trip-member lookups)
 * @param callerId       Authenticated caller's user ID, or null for anonymous
 * @param submitterId    gem.submitted_by — owner always gets exact coords
 * @param callerTripId   Trip ID context supplied by the caller (for reveal_after_acceptance check)
 */
export async function resolveGemCoords(
  gem: GemCoordContext,
  db: SupabaseClient | null,
  callerId: string | null,
  submitterId: string | null,
  callerTripId?: string | null,
): Promise<ResolvedCoords> {
  const { sensitivity_level, latitude, longitude, approx_latitude, approx_longitude } = gem;

  // Owner always gets exact coords
  if (callerId && callerId === submitterId) {
    return { lat: latitude, lng: longitude, coordsRevealed: true, coordsPrecision: "exact" };
  }

  switch (sensitivity_level) {
    case "public":
      return { lat: latitude, lng: longitude, coordsRevealed: true, coordsPrecision: "exact" };

    case "approximate":
      return {
        lat: approx_latitude,
        lng: approx_longitude,
        coordsRevealed: approx_latitude != null,
        coordsPrecision: "approximate",
      };

    case "reveal_after_save": {
      if (!callerId || !db) break;
      const { data: saveRow } = await db
        .from("hidden_gem_saves")
        .select("gem_id")
        .eq("gem_id", (gem as any).id)
        .eq("user_id", callerId)
        .maybeSingle();
      if (saveRow) {
        return { lat: latitude, lng: longitude, coordsRevealed: true, coordsPrecision: "exact" };
      }
      break;
    }

    case "reveal_after_acceptance": {
      if (!callerId || !db || !callerTripId) break;
      // Dual check: caller must be an accepted trip member AND the gem must be
      // explicitly linked to that specific trip via trip_plan_items.
      // Without the gem↔trip binding check, any accepted trip membership would
      // reveal coordinates — a caller-controlled over-disclosure vector.
      const [{ data: memberRow }, { data: planRow }] = await Promise.all([
        db
          .from("trip_members")
          .select("user_id")
          .eq("trip_id", callerTripId)
          .eq("user_id", callerId)
          .eq("status", "accepted")
          .maybeSingle(),
        db
          .from("trip_plan_items")
          .select("id")
          .eq("trip_id", callerTripId)
          .eq("source_type", "hidden_gem")
          .eq("source_id", gem.id)
          .maybeSingle(),
      ]);
      if (memberRow && planRow) {
        return { lat: latitude, lng: longitude, coordsRevealed: true, coordsPrecision: "exact" };
      }
      break;
    }

    case "protected":
    default:
      return { lat: null, lng: null, coordsRevealed: false, coordsPrecision: "hidden" };
  }

  // Fallback: approximate if available, else hidden
  if (approx_latitude != null) {
    return { lat: approx_latitude, lng: approx_longitude, coordsRevealed: false, coordsPrecision: "approximate" };
  }
  return { lat: null, lng: null, coordsRevealed: false, coordsPrecision: "hidden" };
}

/**
 * Apply privacy guard to a raw gem row for API serialisation.
 * Returns a safe public object — exact coords stripped according to sensitivity rules.
 * Coordinates NEVER appear when sensitivity = protected.
 */
export async function applyGemPrivacy(
  raw: any,
  db: SupabaseClient | null,
  callerId: string | null,
  callerTripId?: string | null,
): Promise<any> {
  const coords = await resolveGemCoords(
    raw,
    db,
    callerId,
    raw.submitted_by ?? null,
    callerTripId,
  );

  const { latitude: _lat, longitude: _lng, approx_latitude: _alat, approx_longitude: _alng, ...rest } = raw;

  return {
    ...rest,
    lat: coords.lat,
    lng: coords.lng,
    coordsPrecision: coords.coordsPrecision,
  };
}

/**
 * Apply privacy guard to an array of gem rows in parallel.
 */
export async function applyGemPrivacyBatch(
  rows: any[],
  db: SupabaseClient | null,
  callerId: string | null,
  callerTripId?: string | null,
): Promise<any[]> {
  return Promise.all(rows.map((r) => applyGemPrivacy(r, db, callerId, callerTripId)));
}

/**
 * Check whether a gem should be included in Compass / LLM context.
 * Protected gems are NEVER passed to the LLM — not even their name or city.
 * Returns false for protected gems regardless of any other flag.
 */
export function isGemLlmSafe(sensitivityLevel: SensitivityLevel): boolean {
  return sensitivityLevel !== "protected";
}

// ── Gem IDENTITY disclosure (name + id), as distinct from coordinates ─────────

/** The minimum row shape needed to decide whether a gem may be NAMED to a viewer. */
export interface GemIdentityContext {
  id?: string | null;
  status?: string | null;
  sensitivity_level?: SensitivityLevel | string | null;
  submitted_by?: string | null;
}

/**
 * May this viewer be told that this gem EXISTS — its id and its name?
 *
 * This is the identity counterpart to `resolveGemCoords`, which only ever
 * decided COORDINATES. Naming a gem is its own disclosure: a surface that binds
 * a gem's name/id to an ordinary media item's canonical place de-anonymizes the
 * gem's location just as surely as handing out its latitude, because the place
 * is separately resolvable.
 *
 * The rule is not a new policy — it is the database's own, the `hidden_gems`
 * SELECT policy laid down in migration 0043:
 *
 *     hidden_gems_public_read: status = 'active' AND sensitivity_level = 'public'
 *
 * plus the owner bypass every gem surface already grants the submitter. Media
 * surfaces read through the SERVICE client, which bypasses RLS — so this
 * predicate is what puts the policy back. It matches CompassHiddenGemService's
 * `.eq("sensitivity_level", "public")` inclusion rule, so Compass and the media
 * surfaces agree on exactly one answer.
 *
 * FAIL CLOSED: an absent / unrecognised sensitivity or status discloses nothing.
 */
export function mayDiscloseGemIdentity(
  gem: GemIdentityContext | null | undefined,
  viewerId: string | null,
): boolean {
  if (!gem) return false;
  // Owner bypass — the submitter already knows their own gem.
  if (viewerId && gem.submitted_by && gem.submitted_by === viewerId) return true;
  // Anything but an ACTIVE, PUBLIC gem is undisclosable to everyone else. An
  // undetermined (null/undefined/garbage) value on either column lands here.
  return gem.status === "active" && gem.sensitivity_level === "public";
}
