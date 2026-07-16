/**
 * Stamp Generation Worker
 *
 * Polls `stamp_generation_queue` for work, generates 3 candidate images per
 * catalog entry via the configured StampImageProvider, uploads to Supabase
 * storage, and inserts `stamp_artwork_versions` rows.
 *
 * The worker uses a pessimistic lock (locked_until / locked_by) so multiple
 * worker instances can run without producing duplicates.
 *
 * Start via startWorkerLoop() from index.ts — only when STAMP_WORKER_ENABLED=true.
 */

import { randomUUID } from "crypto";
import { getServiceClient } from "../supabase.js";
import { buildStampPrompt, STYLE_VERSION, CANDIDATE_COUNT } from "./artDirection.js";
import { getStampImageProvider } from "./imageProvider.js";
import type { CatalogEntryForPrompt } from "./artDirection.js";
import { invalidateCatalogCache } from "./StampCatalogService.js";

const WORKER_ID = `worker-${randomUUID()}`;
const LOCK_DURATION_MS = 5 * 60 * 1_000; // 5 min pessimistic lock
const STORAGE_BUCKET = "stamp-artwork";

// ── Image download + upload ───────────────────────────────────────────────────

async function downloadImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function uploadToStorage(
  sc: any,
  catalogId: string,
  versionId: string,
  buffer: Buffer,
  contentType = "image/png",
): Promise<string> {
  const path = `catalog/${catalogId}/${versionId}.png`;
  const { error } = await sc.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = sc.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(path);

  return urlData?.publicUrl ?? path;
}

// ── Single generation cycle ───────────────────────────────────────────────────

