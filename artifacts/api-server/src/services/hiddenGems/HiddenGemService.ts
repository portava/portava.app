/**
 * HiddenGemService — CRUD, save/unsave, ranking helpers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordTrustEvent } from "../trust/TrustEventService.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { recordEntityMedia } from "../../lib/mediaAssets.js";

const logger = rootLogger.child({ service: "HiddenGemService" });

const GEM_SELECT_COLS = `
  id, name, category, city, country, neighborhood,
  description, latitude, longitude, approx_latitude, approx_longitude,
  vibe_tags, price_range, safety_notes, best_time_to_go, local_etiquette,
  layover_safe, minimum_layover_minutes,
  sensitivity_level, verification_level, status,
  submitted_by, guide_verified_by,
  save_count, visit_count, report_count,
  image_url, canonical_place_id, source_type, moderation_status,
  created_at, updated_at
`.trim();

export interface CreateGemInput {
  name: string;
  category: string;
  city: string;
  country?: string | null;
  neighborhood?: string | null;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  approxLatitude?: number | null;
  approxLongitude?: number | null;
  vibeTags?: string[];
  priceRange?: string | null;
  safetyNotes?: string | null;
  bestTimeToGo?: string | null;
  layoverSafe?: boolean;
  minimumLayoverMinutes?: number | null;
  sensitivityLevel?: string;
  submittedBy: string;
  imageUrl?: string | null;
  /** UUID of the verified canonical place linked to this gem. */
  canonicalPlaceId?: string | null;
  /**
   * When true, the submitter explicitly confirmed the media depicts the
   * selected place. Stored for audit purposes.
   */
  sourceConfirmation?: boolean;
  /** Visibility tier: 'public' | 'circle_only' | 'private'. Defaults to 'public'. */
  visibility?: string | null;
  /** Free-text accessibility notes (wheelchair access, sensory-friendly, etc.). */
  accessibility?: string | null;
  /** Crowd level estimate: 'quiet' | 'moderate' | 'busy' | 'very_busy'. */
  crowdLevel?: string | null;
  /** UUID of the trip to attach this gem to at submission time (optional). */
  tripId?: string | null;
}

