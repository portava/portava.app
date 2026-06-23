/**
 * PassportMemoryService
 *
 * Creates and manages passport memories.
 * Memories begin as 'suggested' (private, not public) and become 'active'
 * only when the user explicitly accepts them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VisibilityTier } from "./PassportPrivacyGuard.js";

export interface CreateSuggestedMemoryInput {
  userId: string;
  title: string;
  description?: string | null;
  country?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  category?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  planId?: string | null;
  tripId?: string | null;
  placeId?: string | null;
  verificationLevel?: string;
  suggestionReason?: string | null;
  earnedAt?: string;
}

export interface CreateMemoryInput extends CreateSuggestedMemoryInput {
  visibility?: VisibilityTier;
  photoUrl?: string | null;
}

export interface UpdateMemoryInput {
  title?: string;
  description?: string | null;
  visibility?: VisibilityTier;
  photoUrl?: string | null;
}

/**
 * Create a suggested memory (status = 'suggested', not visible publicly).
 * Returns the memory id or null on failure.
 */
export async function createSuggestedMemory(
  db: SupabaseClient,
  input: CreateSuggestedMemoryInput,
): Promise<string | null> {
  const { data, error } = await db
    .from("passport_memories")
    .insert({
      user_id: input.userId,
      status: "suggested",
      title: input.title,
      description: input.description ?? null,
      country: input.country ?? null,
      city: input.city ?? null,
      neighborhood: input.neighborhood ?? null,
      category: input.category ?? null,
      visibility: "private", // suggested memories are always private initially
      verification_level: input.verificationLevel ?? "unverified",
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
      plan_id: input.planId ?? null,
      trip_id: input.tripId ?? null,
      place_id: input.placeId ?? null,
      suggestion_reason: input.suggestionReason ?? null,
      earned_at: input.earnedAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) return null;
  return (data as any).id;
}

/**
 * Create a memory directly (status = 'active', with user-chosen visibility).
 */
export async function createMemory(
  db: SupabaseClient,
  input: CreateMemoryInput,
): Promise<string | null> {
  const { data, error } = await db
    .from("passport_memories")
    .insert({
      user_id: input.userId,
      status: "active",
      title: input.title,
      description: input.description ?? null,
      country: input.country ?? null,
      city: input.city ?? null,
      neighborhood: input.neighborhood ?? null,
      category: input.category ?? null,
      visibility: input.visibility ?? "private",
      verification_level: input.verificationLevel ?? "unverified",
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
      photo_url: input.photoUrl ?? null,
      plan_id: input.planId ?? null,
      trip_id: input.tripId ?? null,
      place_id: input.placeId ?? null,
      suggestion_reason: null,
      earned_at: input.earnedAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) return null;
  return (data as any).id;
}

/**
 * Accept a suggested memory — promotes status to 'active' with chosen visibility.
 */
export async function acceptSuggestedMemory(
  db: SupabaseClient,
  memoryId: string,
  userId: string,
  patch: UpdateMemoryInput,
): Promise<boolean> {
  const update: Record<string, unknown> = {
    status: "active",
    updated_at: new Date().toISOString(),
  };
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.photoUrl !== undefined) update.photo_url = patch.photoUrl;

  const { data, error } = await db
    .from("passport_memories")
    .update(update)
    .eq("id", memoryId)
    .eq("user_id", userId)
    .eq("status", "suggested")
    .select("id");

  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Dismiss a suggested memory.
 */
export async function dismissSuggestedMemory(
  db: SupabaseClient,
  memoryId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("passport_memories")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", memoryId)
    .eq("user_id", userId)
    .eq("status", "suggested")
    .select("id");

  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Update an active memory.
 */
export async function updateMemory(
  db: SupabaseClient,
  memoryId: string,
  userId: string,
  patch: UpdateMemoryInput,
): Promise<boolean> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.photoUrl !== undefined) update.photo_url = patch.photoUrl;

  if (Object.keys(update).length === 1) return false;

  const { data, error } = await db
    .from("passport_memories")
    .update(update)
    .eq("id", memoryId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");

  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Load active memories for a user.
 */
export async function loadMemories(
  db: SupabaseClient,
  userId: string,
): Promise<any[]> {
  const { data, error } = await db
    .from("passport_memories")
    .select("id, status, title, description, country, city, neighborhood, category, visibility, verification_level, source_type, source_id, photo_url, plan_id, trip_id, place_id, suggestion_reason, earned_at, created_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("earned_at", { ascending: false })
    .limit(100);

  if (error) return [];
  return data ?? [];
}

/**
 * Load pending (suggested) memories for a user.
 */
export async function loadSuggestions(
  db: SupabaseClient,
  userId: string,
): Promise<any[]> {
  const { data, error } = await db
    .from("passport_memories")
    .select("id, status, title, description, country, city, neighborhood, category, visibility, verification_level, source_type, source_id, photo_url, plan_id, trip_id, place_id, suggestion_reason, earned_at, created_at")
    .eq("user_id", userId)
    .eq("status", "suggested")
    .order("earned_at", { ascending: false })
    .limit(50);

  if (error) return [];
  return data ?? [];
}