export async function runGenerationCycle(): Promise<{ processed: boolean; catalogId?: string }> {
  const sc = getServiceClient();
  if (!sc) {
    console.warn("[stamp-worker] Service client not available — skipping cycle");
    return { processed: false };
  }

  const now = new Date().toISOString();

  // Claim one queued job with a pessimistic lock
  const { data: job, error: jobErr } = await sc
    .from("stamp_generation_queue")
    .select("id, catalog_id, attempts, max_attempts, triggered_by_action")
    .eq("status", "queued")
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .order("priority")
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (jobErr) {
    console.error(JSON.stringify({ event: "stamp.queue.poll_error", error: jobErr.message }));
    return { processed: false };
  }

  if (!job) return { processed: false }; // Nothing to do

  const { id: jobId, catalog_id: catalogId } = job as any;

  // Acquire lock atomically — verify a row was actually updated, not just that no error occurred.
  // Without this check a race between two workers can let both proceed on the same job.
  const lockUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
  const { data: locked, error: lockErr } = await sc
    .from("stamp_generation_queue")
    .update({
      status:       "generating",
      locked_until: lockUntil,
      locked_by:    WORKER_ID,
      updated_at:   now,
    })
    .eq("id", jobId)
    .eq("status", "queued") // Guard: only transition from queued → generating
    .select("id");

  if (lockErr || !locked || (locked as any[]).length === 0) {
    // Another worker grabbed it first — skip silently
    return { processed: false };
  }

  console.log(JSON.stringify({ event: "stamp.generation.started", job_id: jobId, catalog_id: catalogId }));

  try {
    // Load catalog entry
    const { data: catalogRow, error: catErr } = await sc
      .from("universal_stamp_catalog")
      .select("id, canonical_location_key, stamp_type, display_name, country, country_code, region, city, neighborhood")
      .eq("id", catalogId)
      .maybeSingle();

    if (catErr || !catalogRow) {
      throw new Error(`catalog_not_found: ${catalogId}`);
    }

    const entry: CatalogEntryForPrompt = catalogRow as any;
    const prompt = buildStampPrompt(entry);

    // Generate candidates
    const provider = getStampImageProvider();
    const images = await provider.generate(prompt, CANDIDATE_COUNT);

    if (images.length === 0) {
      throw new Error("No images generated — all provider calls failed");
    }

    // Upload each candidate and insert artwork version rows
    const versionInserts: any[] = [];

    for (const img of images) {
      const versionId = randomUUID();

      // Download image buffer (skip for placeholder data-URLs)
      let storagePath: string;
      let publicUrl: string;

      if (img.url.startsWith("data:")) {
        // Placeholder provider — store URL as-is
        storagePath = `placeholder/${catalogId}/${versionId}.svg`;
        publicUrl   = img.url;
      } else {
        const buffer = await downloadImageBuffer(img.url);
        publicUrl   = await uploadToStorage(sc, catalogId, versionId, buffer);
        storagePath = `catalog/${catalogId}/${versionId}.png`;
      }

      versionInserts.push({
        id:                      versionId,
        catalog_id:              catalogId,
        status:                  "candidate",
        storage_path:            storagePath,
        public_url:              publicUrl,
        generation_source:       "ai_generated",
        provider:                (img.metadata.model as string) ?? "openai_dalle3",
        model_version:           "dall-e-3",
        prompt_used:             prompt,
        prompt_template_version: STYLE_VERSION,
        generation_metadata:     img.metadata,
      });
    }

    const { error: insertErr } = await sc
      .from("stamp_artwork_versions")
      .insert(versionInserts);

    if (insertErr) throw new Error(`version_insert_failed: ${insertErr.message}`);

    // Mark queue job as review_required
    await sc
      .from("stamp_generation_queue")
      .update({
        status:       "review_required",
        locked_until: null,
        locked_by:    null,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", jobId);

    // Invalidate cache so next catalog lookup re-reads fresh status
    invalidateCatalogCache(entry.canonical_location_key, entry.stamp_type);

    console.log(JSON.stringify({
      event:      "stamp.generation.success",
      job_id:     jobId,
      catalog_id: catalogId,
      candidates: images.length,
    }));

    return { processed: true, catalogId };

  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    console.error(JSON.stringify({
      event:      "stamp.generation.failed",
      job_id:     jobId,
      catalog_id: catalogId,
      error:      errorMsg,
    }));

    // Increment attempts; fall back to retryable_failed if max reached
    const newAttempts = ((job as any).attempts ?? 0) + 1;
    const maxAttempts = ((job as any).max_attempts ?? 3);
    const newStatus   = newAttempts >= maxAttempts ? "retryable_failed" : "queued";

    await sc
      .from("stamp_generation_queue")
      .update({
        status:       newStatus,
        attempts:     newAttempts,
        last_error:   errorMsg,
        locked_until: null,
        locked_by:    null,
        updated_at:   new Date().toISOString(),
      })
      .eq("id", jobId);

    return { processed: false };
  }
}

// ── Worker health ─────────────────────────────────────────────────────────────

export interface StampWorkerHealth {
  worker_enabled: boolean;
  worker_running: boolean;
  worker_id: string;
  last_success_at: string | null;
  queue_depth: Record<string, number>;
  stuck_jobs: Array<{
    id: string;
    catalog_id: string;
    locked_by: string | null;
    locked_until: string | null;
    updated_at: string | null;
  }>;
}

/**
 * Query worker health from the queue table.
 *
 * - last_success_at: most recent artwork version insert (persistent across restarts)
 * - queue_depth: count of queue rows per status
 * - stuck_jobs: rows still in `generating` whose lock has expired — a crashed
 *   worker never released them.
 *
 * Returns null when the service client is not configured.
 */
export async function queryStampWorkerHealth(): Promise<StampWorkerHealth | null> {
  const sc = getServiceClient();
  if (!sc) return null;

  const nowIso = new Date().toISOString();

  const [statusRes, lastSuccessRes, stuckRes] = await Promise.all([
    sc.from("stamp_generation_queue").select("status"),
    sc
      .from("stamp_artwork_versions")
      .select("created_at")
      .eq("generation_source", "ai_generated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sc
      .from("stamp_generation_queue")
      .select("id, catalog_id, locked_by, locked_until, updated_at")
      .eq("status", "generating")
      .lt("locked_until", nowIso)
      .order("locked_until")
      .limit(50),
  ]);

  if (statusRes.error) {
    throw new Error(`worker_health_query_failed: ${statusRes.error.message}`);
  }

  const queueDepth: Record<string, number> = {};
  for (const row of (statusRes.data ?? []) as Array<{ status: string }>) {
    queueDepth[row.status] = (queueDepth[row.status] ?? 0) + 1;
  }

  return {
    worker_enabled: process.env.STAMP_WORKER_ENABLED === "true",
    worker_running: _workerInterval !== null,
    worker_id: WORKER_ID,
    last_success_at: (lastSuccessRes.data as any)?.created_at ?? null,
    queue_depth: queueDepth,
    stuck_jobs: (stuckRes.data ?? []) as StampWorkerHealth["stuck_jobs"],
  };
}

// ── Worker loop ───────────────────────────────────────────────────────────────

let _workerInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkerLoop(intervalMs = 30_000): void {
  if (_workerInterval) return; // Already running

  console.log(JSON.stringify({
    event:       "stamp.worker.started",
    interval_ms: intervalMs,
    worker_id:   WORKER_ID,
  }));

  // Run immediately on start, then on interval
  runGenerationCycle().catch((e) =>
    console.error(JSON.stringify({ event: "stamp.worker.cycle_error", error: e?.message }))
  );

  _workerInterval = setInterval(() => {
    runGenerationCycle().catch((e) =>
      console.error(JSON.stringify({ event: "stamp.worker.cycle_error", error: e?.message }))
    );
  }, intervalMs);
}

export function stopWorkerLoop(): void {
  if (_workerInterval) {
    clearInterval(_workerInterval);
    _workerInterval = null;
    console.log(JSON.stringify({ event: "stamp.worker.stopped", worker_id: WORKER_ID }));
  }
}
