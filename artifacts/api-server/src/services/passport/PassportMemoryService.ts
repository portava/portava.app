/**
 * PassportMemoryService
 *
 * Creates and manages passport memories.
 * Memories begin as 'suggested' (private, not public) and become 'active'
 * only when the user explicitly accepts them.
 *
 * NOTE: passport_memories genuinely has an `earned_at` column in the live
 * schema (verified 2026-07-20) — unlike passport_stamps, whose live column is
 * `awarded_at`. Do not "fix" earned_at here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VisibilityTier } from "./PassportPrivacyGuard.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { recordEntityMedia } from "../../lib/mediaAssets.js";

const logger = rootLogger.child({ service: "PassportMemoryService" });

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
  mediaType?: string | null;
}

export interface UpdateMemoryInput {
  title?: string;
  description?: string | null;
  city?: string | null;
  country?: string | null;
  visibility?: VisibilityTier;
  photoUrl?: string | null;
  mediaType?: string | null;
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

  if (error) {
    logger.error({ table: "passport_memories", op: "insert", message: error.message }, "createSuggestedMemory failed");
    return null;
  }
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
      media_type: input.mediaType ?? null,
      plan_id: input.planId ?? null,
      trip_id: input.tripId ?? null,
      place_id: input.placeId ?? null,
      suggestion_reason: null,
      earned_at: input.earnedAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    logger.error({ table: "passport_memories", op: "insert", message: error.message }, "createMemory failed");
    return null;
  }
  const memoryId = (data as any).id as string;

  // Canonical dual-write (flag-gated OFF; fail-soft — legacy photo_url path
  // unaffected). Records the media_assets + media_attachments(entityType=memory)
  // rows so the memory's photo participates in the §6.1 "one asset, many
  // entities" model once media_canonical_enabled is lit.
  if (input.photoUrl) {
    void recordEntityMedia(db, {
      ownerUserId: input.userId,
      publicUrl: input.photoUrl,
      entityType: "memory",
      entityId: memoryId,
      isCover: true,
    });
  }

  return memoryId;
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

  if (error) {
    logger.error({ table: "passport_memories", op: "update", message: error.message }, "acceptSuggestedMemory failed");
    return false;
  }
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

  if (error) {
    logger.error({ table: "passport_memories", op: "update", message: error.message }, "dismissSuggestedMemory failed");
    return false;
  }
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
  if (patch.city !== undefined) update.city = patch.city;
  if (patch.country !== undefined) update.country = patch.country;
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.photoUrl !== undefined) update.photo_url = patch.photoUrl;
  if (patch.mediaType !== undefined) update.media_type = patch.mediaType;

  if (Object.keys(update).length === 1) return false;

  const { data, error } = await db
    .from("passport_memories")
    .update(update)
    .eq("id", memoryId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");

  if (error) {
    logger.error({ table: "passport_memories", op: "update", message: error.message }, "updateMemory failed");
    return false;
  }
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
    .select("id, status, title, description, country, city, neighborhood, category, visibility, verification_level, source_type, source_id, photo_url, media_type, plan_id, trip_id, place_id, suggestion_reason, earned_at, created_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("earned_at", { ascending: false })
    .limit(100);

  if (error) {
    logger.error({ table: "passport_memories", op: "select", message: error.message }, "loadMemories failed");
    return [];
  }
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
    .select("id, status, title, description, country, city, neighborhood, category, visibility, verification_level, source_type, source_id, photo_url, media_type, plan_id, trip_id, place_id, suggestion_reason, earned_at, created_at")
    .eq("user_id", userId)
    .eq("status", "suggested")
    .order("earned_at", { ascending: false })
    .limit(50);

  if (error) {
    logger.error({ table: "passport_memories", op: "select", message: error.message }, "loadSuggestions failed");
    return [];
  }
  return data ?? [];
}
