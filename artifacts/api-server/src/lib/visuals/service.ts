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
  reconstitutePlacePromptResult,
} from "./promptBuilder.js";
import { NEGATIVE_PROMPT } from "./promptBuilder.js";
import { verifyPlaceImage } from "./realPlaceVerification.js";
import { promptHash } from "./promptHash.js";
import { coerceStyle, styleIsIllustrated } from "./styles.js";
import { buildDerivatives, dataUrlToBuffer } from "./derivatives.js";
import { emitVisualEvent } from "./analytics.js";

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
  /**
   * Verified reference image URLs for specific real-place generation.
   * When the entity is a specific named real place, these are required —
   * without them, generation is skipped and a fallback image is served instead.
   */
  referenceImageUrls?: string[];
}

export interface GenerationOutcome {
  ok: boolean;
  status: "queued" | "ready" | "blocked" | "rate_limited" | "disabled" | "error" | "no_reference_fallback";
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
  referenceImageUrls?: string[],
): VisualInputSnapshot {
  const s = coerceStyle(style);

  // Determine whether this is a specific named real-world place (not a generic content card).
  // A place is "specific" when it has a canonical_place_id, a provider_place_id, or both
  // a name and city that together uniquely identify a real-world location.
  // discovery_places rows carry canonical_location_id (no canonical_place_id /
  // provider_place_id columns); accept either spelling so both sources work.
  const canonicalPlaceId: string | null = row.canonical_place_id ?? row.canonical_location_id ?? null;
  const providerPlaceId: string | null = row.provider_place_id ?? null;
  const name = cleanText(row.title ?? row.name);
  const city = cleanText(row.city);
  const isSpecificRealPlace: boolean =
    entityType === "place" &&
    !!(canonicalPlaceId || providerPlaceId || (name && city));

  return {
    entityType,
    purpose,
    title: name,
    category: cleanEnum(row.category ?? row.primary_category),
    subcategory: cleanEnum(row.subcategory),
    city,
    neighborhood: cleanText(row.neighborhood),
    country: cleanText(row.country), // discovery_places has no country column → null for places
    description: cleanText(row.description ?? row.blurb, 400), // places use blurb
    venue: cleanText(row.venue ?? row.venue_name ?? row.location_name), // events use location_name
    setting: cleanEnum(row.setting),
    timeOfDay: prefs?.timeOfDay && prefs.timeOfDay !== "auto" ? prefs.timeOfDay : cleanEnum(row.time_of_day),
    amenities: cleanList(row.amenities),
    priceLevel: cleanEnum(row.price_level),
    traits: cleanList(row.traits),
    style: s,
    renderMode: prefs?.renderMode ?? (styleIsIllustrated(s) ? "illustrated" : "realistic"),
    people: prefs?.people ?? "auto",
    promptVersion: promptVersionFor(purpose),
    isSpecificRealPlace,
    referenceImageUrls: referenceImageUrls && referenceImageUrls.length > 0 ? referenceImageUrls : null,
    canonicalPlaceId,
    providerPlaceId,
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
 * Synchronous entry point: validate, dedupe, create the queued job row. Returns
 * immediately — the VisualGenerationWorker picks it up asynchronously.
 */
export async function requestGeneration(req: GenerationRequest): Promise<GenerationOutcome> {
  const sc: any = getServiceClient();
  if (!sc) return { ok: false, status: "error", error: "server_not_configured" };

  emitVisualEvent("visual_generation_requested", {
    entity_type: req.entityType,
    entity_id:   req.entityId,
    purpose:     req.purpose,
    style:       req.style ?? null,
    status:      "requested",
  });

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

  // Entity-level block guard: if an admin has set moderation_status='entity_blocked'
  // on any visual for this entity, refuse all future generation attempts outright.
  // This persists across force-regenerate and daily-limit resets.
  const { data: blocked } = await sc
    .from("generated_visuals")
    .select("id")
    .eq("entity_type", req.entityType)
    .eq("entity_id", req.entityId)
    .eq("moderation_status", "entity_blocked")
    .limit(1)
    .maybeSingle();
  if (blocked) return { ok: false, status: "blocked", error: "entity_blocked" };

  // Load canonical entity from DB — never trust client-provided entity fields.
  const row = await loadEntity(sc, req.entityType, req.entityId);
  if (!row) return { ok: false, status: "error", error: "entity_not_found" };

  const snapshot = buildSnapshot(req.entityType, req.purpose, row, req.style ?? "portava_editorial", req.preferences, req.referenceImageUrls);

  // No-reference fallback: specific real places cannot be generated text-only.
  // Skip the provider entirely and tell the caller to serve a category/map fallback.
  if (snapshot.isSpecificRealPlace && !snapshot.referenceImageUrls?.length) {
    emitVisualEvent("visual_generation_no_reference", {
      entity_type: req.entityType,
      entity_id:   req.entityId,
      purpose:     req.purpose,
      style:       snapshot.style,
      status:      "no_reference_fallback",
    });
    return { ok: false, status: "no_reference_fallback", error: "specific_place_requires_reference_images" };
  }

  const finalPrompt = buildPrompt(snapshot);
  // buildPrompt returns null when generation is blocked (should not reach here after
  // the isSpecificRealPlace guard above, but defend anyway).
  if (finalPrompt === null) {
    return { ok: false, status: "no_reference_fallback", error: "prompt_generation_blocked" };
  }
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
    if (existing) {
      emitVisualEvent("visual_generation_reused", {
        entity_type: req.entityType,
        entity_id:   req.entityId,
        purpose:     req.purpose,
        style:       snapshot.style,
        status:      existing.status,
        visual_id:   existing.id,
      });
      return { ok: true, status: existing.status === "ready" ? "ready" : "queued", visualId: existing.id };
    }
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

    emitVisualEvent("visual_generation_regenerated", {
      entity_type: req.entityType,
      entity_id:   req.entityId,
      purpose:     req.purpose,
      style:       snapshot.style,
      status:      "replaced",
    });
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

  emitVisualEvent("visual_generation_queued", {
    entity_type: req.entityType,
    entity_id:   req.entityId,
    purpose:     req.purpose,
    style:       snapshot.style,
    status:      "queued",
    visual_id:   job.id,
    provider:    useProvider ? "openai" : "category_fallback",
  });

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
      .select("id, title, category, city, country, location_name, description, cover_url, header_image_source, header_image_updated_at")
      .eq("id", entityId)
      .maybeSingle();
    return data ?? null;
  }
  if (entityType === "place") {
    const { data } = await sc
      .from("discovery_places")
      // discovery_places has no country/description/canonical_place_id/provider_place_id
      // columns — it exposes blurb and canonical_location_id instead.
      .select("id, name, category, city, blurb, header_image_url, header_image_source, header_image_updated_at, canonical_location_id")
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
    finalPrompt: reconstitutePlacePromptResult(job.final_prompt),
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
  // For specific real places this path is only reached when a fallback was explicitly
  // requested; we always attach a disclaimer in that case.
  if (provider.name === "category_fallback") {
    const snapshot: VisualInputSnapshot = job.input_snapshot ?? {};
    const isSRP = snapshot.isSpecificRealPlace ?? false;
    await finalizeVisual(sc, job, {
      urls: { hero: result.imageDataUrl },
      provider: provider.name,
      model: result.model,
      source: "category_fallback",
      startedAt,
      accuracyStatus: "illustrative_only",
      disclaimerRequired: isSRP,
      disclaimerText: isSRP ? "Representative image — not a photo of the actual location." : null,
    });
    return;
  }

  // Real image → build derivatives, upload, finalize.
  try {
    const rawBuffer = await imageDataToBuffer(result.imageDataUrl);
    const derivatives = await buildDerivatives(rawBuffer);
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

    // Determine source type based on snapshot: reference-grounded vs generic AI.
    const snapshot: VisualInputSnapshot = job.input_snapshot ?? {};
    const hasRefs = (snapshot.referenceImageUrls ?? []).length > 0;
    const aiSource = hasRefs ? "reference_grounded_ai" : "generic_ai_illustration";

    // Run verification before accepting the output.
    const heroUrlForVerification =
      urls.hero ?? urls.master ?? urls.card ?? Object.values(urls)[0] ?? result.imageDataUrl;
    const verification = verifyPlaceImage({
      imageUrl: heroUrlForVerification,
      imageSource: aiSource,
      generatedWithAi: true,
      referenceImageUrls: snapshot.referenceImageUrls ?? null,
      canonicalPlaceId: snapshot.canonicalPlaceId ?? null,
      providerPlaceId: snapshot.providerPlaceId ?? null,
      officialName: snapshot.title ?? null,
      city: snapshot.city ?? null,
      currentAccuracyStatus: null,
      isSpecificRealPlace: snapshot.isSpecificRealPlace ?? false,
    });

    if (!verification.permitted || verification.accuracyStatus === "rejected") {
      // Verification rejected this output — store as failed, never serve.
      await sc.from("generated_visuals").update({
        status: "failed",
        failure_code: "verification_rejected",
        failure_message: verification.rejectionReason?.slice(0, 300) ?? "verification rejected",
        accuracy_status: "rejected",
        disclaimer_required: verification.disclaimerRequired,
        disclaimer_text: verification.disclaimerText,
        attempt_count: (job.attempt_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", visualId);
      return;
    }

    await finalizeVisual(sc, job, {
      urls,
      paths,
      provider: provider.name,
      model: result.model,
      cost: result.costEstimate,
      source: aiSource,
      startedAt,
      accuracyStatus: verification.accuracyStatus,
      disclaimerRequired: verification.disclaimerRequired,
      disclaimerText: verification.disclaimerText,
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
  /** Accuracy classification to write on the generated_visuals row. */
  accuracyStatus?: string | null;
  /** Whether a disclaimer must be shown alongside this image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to display. */
  disclaimerText?: string | null;
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
    // OMITTED when absent, never `?? null`. Both columns are NOT NULL with
    // defaults ('unverified' and false), and an explicit null overrides a
    // default rather than falling back to it — so the whole finalize UPDATE
    // raised 23502 whenever a provider returned no accuracy metadata, leaving
    // the visual stuck un-ready. Nothing surfaced it because this call discards
    // its result. Omitting the key leaves the column at its existing value.
    ...(args.accuracyStatus != null ? { accuracy_status: args.accuracyStatus } : {}),
    ...(args.disclaimerRequired != null ? { disclaimer_required: args.disclaimerRequired } : {}),
    disclaimer_text: args.disclaimerText ?? null,
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