export interface GemListOptions {
  city?: string;
  neighborhood?: string;
  category?: string;
  layoverSafe?: boolean;
  minLayoverMinutes?: number;
  verificationLevel?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** Submit a new gem (enters pending queue). */
export async function submitGem(db: SupabaseClient, input: CreateGemInput) {
  const { data, error } = await db
    .from("hidden_gems")
    .insert({
      name: input.name,
      category: input.category,
      city: input.city,
      country: input.country ?? null,
      neighborhood: input.neighborhood ?? null,
      description: input.description ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      approx_latitude: input.approxLatitude ?? null,
      approx_longitude: input.approxLongitude ?? null,
      vibe_tags: input.vibeTags ?? [],
      price_range: input.priceRange ?? null,
      safety_notes: input.safetyNotes ?? null,
      best_time_to_go: input.bestTimeToGo ?? null,
      layover_safe: input.layoverSafe ?? false,
      minimum_layover_minutes: input.minimumLayoverMinutes ?? null,
      sensitivity_level: input.sensitivityLevel ?? "public",
      submitted_by: input.submittedBy,
      status: "pending",
      image_url: input.imageUrl ?? null,
      // ── Fields from the dedicated "Add a Gem" creation flow ─────────────────
      // These columns are written only when the caller provides them so that
      // legacy submissions that omit them do not include the column keys in the
      // insert payload at all.  PostgREST rejects any column key that is absent
      // from the live schema — even with a null value — so unconditional writes
      // would break ALL submissions before the migration is applied.
      // Remove the `!== undefined` guards once the columns are confirmed live.
      ...(input.canonicalPlaceId !== undefined
        ? { canonical_place_id: input.canonicalPlaceId }
        : {}),
      ...(input.sourceConfirmation !== undefined
        ? { source_confirmation: input.sourceConfirmation }
        : {}),
      ...(input.visibility !== undefined
        ? { visibility: input.visibility }
        : {}),
      ...(input.accessibility !== undefined
        ? { accessibility: input.accessibility }
        : {}),
      ...(input.crowdLevel !== undefined
        ? { crowd_level: input.crowdLevel }
        : {}),
    })
    .select(GEM_SELECT_COLS)
    .single();

  if (error) throw error;

  // hidden_gems has no trip_id column — attaching a gem to a trip at
  // submission time is recorded the same way the /:id/plan endpoint does it:
  // a trip_plan_items row (source_type="hidden_gem", source_id=gem id).
  // Best-effort: a failure here should not fail gem submission itself.
  if (input.tripId) {
    await db
      .from("trip_plan_items")
      .insert({
        trip_id: input.tripId,
        added_by: input.submittedBy,
        source_type: "hidden_gem",
        source_id: (data as any).id,
        title: (data as any).name,
        description: (data as any).description ?? null,
        location_name: (data as any).name,
        city: (data as any).city,
        country: (data as any).country ?? null,
        category: (data as any).category,
      })
      .then(({ error: planError }) => {
        if (planError) logger.warn({ err: planError, gemId: (data as any).id, tripId: input.tripId }, "submitGem: failed to attach gem to trip plan");
      });
  }

  // Canonical dual-write (flag-gated OFF; fail-soft — legacy image_url path
  // unaffected). Records media_assets + media_attachments(entityType=hidden_gem)
  // so the gem photo joins the §6.1 canonical model once the flag is lit.
  if (input.imageUrl) {
    void recordEntityMedia(db, {
      ownerUserId: input.submittedBy,
      publicUrl: input.imageUrl,
      entityType: "hidden_gem",
      entityId: (data as any).id as string,
      isCover: true,
      sourceType: "community",
    });
  }

  return data;
}

/** Get a single gem by ID. */
export async function getGem(db: SupabaseClient, gemId: string) {
  const { data, error } = await db
    .from("hidden_gems")
    .select(GEM_SELECT_COLS)
    .eq("id", gemId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * List gems with filters.
 *
 * Ordering is NOT popularity-first (§16.2). It was `save_count DESC`, which
 * made the raw list rank by saves — the exact popularity-first behaviour the
 * spec forbids for gems, and a path (layover-safe, trip-city) that does NOT go
 * through the evidence-based discovery ranker. It now orders by the verification
 * ladder then recency: `verification_level DESC` (the enum is defined
 * unverified→…→admin, so DESC puts admin/guide/gps first) then `updated_at
 * DESC`. Evidence and freshness, never save count.
 */
export async function listGems(db: SupabaseClient, opts: GemListOptions = {}) {
  let q = db
    .from("hidden_gems")
    .select(GEM_SELECT_COLS)
    .eq("status", opts.status ?? "active")
    .order("verification_level", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 40);

  if (opts.city) q = q.ilike("city", opts.city);
  if (opts.neighborhood) q = q.ilike("neighborhood", opts.neighborhood);
  if (opts.category) q = q.eq("category", opts.category);
  if (opts.layoverSafe) {
    q = q.eq("layover_safe", true);
    if (opts.minLayoverMinutes) {
      q = q.lte("minimum_layover_minutes", opts.minLayoverMinutes);
    }
  }
  if (opts.verificationLevel) q = q.eq("verification_level", opts.verificationLevel);
  if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 40) - 1);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Shared patch builder. */
function buildPatch(patch: Partial<{
  name: string;
  description: string;
  safetyNotes: string;
  bestTimeToGo: string;
  localEtiquette: string;
  vibeTags: string[];
  priceRange: string;
  sensitivityLevel: string;
  layoverSafe: boolean;
  minimumLayoverMinutes: number;
}>): Record<string, unknown> {
  const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined)                dbPatch.name = patch.name;
  if (patch.description !== undefined)         dbPatch.description = patch.description;
  if (patch.safetyNotes !== undefined)         dbPatch.safety_notes = patch.safetyNotes;
  if (patch.bestTimeToGo !== undefined)        dbPatch.best_time_to_go = patch.bestTimeToGo;
  if (patch.localEtiquette !== undefined)      dbPatch.local_etiquette = patch.localEtiquette;
  if (patch.vibeTags !== undefined)            dbPatch.vibe_tags = patch.vibeTags;
  if (patch.priceRange !== undefined)          dbPatch.price_range = patch.priceRange;
  if (patch.sensitivityLevel !== undefined)    dbPatch.sensitivity_level = patch.sensitivityLevel;
  if (patch.layoverSafe !== undefined)         dbPatch.layover_safe = patch.layoverSafe;
  if (patch.minimumLayoverMinutes !== undefined) dbPatch.minimum_layover_minutes = patch.minimumLayoverMinutes;
  return dbPatch;
}

export type GemPatch = Parameters<typeof buildPatch>[0];

/**
 * Update a gem as the owner.
 * All fields may be changed. Restricted to submitted_by = userId.
 */
export async function updateGem(
  db: SupabaseClient,
  gemId: string,
  userId: string,
  patch: GemPatch,
) {
  const { data, error } = await db
    .from("hidden_gems")
    .update(buildPatch(patch))
    .eq("id", gemId)
    .eq("submitted_by", userId)
    .select(GEM_SELECT_COLS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update a gem as an active Local Guide.
 * Guides may only contribute community-knowledge fields:
 * safety_notes, best_time_to_go, local_etiquette, vibe_tags.
 * Guides are NOT allowed to change name, coords, sensitivity, or owner.
 */
export async function updateGemAsGuide(
  db: SupabaseClient,
  gemId: string,
  guideId: string,
  patch: Pick<GemPatch, "safetyNotes" | "bestTimeToGo" | "localEtiquette" | "vibeTags">,
) {
  // Verify guide is active
  const { data: guideRow } = await db
    .from("local_guide_profiles")
    .select("status, city_expertise")
    .eq("user_id", guideId)
    .maybeSingle();

  if (!guideRow || (guideRow as any).status !== "active") {
    throw Object.assign(new Error("Not an active local guide"), { code: "not_a_guide" });
  }

  // Build patch — guide-safe fields only
  const safePatch: GemPatch = {};
  if (patch.safetyNotes    !== undefined) safePatch.safetyNotes    = patch.safetyNotes;
  if (patch.bestTimeToGo   !== undefined) safePatch.bestTimeToGo   = patch.bestTimeToGo;
  if (patch.localEtiquette !== undefined) safePatch.localEtiquette = patch.localEtiquette;
  if (patch.vibeTags       !== undefined) safePatch.vibeTags       = patch.vibeTags;

  const { data, error } = await db
    .from("hidden_gems")
    .update(buildPatch(safePatch))
    .eq("id", gemId)
    .eq("status", "active")   // guides can only touch active gems
    .select(GEM_SELECT_COLS)
    .single();

  if (error) throw error;
  return data;
}

/** Save a gem for the caller (idempotent). Returns whether it was new. */
export async function saveGem(
  db: SupabaseClient,
  gemId: string,
  userId: string,
): Promise<{ alreadySaved: boolean }> {
  const { data: existing } = await db
    .from("hidden_gem_saves")
    .select("gem_id")
    .eq("gem_id", gemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) return { alreadySaved: true };

  const { error } = await db
    .from("hidden_gem_saves")
    .insert({ gem_id: gemId, user_id: userId });
  if (error) throw error;

  // Increment save_count — supabase-js returns { error }, it never throws
  const { error: rpcError } = await db.rpc("increment_counter" as any, {
    table_name: "hidden_gems", column_name: "save_count", row_id: gemId,
  });
  if (rpcError) {
    // Fallback: manual increment
    const { data: cur, error: readError } = await db.from("hidden_gems").select("save_count").eq("id", gemId).maybeSingle();
    if (readError) {
      logger.warn({ err: readError, gemId }, "saveGem: save_count fallback read failed");
    } else {
      const next = ((cur as any)?.save_count ?? 0) + 1;
      const { error: updError } = await db.from("hidden_gems").update({ save_count: next }).eq("id", gemId);
      if (updError) logger.warn({ err: updError, gemId }, "saveGem: save_count fallback update failed");
    }
  }

  // Feed into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(db, {
    userId,
    eventType: "gem_saved",
    category: "community_value",
    delta: 1,
    severity: "minor",
    sourceType: "hidden_gem",
    sourceId: gemId,
    dedupWindowHours: 48,
  });

  return { alreadySaved: false };
}

/** Unsave a gem. */
export async function unsaveGem(
  db: SupabaseClient,
  gemId: string,
  userId: string,
): Promise<{ removed: boolean }> {
  const { error, data } = await db
    .from("hidden_gem_saves")
    .delete()
    .eq("gem_id", gemId)
    .eq("user_id", userId)
    .select("gem_id");

  if (error) throw error;
  return { removed: (data ?? []).length > 0 };
}

/** Check if a user has saved a specific gem. */
export async function hasSavedGem(
  db: SupabaseClient,
  gemId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await db
    .from("hidden_gem_saves")
    .select("gem_id")
    .eq("gem_id", gemId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

/** List gems saved by a user. */
export async function listSavedGems(
  db: SupabaseClient,
  userId: string,
  limit = 40,
): Promise<any[]> {
  const { data, error } = await db
    .from("hidden_gem_saves")
    .select(`gem_id, saved_at, hidden_gems(${GEM_SELECT_COLS})`)
    .eq("user_id", userId)
    .order("saved_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    savedAt: r.saved_at,
    ...(r.hidden_gems ?? {}),
  }));
}
