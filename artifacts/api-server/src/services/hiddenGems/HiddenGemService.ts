/**
 * HiddenGemService — CRUD, save/unsave, ranking helpers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const GEM_SELECT_COLS = `
  id, name, category, city, country, neighborhood,
  description, latitude, longitude, approx_latitude, approx_longitude,
  vibe_tags, price_range, safety_notes, best_time_to_go, local_etiquette,
  layover_safe, minimum_layover_minutes,
  sensitivity_level, verification_level, status,
  submitted_by, guide_verified_by,
  save_count, visit_count, report_count,
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
    })
    .select(GEM_SELECT_COLS)
    .single();

  if (error) throw error;
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

/** List gems with filters. */
export async function listGems(db: SupabaseClient, opts: GemListOptions = {}) {
  let q = db
    .from("hidden_gems")
    .select(GEM_SELECT_COLS)
    .eq("status", opts.status ?? "active")
    .order("save_count", { ascending: false })
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

/** Update a gem (owner or guide edit). */
export async function updateGem(
  db: SupabaseClient,
  gemId: string,
  userId: string,
  patch: Partial<{
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
  }>,
) {
  const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) dbPatch.name = patch.name;
  if (patch.description !== undefined) dbPatch.description = patch.description;
  if (patch.safetyNotes !== undefined) dbPatch.safety_notes = patch.safetyNotes;
  if (patch.bestTimeToGo !== undefined) dbPatch.best_time_to_go = patch.bestTimeToGo;
  if (patch.localEtiquette !== undefined) dbPatch.local_etiquette = patch.localEtiquette;
  if (patch.vibeTags !== undefined) dbPatch.vibe_tags = patch.vibeTags;
  if (patch.priceRange !== undefined) dbPatch.price_range = patch.priceRange;
  if (patch.sensitivityLevel !== undefined) dbPatch.sensitivity_level = patch.sensitivityLevel;
  if (patch.layoverSafe !== undefined) dbPatch.layover_safe = patch.layoverSafe;
  if (patch.minimumLayoverMinutes !== undefined) dbPatch.minimum_layover_minutes = patch.minimumLayoverMinutes;

  const { data, error } = await db
    .from("hidden_gems")
    .update(dbPatch)
    .eq("id", gemId)
    .eq("submitted_by", userId)
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

  // Increment save_count (RPC may not exist yet — silent fallback)
  try {
    await db.rpc("increment_hidden_gem_save_count" as any, { gem_id: gemId });
  } catch { /* ignore */ }

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
