/**
 * VisualGenerationService — the one centralized, server-side visual generation
 * orchestrator. Event/place/card components must NOT generate independently.
 *
 * Flow (idempotent, async):
 *   requestGeneration() → validate flags + limits → load canonical entity →
 *   sanitize → build prompt + hash → reuse existing ready image OR create a queued
 *   job → return immediately. processJob() runs the provider, builds derivatives,
 *   uploads, and applies to the entity only if priority rules still allow it.
 *
 * The DB client is typed loosely (`any`) to match how the rest of the repo passes
 * the supabase service client around; all queries target the 0189 schema.
 */
import { getServiceClient } from "../supabase.js";
import { isFlagEnabled } from "../featureFlags.js";
import {
  buildPrompt,
  promptVersionFor,
} from "./promptBuilder.js";
import { NEGATIVE_PROMPT } from "./promptBuilder.js";
import { promptHash } from "./promptHash.js";
import { coerceStyle, styleIsIllustrated } from "./styles.js";
import { buildDerivatives, dataUrlToBuffer } from "./derivatives.js";

/**
 * Convert a provider image URL to a raw image Buffer.
 * Handles two shapes the provider may return:
 *   • data: URL (base64-encoded) — decoded directly, no network call.
 *   • https:// URL — fetched over the network, then returned as Buffer.
 * Throws on network errors or non-OK HTTP status.
 */
