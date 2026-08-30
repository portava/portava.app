/**
 * PassportStampService
 *
 * Creates passport stamps from verified source events.
 * Uses the unique index on (user_id, stamp_type, country, city) to deduplicate —
 * a second upsert for the same city returns the existing stamp ID.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VisibilityTier } from "./PassportPrivacyGuard.js";
import { recordTrustEvent } from "../trust/TrustEventService.js";
import { resolveOrEnqueue } from "../../lib/stamps/StampCatalogService.js";
import { countryCodeFromName } from "../../lib/stamps/countryLookup.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "PassportStampService" });

export type StampType =
  | "city"
  | "neighborhood"
  | "plan"
  | "host"
  | "hidden_gem"
  | "safe_return"
  | "activity"
  | "trip_crew"
  | "compass_ai"
  | "qr_checkin";

export type VerificationLevel =
  | "unverified"
  | "gps"
  | "checkin"
  | "safe_return"
  | "crew"
  | "admin";

export interface CreateStampInput {
  userId: string;
  stampType: StampType;
  country?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  placeId?: string | null;
  planId?: string | null;
  tripId?: string | null;
  sourceType?: string;
  verificationLevel?: VerificationLevel;
  /** Defaults to user's preference or 'public' for city stamps, 'private' for safe_return. */
  visibility?: VisibilityTier;
  earnedAt?: string;
}

export interface StampResult {
  id: string;
  isNew: boolean;
}

/**
 * Create (or no-op if duplicate) a passport stamp.
 * Returns the stamp id and whether it was newly created.
 */
export async function createStamp(
  db: SupabaseClient,
  input: CreateStampInput,
): Promise<StampResult | null> {
  const {
    userId, stampType, country, city, neighborhood,
    placeId, planId, tripId, sourceType = "system",
    verificationLevel = "unverified", earnedAt,
  } = input;

  // Apply visibility: explicit > safe_return default > user preference > "public"
  let visibility: VisibilityTier;
  if (input.visibility) {
    visibility = input.visibility;
  } else if (stampType === "safe_return") {
    visibility = "private";
  } else {
    // Look up user's default stamp visibility preference
    try {
      const { data: prefRow, error: prefError } = await db
        .from("passport_visibility_preferences")
        .select("default_stamp_visibility")
        .eq("user_id", userId)
        .maybeSingle();
      if (prefError) {
        logger.error({ table: "passport_visibility_preferences", op: "select", message: prefError.message }, "createStamp visibility-preference lookup failed — falling back to public");
      }
      visibility = ((prefRow as any)?.default_stamp_visibility as VisibilityTier) ?? "public";
    } catch (err) {
      logger.error({ table: "passport_visibility_preferences", op: "select", message: err instanceof Error ? err.message : String(err) }, "createStamp visibility-preference lookup threw — falling back to public");
      visibility = "public";
    }
  }

  // Check for existing stamp — mirrors COALESCE(country,'') / COALESCE(city,'') unique index
  // Use .is(col, null) for null values; .eq(col, val) for non-null values.
  let dedupQuery = db
    .from("passport_stamps")
    .select("id")
    .eq("user_id", userId)
    .eq("stamp_type", stampType);
  if (country != null && country !== "") {
    dedupQuery = dedupQuery.eq("country", country) as typeof dedupQuery;
  } else {
    dedupQuery = dedupQuery.is("country", null) as typeof dedupQuery;
  }
  if (city != null && city !== "") {
    dedupQuery = dedupQuery.eq("city", city) as typeof dedupQuery;
  } else {
    dedupQuery = dedupQuery.is("city", null) as typeof dedupQuery;
  }
  const { data: existing } = await dedupQuery.maybeSingle();

  if (existing) {
    return { id: (existing as any).id, isNew: false };
  }

  const { data, error } = await db
    .from("passport_stamps")
    .insert({
      user_id: userId,
      stamp_type: stampType,
      country: country ?? null,
      city: city ?? null,
      neighborhood: neighborhood ?? null,
      place_id: placeId ?? null,
      plan_id: planId ?? null,
      trip_id: tripId ?? null,
      source_type: sourceType,
      verification_level: verificationLevel,
      visibility,
      // Live column is awarded_at (earned_at does not exist on passport_stamps).
      awarded_at: earnedAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    logger.error({ table: "passport_stamps", op: "insert", message: error.message }, "createStamp failed");
    return null;
  }
  const stampId = (data as any).id;

  // Fire-and-forget: resolve universal catalog entry for v1 passport_stamps path
  Promise.resolve().then(async () => {
    try {
      // Resolve the country NAME to its real ISO code. Slicing the first two
      // letters fabricated codes — "Vietnam" → "VI" (US Virgin Islands),
      // "Japan" → "JA" — which split the catalog into a wrong-country key and
      // steered the wrong artwork (audit STAMP·H3). Two of the launch cities
      // (Da Nang / Vietnam, Tokyo / Japan) were affected. An unrecognised name
      // resolves to the "XX" sentinel (as before) rather than a fake code.
      const cc = countryCodeFromName(country) ?? "XX";
      const { catalogEntry } = await resolveOrEnqueue(
        db,
        {
          stampType:    stampType,
          country:      country ?? "Unknown",
          country_code: cc,
          city:         city ?? null,
          displayName:  city ?? country ?? stampType,
        },
        stampType,
        `passport_stamp:${stampId}`,
      );
      if (catalogEntry?.id) {
        await db
          .from("passport_stamps")
          .update({ catalog_id: catalogEntry.id })
          .eq("id", stampId);
      }
    } catch {
      // Never block the v1 award path
    }
  }).catch(() => {});

  // Feed new passport stamp into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(db, {
    userId,
    eventType: "passport_stamp_earned",
    category: "passport_authenticity",
    delta: 2,
    severity: "minor",
    sourceType: "passport",
    sourceId: stampId,
    dedupWindowHours: 48,
  });

  return { id: stampId, isNew: true };
}