export async function imageDataToBuffer(imageDataUrl: string): Promise<Buffer> {
  if (imageDataUrl.startsWith("data:")) {
    return dataUrlToBuffer(imageDataUrl);
  }
  // Remote URL — fetch and buffer
  const res = await fetch(imageDataUrl);
  if (!res.ok) {
    throw new Error(`Failed to download provider image: ${res.status} ${imageDataUrl.slice(0, 80)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
import { mayApplyGenerated } from "./priority.js";
import { fallbackUrl } from "./providers/categoryFallbackProvider.js";
import { OpenAIImageProvider } from "./providers/openaiImageProvider.js";
import { CategoryFallbackProvider } from "./providers/categoryFallbackProvider.js";
import {
  cleanText,
  cleanEnum,
  cleanList,
} from "./sanitize.js";
import type {
  ImageGenerationInput,
  ImageGenerationProvider,
  ImageSource,
  VisualEntityType,
  VisualInputSnapshot,
  VisualPreferences,
  VisualPurpose,
} from "./types.js";

const STORAGE_BUCKET = process.env.AI_VISUAL_BUCKET?.trim() || "post-media";
const MAX_RETRIES = Number(process.env.AI_VISUAL_MAX_RETRIES ?? "2") || 2;
const USER_DAILY_LIMIT = Number(process.env.AI_VISUAL_USER_DAILY_LIMIT ?? "10") || 10;
const GLOBAL_DAILY_LIMIT = Number(process.env.AI_VISUAL_DAILY_LIMIT ?? "500") || 500;

export interface GenerationRequest {
  entityType: VisualEntityType;
  entityId: string;
  purpose: VisualPurpose;
  ownerUserId: string;
  style?: string;
  preferences?: VisualPreferences;
  /** When true, skip the reuse-cache and force a fresh job (regenerate). */
  force?: boolean;
}

export interface GenerationOutcome {
  ok: boolean;
  status: "queued" | "ready" | "blocked" | "rate_limited" | "disabled" | "error";
  visualId?: string;
  error?: string;
}

/** Which master flag gates a purpose. */
function purposeFlag(purpose: VisualPurpose): string {
  if (purpose === "event_header") return "ai_event_headers_enabled";
  if (purpose === "place_header") return "ai_place_headers_enabled";
  if (purpose === "trip_cover") return "ai_trip_covers_enabled";
  return "ai_visual_provider_enabled";
}

function pickProvider(providerEnabled: boolean): ImageGenerationProvider {
  return providerEnabled ? new OpenAIImageProvider() : new CategoryFallbackProvider();
}

/** Build the sanitized snapshot from a canonical entity row. */
export function buildSnapshot(
  entityType: VisualEntityType,
  purpose: VisualPurpose,
  row: Record<string, any>,
  style: string,
  prefs?: VisualPreferences,
): VisualInputSnapshot {
  const s = coerceStyle(style);
  return {
    entityType,
    purpose,
    title: cleanText(row.title ?? row.name),
    category: cleanEnum(row.category ?? row.primary_category),
    subcategory: cleanEnum(row.subcategory),
    city: cleanText(row.city),
    neighborhood: cleanText(row.neighborhood),
    country: cleanText(row.country),
    description: cleanText(row.description, 400),
    venue: cleanText(row.venue ?? row.venue_name),
    setting: cleanEnum(row.setting),
    timeOfDay: prefs?.timeOfDay && prefs.timeOfDay !== "auto" ? prefs.timeOfDay : cleanEnum(row.time_of_day),
    amenities: cleanList(row.amenities),
    priceLevel: cleanEnum(row.price_level),
    traits: cleanList(row.traits),
    style: s,
    renderMode: prefs?.renderMode ?? (styleIsIllustrated(s) ? "illustrated" : "realistic"),
    people: prefs?.people ?? "auto",
    promptVersion: promptVersionFor(purpose),
  };
}

async function countToday(sc: any, column: "owner_user_id" | null, value?: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let q = sc
    .from("generated_visuals")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since.toISOString());
  if (column && value) q = q.eq(column, value);
  const { count } = await q;
  return count ?? 0;
}

/**
 * Synchronous entry point: validate, dedupe, create the job. Returns immediately.
 * The caller (route) fires processJob() without awaiting.
 */
export async function requestGeneration(req: GenerationRequest): Promise<GenerationOutcome> {
  const sc: any = getServiceClient();
  if (!sc) return { ok: false, status: "error", error: "server_not_configured" };

  const providerEnabled = await isFlagEnabled(sc, "ai_visual_provider_enabled");
  const purposeEnabled = await isFlagEnabled(sc, purposeFlag(req.purpose));
  // Provider off is not an error — we still produce a category fallback record so
  // the entity has an intentional header, but we never call the paid API.

  // Usage limits (only meaningful when the paid provider would actually run).
  if (providerEnabled && purposeEnabled) {
    const [userCount, globalCount] = await Promise.all([
      countToday(sc, "owner_user_id", req.ownerUserId),
      countToday(sc, null),
    ]);
    if (userCount >= USER_DAILY_LIMIT || globalCount >= GLOBAL_DAILY_LIMIT) {
      return { ok: false, status: "rate_limited", error: "daily generation limit reached" };
    }
  }

  // Load canonical entity from DB — never trust client-provided entity fields.
  const row = await loadEntity(sc, req.entityType, req.entityId);
  if (!row) return { ok: false, status: "error", error: "entity_not_found" };

  const snapshot = buildSnapshot(req.entityType, req.purpose, row, req.style ?? "portava_editorial", req.preferences);
  const finalPrompt = buildPrompt(snapshot);
  const hash = promptHash(snapshot);

  // Reuse: an existing active image with the same hash → no new provider charge.
  if (!req.force) {
    const { data: existing } = await sc
      .from("generated_visuals")
      .select("id, status")
      .eq("entity_type", req.entityType)
      .eq("entity_id", req.entityId)
      .eq("purpose", req.purpose)
      .eq("prompt_hash", hash)
      .in("status", ["queued", "generating", "ready"])
      .limit(1)
      .maybeSingle();
    if (existing) return { ok: true, status: existing.status === "ready" ? "ready" : "queued", visualId: existing.id };
  } else {
    // Force regenerate: retire all active rows for this entity+purpose so the
    // partial-unique index doesn't conflict when we insert the new job. This
    // correctly handles re-generating the same snapshot (same hash) because the
    // old row is moved out of the active set before the insert.
    await sc
      .from("generated_visuals")
      .update({ status: "replaced", updated_at: new Date().toISOString() })
      .eq("entity_type", req.entityType)
      .eq("entity_id", req.entityId)
      .eq("purpose", req.purpose)
      .in("status", ["queued", "generating", "ready"]);
  }

  const useProvider = providerEnabled && purposeEnabled;
  const { data: job, error } = await sc
    .from("generated_visuals")
    .insert({
      owner_user_id: req.ownerUserId,
      entity_type: req.entityType,
      entity_id: req.entityId,
      purpose: req.purpose,
      provider: useProvider ? "openai" : "category_fallback",
      prompt_version: snapshot.promptVersion,
      prompt_hash: hash,
      input_snapshot: snapshot as any,
      final_prompt: finalPrompt,
      negative_prompt: NEGATIVE_PROMPT,
      style: snapshot.style,
      aspect_ratio: "16:9",
      status: "queued",
    })
    .select("id")
    .single();

  if (error || !job) return { ok: false, status: "error", error: error?.message ?? "insert_failed" };
  return { ok: true, status: "queued", visualId: job.id };
}

/** Load canonical entity row for prompt building. */
export async function loadEntity(
  sc: any,
  entityType: VisualEntityType,
  entityId: string,
): Promise<Record<string, any> | null> {
  if (entityType === "event") {
    const { data } = await sc
      .from("events")
      .select("id, title, category, city, country, venue_name, description, cover_url, header_image_source, header_image_updated_at")
      .eq("id", entityId)
      .maybeSingle();
    return data ?? null;
  }
  if (entityType === "place") {
    const { data } = await sc
      .from("discovery_places")
      .select("id, name, category, city, country, description, header_image_url, header_image_source, header_image_updated_at")
      .eq("id", entityId)
      .maybeSingle();
    return data ?? null;
  }
  if (entityType === "trip") {
    const { data } = await sc
      .from("trips")
      .select("id, title, destination_city, cover_url")
      .eq("id", entityId)
      .maybeSingle();
    return data ?? null;
  }
  return null;
}

/**
 * Async worker step: run one queued job to completion. Safe to call fire-and-forget.
 * Bounded retries with backoff are the caller/queue's job; this runs one attempt.
 */
export async function processJob(visualId: string): Promise<void> {
  const sc: any = getServiceClient();
  if (!sc) return;

  const startedAt = new Date().toISOString();
  const { data: job } = await sc.from("generated_visuals").select("*").eq("id", visualId).maybeSingle();
  if (!job || job.status === "replaced" || job.status === "ready") return;

  await sc.from("generated_visuals").update({ status: "generating", updated_at: startedAt }).eq("id", visualId);

  const providerEnabled = await isFlagEnabled(sc, "ai_visual_provider_enabled");
  const provider = pickProvider(providerEnabled && job.provider === "openai");

  const input: ImageGenerationInput = {
    purpose: job.purpose,
    snapshot: job.input_snapshot,
    finalPrompt: job.final_prompt,
    negativePrompt: job.negative_prompt,
    style: job.style,
    aspectRatio: job.aspect_ratio,
  };

  const result = await provider.generateImage(input);
  if (!result.ok || !result.imageDataUrl) {
    const blocked = result.failureCode === "provider_rejected";
    await sc.from("generated_visuals").update({
      status: blocked ? "blocked" : "failed",
      failure_code: result.failureCode ?? "provider_error",
      failure_message: result.failureMessage ?? "generation failed",
      moderation_status: blocked ? "blocked" : null,
      attempt_count: (job.attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", visualId);
    return;
  }

  // Category-fallback provider returns a static URL — store it directly, no derivatives.
  if (provider.name === "category_fallback") {
    await finalizeVisual(sc, job, {
      urls: { hero: result.imageDataUrl },
      provider: provider.name,
      model: result.model,
      source: "category_fallback",
      startedAt,
    });
    return;
  }

  // Real image → build derivatives, upload, finalize.
  try {
    const source = await imageDataToBuffer(result.imageDataUrl);
    const derivatives = await buildDerivatives(source);
    const urls: Record<string, string> = {};
    const paths: Record<string, string> = {};
    for (const d of derivatives) {
      const path = `generated-visuals/${job.entity_type}/${job.entity_id}/${visualId}/${d.key}.webp`;
      const { error: upErr } = await sc.storage
        .from(STORAGE_BUCKET)
        .upload(path, d.buffer, { contentType: d.contentType, upsert: true });
      if (upErr) throw upErr;
      const { data: pub } = sc.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      urls[d.key] = pub?.publicUrl ?? path;
      paths[d.key] = path;
    }
    await finalizeVisual(sc, job, {
      urls,
      paths,
      provider: provider.name,
      model: result.model,
      cost: result.costEstimate,
      source: "ai_generated",
      startedAt,
    });
  } catch (err: any) {
    await sc.from("generated_visuals").update({
      status: "failed",
      failure_code: "invalid_output",
      failure_message: String(err?.message ?? err).slice(0, 300),
      attempt_count: (job.attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", visualId);
  }
}

interface FinalizeArgs {
  urls: Record<string, string>;
  paths?: Record<string, string>;
  provider: string;
  model?: string;
  cost?: number;
  source: ImageSource;
  startedAt: string;
}

/** Mark the visual ready and apply it to the entity if priority rules still allow. */
async function finalizeVisual(sc: any, job: any, args: FinalizeArgs): Promise<void> {
  const now = new Date().toISOString();
  const heroUrl = args.urls.hero ?? args.urls.master ?? args.urls.card ?? Object.values(args.urls)[0];
  await sc.from("generated_visuals").update({
    status: "ready",
    provider: args.provider,
    model: args.model ?? null,
    hero_path: args.paths?.hero ?? null,
    card_path: args.paths?.card ?? null,
    thumbnail_path: args.paths?.thumbnail ?? null,
    share_path: args.paths?.share ?? null,
    storage_path: args.paths?.master ?? null,
    source_image_url: heroUrl ?? null,
    generation_cost_estimate: args.cost ?? null,
    generated_at: now,
    updated_at: now,
  }).eq("id", job.id);

  // Apply to the entity only if nothing higher-priority arrived meanwhile.
  const current = await loadEntity(sc, job.entity_type, job.entity_id);
  const canApply = mayApplyGenerated(
    { source: current?.header_image_source ?? null, updatedAt: current?.header_image_updated_at ?? null },
    args.startedAt,
  );
  if (!canApply || !heroUrl) return;

  if (job.entity_type === "event") {
    // Events already have cover_url — set it + record provenance metadata.
    await sc.from("events").update({
      cover_url: heroUrl,
      header_image_source: args.source,
      header_image_status: "ready",
      header_image_generated_id: job.id,
      header_image_attribution: args.source === "ai_generated" ? "AI-generated event artwork" : null,
      header_image_updated_at: now,
    }).eq("id", job.entity_id);
  } else if (job.entity_type === "place") {
    await sc.from("discovery_places").update({
      header_image_url: heroUrl,
      header_image_source: args.source,
      header_image_status: "ready",
      header_image_generated_id: job.id,
      header_image_attribution: args.source === "ai_generated" ? "AI-generated representation" : null,
      header_image_updated_at: now,
    }).eq("id", job.entity_id);
  } else if (job.entity_type === "trip") {
    // Trips use cover_url for their header image.
    await sc.from("trips").update({
      cover_url: heroUrl,
    }).eq("id", job.entity_id);
  }
}

/** Convenience for callers that want the static fallback URL without a job. */
export function categoryFallbackUrl(category: string | null | undefined, entityType: string): string {
  return fallbackUrl(category, entityType);
}

export const _config = { STORAGE_BUCKET, MAX_RETRIES, USER_DAILY_LIMIT, GLOBAL_DAILY_LIMIT };