/**
 * Update the visibility of a stamp.
 * Only the stamp owner can do this (caller must pass their userId for verification).
 */
export async function updateStampVisibility(
  db: SupabaseClient,
  stampId: string,
  userId: string,
  visibility: VisibilityTier,
): Promise<boolean> {
  const { data, error } = await db
    .from("passport_stamps")
    .update({ visibility, updated_at: new Date().toISOString() })
    .eq("id", stampId)
    .eq("user_id", userId)
    .select("id");

  if (error) {
    logger.error({ table: "passport_stamps", op: "update", message: error.message }, "updateStampVisibility failed");
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Load stamps for a user, optionally filtered.
 */
export async function loadStamps(
  db: SupabaseClient,
  userId: string,
  filters: {
    country?: string;
    city?: string;
    stampType?: string;
    visibility?: VisibilityTier;
    /** Number of stamps to return. Default 100, max 200. */
    limit?: number;
    /** Zero-based offset for pagination. Default 0. */
    offset?: number;
  } = {},
): Promise<any[]> {
  const limit  = Math.min(200, Math.max(1, filters.limit  ?? 100));
  const offset = Math.max(0, filters.offset ?? 0);

  // Live column is awarded_at; alias it to earned_at so downstream consumers
  // (PassportPrivacyGuard.StampRow, route serializers) keep their shape.
  let query = db
    .from("passport_stamps")
    .select("id, stamp_type, country, city, neighborhood, place_id, plan_id, trip_id, source_type, verification_level, visibility, earned_at:awarded_at, created_at")
    .eq("user_id", userId)
    .order("awarded_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.country)    query = (query as any).eq("country",    filters.country);
  if (filters.city)       query = (query as any).eq("city",       filters.city);
  if (filters.stampType)  query = (query as any).eq("stamp_type", filters.stampType);
  if (filters.visibility) query = (query as any).eq("visibility", filters.visibility);

  const { data, error } = await query;
  if (error) {
    logger.error({ table: "passport_stamps", op: "select", message: error.message }, "loadStamps failed");
    return [];
  }
  return data ?? [];
}
