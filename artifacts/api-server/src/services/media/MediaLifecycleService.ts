/**
 * MediaLifecycleService — durable processing attempts and owner-authorized
 * deletion for `media_assets`.
 *
 * SCHEMA: migrations 2951 (attempt counters, retry clock, lease columns and
 * `media_processing_attempts`), 2952 (`deleted_at` / `purge_status` and
 * `media_asset_lifecycle_events`) and 2953 (retention timestamps). All three are
 * already applied to production and CI; 2955 revokes the client write grants on
 * the three tables, so every write below is a service-role write by design.
 *
 * TWO INVARIANTS RUN THROUGH THE WHOLE FILE:
 *
 *   1. EVERY state transition is a CONDITIONAL update that re-asserts what the
 *      caller believed — the asset id AND the lease token it holds (or, for the
 *      claim, the attempt count it read). PostgREST answers an UPDATE matching
 *      ZERO rows with `error: null`, so "no error" is not proof of a write. Each
 *      one therefore `.select()`s the row back and checks it, which is what makes
 *      a lost race observable instead of silently successful.
 *   2. Storage purge is NOT part of the authorization transition. Soft delete
 *      commits the row state and the audit event synchronously; the bytes are
 *      removed on the shared background-work tracker, and a failed purge is
 *      recorded (`purge_status='failed'` + a `purge_failed` event) rather than
 *      rolled back — the object is already withdrawn from every read path.
 *
 * `moderation_status='owner_deleted'` and `processing_status IN
 * ('queued','removed')` are all inside the CHECK vocabularies migration 2250
 * (re-asserted by 2470) and 0191 lay down.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeDerivedMedia, type DerivativeErasureSource } from "./DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "./MediaCleanupTransport.js";
import { validAssetId, validVersion } from "../../lib/media/adaptive/types.js";
import { logger } from "../../lib/logger.js"; import { isFlagEnabled } from "../../lib/featureFlags.js";

/** The subset of the request logger this service needs. */
export interface LifecycleLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export const DEFAULT_PROCESSING_MAX_ATTEMPTS = 5;
export const DEFAULT_PROCESSING_LEASE_MS = 5 * 60_000;
export const DEFAULT_RETRY_BASE_MS = 30_000;

export interface ProcessingClaim {
  assetId: string;
  attemptNumber: number;
  leaseToken: string;
  leaseUntil: string;
}

export interface ProcessingResult {
  ok: boolean;
  terminal: boolean;
  attemptNumber: number;
  nextRetryAt: string | null;
}

export interface SoftDeleteResult {
  ok: boolean;
  alreadyDeleted: boolean;
  purgeScheduled: boolean;
  /**
   * The storage purge, for a caller that wants to await it — tests, a worker,
   * a shutdown drain. A REQUEST HANDLER MUST IGNORE IT: the authorization
   * transition is already committed when this returns and the response must not
   * wait on object storage. It never rejects (failures are recorded on the row
   * and in `media_asset_lifecycle_events`, then logged), so ignoring it cannot
   * raise an unhandled rejection.
   */
  purge?: Promise<void>;
}

export interface RetryProcessingResult {
  ok: boolean;
  alreadyQueued: boolean; /** census-media §30: set on a refusal that wrote nothing — see retryRefusal at the end of this file. */ notRetryable?: boolean; workerDisabled?: boolean; /** tm-followups WP-17: the asset read or the re-queue write FAILED — an outage, never "not found". */ dbError?: string;
}

function token(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function retryAt(attempt: number, now: number): string {
  const delay = DEFAULT_RETRY_BASE_MS * Math.min(32, 2 ** Math.max(0, attempt - 1));
  return new Date(now + delay).toISOString();
}

/**
 * Atomically claims a due processing asset. The conditional update makes
 * duplicate workers harmless: only one lease token can be persisted.
 */
export async function claimMediaProcessing(
  sc: SupabaseClient,
  assetId: string,
  opts: { leaseMs?: number; now?: Date } = {},
): Promise<ProcessingClaim | null> {
  const now = opts.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_PROCESSING_LEASE_MS));
  const leaseToken = token();
  const { data: row, error: readError } = await sc
    .from("media_assets")
    .select("id, processing_status, processing_attempt_count, processing_next_retry_at, processing_lease_until, processing_terminal")
    .eq("id", assetId)
    .maybeSingle();
  if (readError || !row || row.processing_terminal) return null;
  const due = !row.processing_next_retry_at || new Date(row.processing_next_retry_at).getTime() <= now.getTime();
  const leaseFree = !row.processing_lease_until || new Date(row.processing_lease_until).getTime() <= now.getTime();
  if (!due || !leaseFree || !["processing", "failed", "queued", "uploaded"].includes(row.processing_status)) return null;
  const attemptNumber = Number(row.processing_attempt_count ?? 0) + 1;
  const { data: claimed, error } = await sc.from("media_assets").update({
    processing_status: "processing",
    processing_attempt_count: attemptNumber,
    processing_last_attempt_at: now.toISOString(),
    processing_lease_until: leaseUntil.toISOString(),
    processing_lease_token: leaseToken,
    processing_error: null,
    updated_at: now.toISOString(),
  }).eq("id", assetId).eq("processing_attempt_count", Number(row.processing_attempt_count ?? 0))
    .select("id, processing_lease_token").maybeSingle();
  // Supabase returns error=null for an UPDATE matching zero rows. Requiring
  // the updated row (and the exact lease token) makes a lost race observable.
  if (error || !claimed || claimed.id !== assetId || claimed.processing_lease_token !== leaseToken) return null;
  const { error: attemptError } = await sc.from("media_processing_attempts").upsert({
    media_asset_id: assetId,
    attempt_number: attemptNumber,
    lease_token: leaseToken,
    status: "claimed",
    started_at: now.toISOString(),
  }, { onConflict: "media_asset_id,attempt_number" });
  if (attemptError) {
    // The lease was taken but its attempt row did not land, so nothing would
    // ever record how this attempt ended. Release the lease so the asset is
    // claimable again at its next due time; a failed release is not recoverable
    // here either, and both paths answer "no claim" — the lease simply expires.
    const { error: releaseError } = await sc.from("media_assets").update({
      processing_lease_until: null,
      processing_lease_token: null,
      processing_error: "Could not persist processing attempt",
      updated_at: new Date().toISOString(),
    }).eq("id", assetId).eq("processing_lease_token", leaseToken);
    if (releaseError) {
      console.warn(
        "MediaLifecycleService: a lease whose attempt row failed to persist could not be released — it will expire instead",
        { assetId, code: (releaseError as any)?.code, message: (releaseError as any)?.message },
      );
    }
    return null;
  }
  return { assetId, attemptNumber, leaseToken, leaseUntil: leaseUntil.toISOString() };
}

export async function completeMediaProcessing(
  sc: SupabaseClient,
  claim: ProcessingClaim,
  input: { width: number; height: number; durationMs?: number | null; thumbnailPath?: string | null; thumbnailUrl?: string | null },
): Promise<boolean> {
  if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
    throw new Error(`completeMediaProcessing: positive dimensions required for ${claim.assetId}`);
  }
  const now = new Date().toISOString();
  const { data: updated, error } = await sc.from("media_assets").update({
    processing_status: "ready",
    processing_completed_at: now,
    processing_next_retry_at: null,
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    processing_terminal: false,
    width: input.width,
    height: input.height,
    duration_ms: input.durationMs ?? null,
    thumbnail_path: input.thumbnailPath ?? null,
    thumbnail_url: input.thumbnailUrl ?? null,
    updated_at: now,
  }).eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken)
    .select("id, processing_lease_token").maybeSingle();
  if (error || !updated || updated.id !== claim.assetId || updated.processing_lease_token !== null) return false;
  const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
    status: "succeeded",
    completed_at: now,
  }).eq("media_asset_id", claim.assetId).eq("attempt_number", claim.attemptNumber).eq("lease_token", claim.leaseToken)
    .select("media_asset_id, attempt_number, lease_token").maybeSingle();
  return !attemptError && !!attempt &&
    attempt.media_asset_id === claim.assetId &&
    Number(attempt.attempt_number) === claim.attemptNumber &&
    attempt.lease_token === claim.leaseToken;
}

export async function failMediaProcessing(
  sc: SupabaseClient,
  claim: ProcessingClaim,
  message: string,
  opts: { maxAttempts?: number; now?: Date } = {},
): Promise<ProcessingResult> {
  const now = opts.now ?? new Date();
  const terminal = claim.attemptNumber >= (opts.maxAttempts ?? DEFAULT_PROCESSING_MAX_ATTEMPTS);
  const nextRetryAt = terminal ? null : retryAt(claim.attemptNumber, now.getTime());
  const nowIso = now.toISOString();
  const { data: updated, error } = await sc.from("media_assets").update({
    // 'failed' either way: `processing_terminal` is what distinguishes a run
    // that will be retried from one that will not, so the status stays the
    // single value the 0191 CHECK vocabulary has for a failed attempt.
    processing_status: "failed",
    processing_terminal: terminal,
    processing_error: message.slice(0, 2000),
    processing_next_retry_at: nextRetryAt,
    processing_lease_until: null,
    processing_lease_token: null,
    updated_at: nowIso,
  }).eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken)
    .select("id, processing_lease_token").maybeSingle();
  if (error || !updated || updated.id !== claim.assetId || updated.processing_lease_token !== null) {
    return { ok: false, terminal, attemptNumber: claim.attemptNumber, nextRetryAt };
  }
  const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
    status: terminal ? "terminal_failure" : "retryable_failure",
    error_message: message.slice(0, 2000),
    completed_at: nowIso,
  }).eq("media_asset_id", claim.assetId)
    .eq("attempt_number", claim.attemptNumber)
    .eq("lease_token", claim.leaseToken)
    .select("media_asset_id, attempt_number, lease_token").maybeSingle();
  return {
    ok: !attemptError && !!attempt &&
      attempt.media_asset_id === claim.assetId &&
      Number(attempt.attempt_number) === claim.attemptNumber &&
      attempt.lease_token === claim.leaseToken,
    terminal,
    attemptNumber: claim.attemptNumber,
    nextRetryAt,
  };
}

export async function recoverStaleMediaProcessing(
  sc: SupabaseClient,
  opts: { now?: Date; retryAfterMs?: number; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = now.toISOString();
  const nextRetry = new Date(now.getTime() + (opts.retryAfterMs ?? DEFAULT_RETRY_BASE_MS)).toISOString();
  const { data, error } = await sc.from("media_assets")
    .select("id, processing_attempt_count, processing_lease_token")
    .eq("processing_status", "processing")
    .lt("processing_lease_until", cutoff)
    .limit(opts.limit ?? 100);
  if (error || !data) return 0;
  let recovered = 0;
  for (const row of data as Array<{ id: string; processing_attempt_count?: number; processing_lease_token?: string }>) {
    const result = await sc.from("media_assets").update({
      processing_status: "failed",
      processing_error: "Processing lease expired; scheduled for retry",
      processing_next_retry_at: nextRetry,
      processing_lease_until: null,
      processing_lease_token: null,
      updated_at: cutoff,
    }).eq("id", row.id).eq("processing_lease_token", row.processing_lease_token ?? "")
      .select("id, processing_lease_token").maybeSingle();
    if (!result.error && result.data?.id === row.id && result.data?.processing_lease_token === null) {
      const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
        status: "recovered",
        error_message: "Processing lease expired; scheduled for retry",
        completed_at: cutoff,
      }).eq("media_asset_id", row.id)
        .eq("attempt_number", Number(row.processing_attempt_count ?? 0))
        .eq("lease_token", row.processing_lease_token ?? "")
        .select("media_asset_id, attempt_number, lease_token").maybeSingle();
      if (!attemptError && attempt &&
          attempt.media_asset_id === row.id &&
          Number(attempt.attempt_number) === Number(row.processing_attempt_count ?? 0) &&
          attempt.lease_token === row.processing_lease_token) {
        recovered++;
      }
    }
  }
  return recovered;
}

const PURGE_COLUMNS = "id, version, storage_bucket, storage_path, size_bytes, thumbnail_path, owner_user_id, media_type, deleted_at, moderation_status, purge_status, updated_at";
const PURGE_RETRY_COOLDOWN_MS = 300000;
const PURGE_STALE_PENDING_MS = 1800000;

interface PurgeOptions {
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: number;
}

interface PurgeSource extends DerivativeErasureSource {
  owner_user_id: string;
  thumbnail_path: string | null;
  deleted_at: string;
  updated_at: string;
}

function withdrawnPurgeSource(asset: any): asset is PurgeSource {
  return asset && validAssetId(asset.id) && validAssetId(asset.owner_user_id) && validVersion(asset.version)
    && typeof asset.deleted_at === "string" && Number.isFinite(Date.parse(asset.deleted_at))
    && ["owner_deleted", "removed"].includes(asset.moderation_status) && ["pending", "failed"].includes(asset.purge_status)
    && typeof asset.storage_bucket === "string" && asset.storage_bucket.length > 0
    && typeof asset.storage_path === "string" && asset.storage_path.length > 0;
}

async function purgeStorage(client: SupabaseClient, assetId: string, actorUserId: string, options: PurgeOptions = {}): Promise<void> {
  let claimedVersion: number | undefined;
  try {
    await withMediaCleanup(client, async (sc, signal) => {
      const { data: asset, error } = await sc.from("media_assets").select(PURGE_COLUMNS).eq("id", assetId).maybeSingle();
      if (error || !withdrawnPurgeSource(asset) || asset.id !== assetId || asset.owner_user_id !== actorUserId
        || (options.expectedVersion !== undefined && asset.version !== options.expectedVersion)) throw new Error("Media purge source changed or unavailable");
      claimedVersion = asset.version;
      await purgeDerivedMedia(sc, asset, options.env);
      signal.throwIfAborted();
      const { data: current, error: currentError } = await sc.from("media_assets").select(PURGE_COLUMNS)
        .eq("id", assetId).eq("version", claimedVersion).eq("owner_user_id", actorUserId).maybeSingle();
      if (currentError || !withdrawnPurgeSource(current) || current.storage_bucket !== asset.storage_bucket
        || current.storage_path !== asset.storage_path || current.thumbnail_path !== asset.thumbnail_path) throw new Error("Media purge source changed or unavailable");
      const paths = [...new Set([asset.storage_path, asset.thumbnail_path].filter((path): path is string => typeof path === "string" && path.length > 0))];
      const { error: storageError } = await sc.storage.from(asset.storage_bucket).remove(paths);
      if (storageError) throw storageError;
      signal.throwIfAborted();
      const now = new Date().toISOString();
      const { data: completed, error: completionError } = await sc.from("media_assets")
        .update({ purge_status: "completed", purged_at: now, purge_error: null, updated_at: now })
        .eq("id", assetId).eq("owner_user_id", actorUserId).eq("version", claimedVersion)
        .eq("purge_status", asset.purge_status).eq("deleted_at", asset.deleted_at).select("id, purge_status").maybeSingle();
      if (completionError || completed?.id !== assetId || completed.purge_status !== "completed") throw new Error("Media purge completion unconfirmed");
      const { error: auditError } = await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId,
        event_type: "purge_succeeded", details: { objectCount: paths.length } });
      if (auditError) throw auditError;
    }, options);
  } catch (error) {
    if (claimedVersion !== undefined) {
      try {
        await withMediaCleanup(client, async sc => {
          const message = error instanceof Error ? error.message : "Media purge failed";
          const { data: failed, error: recordError } = await sc.from("media_assets")
            .update({ purge_status: "failed", purge_error: message.slice(0, 2000), updated_at: new Date().toISOString() })
            .eq("id", assetId).eq("owner_user_id", actorUserId).eq("version", claimedVersion)
            .in("purge_status", ["pending", "failed"]).select("id").maybeSingle();
          if (recordError) throw recordError;
          if (failed?.id === assetId) {
            const { error: auditError } = await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId,
              event_type: "purge_failed", details: { error: message.slice(0, 2000) } });
            if (auditError) throw auditError;
          }
        }, { timeoutMs: 5000, operationTimeoutMs: options.operationTimeoutMs });
      } catch (recordError) { logger.warn({ assetId, err: recordError }, "media purge failure could not be recorded"); }
    }
    throw error;
  }
}

export async function purgeWithdrawnAccountMedia(client: SupabaseClient, assetId: string, ownerUserId: string,
  options: PurgeOptions & { expectedVersion: number }): Promise<void> {
  if (!validAssetId(assetId) || !validAssetId(ownerUserId) || !validVersion(options.expectedVersion)) throw new Error("Invalid account Media purge identity");
  await purgeStorage(client, assetId, ownerUserId, options);
}

export async function retryFailedMediaPurges(client: SupabaseClient, options: PurgeOptions & { limit?: number } = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid purge retry bound");
  return withMediaCleanup(client, async (sc, signal) => {
    const result = { attempted: 0, completed: 0, failed: 0, skipped: 0 };
    const candidates: PurgeSource[] = [];
    for (const status of ["failed", "pending"]) {
      signal.throwIfAborted();
      const cutoff = new Date(Date.now() - (status === "failed" ? PURGE_RETRY_COOLDOWN_MS : PURGE_STALE_PENDING_MS)).toISOString();
      const { data: rows, error } = await sc.from("media_assets").select(PURGE_COLUMNS)
        .eq("purge_status", status).lte("updated_at", cutoff).not("deleted_at", "is", null)
        .order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
      if (error || !Array.isArray(rows)) throw new Error("Media purge retry state unavailable");
      for (const row of rows) {
        if (!withdrawnPurgeSource(row)) throw new Error("Invalid media purge retry source");
        candidates.push(row);
      }
    }
    candidates.sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));
    for (const row of candidates.slice(0, limit)) {
      signal.throwIfAborted();
      const { data: claim, error: claimError } = await sc.from("media_assets")
        .update({ purge_status: "pending", updated_at: new Date(Date.now()).toISOString() })
        .eq("id", row.id).eq("owner_user_id", row.owner_user_id).eq("version", row.version)
        .eq("purge_status", row.purge_status).eq("updated_at", row.updated_at).select("id, version, purge_status").maybeSingle();
      if (claimError) throw new Error("Media purge retry claim unconfirmed");
      if (!claim) { result.skipped++; continue; }
      if (claim.id !== row.id || !validVersion(claim.version) || claim.version <= row.version || claim.purge_status !== "pending") throw new Error("Invalid media purge retry claim");
      result.attempted++;
      try {
        await purgeStorage(client, row.id, row.owner_user_id, { ...options, signal, expectedVersion: claim.version });
        result.completed++;
      } catch { result.failed++; }
    }
    signal.throwIfAborted();
    return result;
  }, { ...options, timeoutMs: options.timeoutMs ?? 120000 });
}

/**
 * Soft-delete is synchronous only for the authorization/state transition.
 * Storage deletion is deliberately non-blocking in production and observable
 * through the shared background-work tracker in tests.
 */
export async function softDeleteMediaAsset(
  sc: SupabaseClient,
  assetId: string,
  actorUserId: string,
  opts: { logger?: LifecycleLogger | null } = {},
): Promise<SoftDeleteResult> {
  const { data: asset, error: readError } = await sc.from("media_assets")
    .select("id, owner_user_id, moderation_status, purge_status")
    .eq("id", assetId).maybeSingle();
  if (readError || !asset || asset.owner_user_id !== actorUserId) return { ok: false, alreadyDeleted: false, purgeScheduled: false };
  if (asset.purge_status === "completed" || asset.moderation_status === "owner_deleted") {
    return { ok: true, alreadyDeleted: true, purgeScheduled: false };
  }
  const now = new Date().toISOString();
  const { error } = await sc.from("media_assets").update({
    moderation_status: "owner_deleted",
    processing_status: "removed",
    deleted_at: now,
    purge_requested_at: now,
    purge_status: "pending",
    updated_at: now,
  }).eq("id", assetId).eq("owner_user_id", actorUserId);
  if (error) return { ok: false, alreadyDeleted: false, purgeScheduled: false };
  const { error: auditError } = await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId, event_type: "soft_deleted", details: {} });
  if (auditError) {
    const { error: rollbackError } = await sc.from("media_assets").update({
      moderation_status: asset.moderation_status,
      processing_status: "ready",
      deleted_at: null,
      purge_requested_at: null,
      purge_status: asset.purge_status ?? "not_requested",
      updated_at: new Date().toISOString(),
    }).eq("id", assetId).eq("owner_user_id", actorUserId);
    if (rollbackError) return { ok: false, alreadyDeleted: false, purgeScheduled: false };
    return { ok: false, alreadyDeleted: false, purgeScheduled: false };
  }
  // The row is already withdrawn from every read path. The BYTES are removed
  // out of band: a slow or failing object store must not hold the response, and
  // a failed purge is RECORDED (`purge_status='failed'` + a `purge_failed`
  // lifecycle event) rather than rolled back — undoing the deletion because the
  // storage call failed would put the object back in front of viewers, which is
  // the one outcome the owner asked not to happen.
  const purge = purgeStorage(sc, assetId, actorUserId).catch(async (purgeError) => {
    // Swallowed on purpose: the returned promise is documented as never
    // rejecting so an ignoring caller cannot produce an unhandled rejection.
    (opts.logger ?? logger).warn({ assetId, err: purgeError }, "media asset storage purge failed");
  });
  return { ok: true, alreadyDeleted: false, purgeScheduled: true, purge };
}

/** Owner-only retry request. It clears terminal state but leaves attempt history. */
export async function retryMediaProcessing(
  sc: SupabaseClient,
  assetId: string,
  actorUserId: string,
): Promise<RetryProcessingResult> {
  const { data: asset, error: readError } = await sc.from("media_assets")
    .select("id, owner_user_id, processing_status, processing_terminal, purge_status")
    .eq("id", assetId).maybeSingle();
  if (readError) return { ok: false, alreadyQueued: false, dbError: readError.message }; if (!asset || asset.owner_user_id !== actorUserId || asset.purge_status === "completed") {
    return { ok: false, alreadyQueued: false };
  }
  if (asset.processing_status === "queued" || asset.processing_status === "processing") {
    return { ok: true, alreadyQueued: true };
  } const refusal = await retryRefusal(sc, asset.processing_status); if (refusal) return refusal; // census-media §30: only a FAILED run is re-queued, and only while a worker will claim it
  const { data: requeued, error } = await sc.from("media_assets").update({
    processing_status: "queued",
    processing_terminal: false,
    processing_next_retry_at: new Date().toISOString(),
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", assetId).eq("owner_user_id", actorUserId).eq("processing_status", "failed").select("id, processing_status").maybeSingle();
  return error ? { ok: false, alreadyQueued: false, dbError: error.message } : requeued?.id === assetId && requeued?.processing_status === "queued" ? { ok: true, alreadyQueued: false } : { ok: false, alreadyQueued: false, notRetryable: true };
}

// ── census-media §30 (MD338): what an owner's retry may re-queue ─────────────
//
// Appended at the end, and the lines of retryMediaProcessing that call it were
// extended in place, because the census cites this file by line.
//
// THE DEFECT. The retry used to refuse only `queued` and `processing`, so a
// `ready` asset was re-queued too — and every canonical reader serves `ready`
// only (`services/wall/WallCandidateLoaders.ts`, `services/intel/PresenceVerifier.ts`),
// so one POST took the owner's asset off every read path. Nothing claimed
// queued work either, so it stayed off them.
//
// THE RULE NOW. Only `failed` is retryable: it is the one value this file writes
// for a run that did not produce a ready asset (`failMediaProcessing` writes it,
// terminal or not; `recoverStaleMediaProcessing` writes it when a lease lapses).
// `ready` has nothing to retry; `removed` is an owner deletion; `rejected` and
// `expired` are not processing outcomes an owner can undo. `queued` and
// `processing` are still answered as `alreadyQueued`, unchanged. The UPDATE is
// also conditional on `processing_status = 'failed'` and reads its row back
// (invariant 1 above), so an asset that became `ready` between the read and the
// write is not re-queued by a lost race either.
//
// AND ONLY WHILE SOMETHING WILL CLAIM IT. A failed asset re-queued while the
// processing worker (`lib/media/mediaProcessingWorker.ts`) is off would be
// parked in `queued` for good — the second half of the same defect. So the
// retry reads the worker's own flag and refuses, writing nothing, while it is
// off, absent or unreadable (isFlagEnabled is fail-closed).

/** The worker's capability flag. Seeded FALSE by migration 3338. */
export const MEDIA_PROCESSING_WORKER_FLAG = "media_processing_worker_enabled";

/**
 * Is the processing worker allowed to run? One reader, shared by the worker's
 * pass and by the retry, so "the worker is on" and "a retry may queue work for
 * it" cannot disagree. Fail-closed: absent, false or unreadable ⇒ false.
 */
export async function isMediaProcessingWorkerEnabled(sc: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_PROCESSING_WORKER_FLAG);
}

/** Why a retry of an owner's own, non-queued asset writes nothing — or null to proceed. */
async function retryRefusal(sc: SupabaseClient, processingStatus: unknown): Promise<RetryProcessingResult | null> {
  if (processingStatus !== "failed") return { ok: false, alreadyQueued: false, notRetryable: true };
  if (!(await isMediaProcessingWorkerEnabled(sc))) return { ok: false, alreadyQueued: false, workerDisabled: true };
  return null;
}

// ── census-media §32.13: the measured size, written where the lifecycle is ────
//
// Appended at the end, because the census cites this file by line.
//
// The processing worker (`lib/media/mediaProcessingWorker.ts`) replaces an
// honest zero `size_bytes` with the stored object's measured size before the
// asset can be completed `ready`. That write used to live in the worker itself,
// which made a file named "worker" a writer of `media_assets` — canonical
// storage, not a projection — and `check:projection-consumers` rightly refused
// it. It is a lease-conditioned lifecycle write like every other in this file,
// so it lives here and keeps invariant 1: conditional on the asset id, the lease
// token the caller holds AND the zero it read (so a recorded size, which every
// upload-route row has, is never overwritten), and read back, because a
// zero-row UPDATE is `error: null` too.

/**
 * Record the stored object's measured size over an honest zero, while `claim`
 * still holds the lease. True only when exactly this asset's row came back: a
 * write error, a lost lease or a size someone else already recorded are all false,
 * and the caller fails the attempt retryably rather than completing it.
 */
export async function recordMeasuredMediaSize(sc: SupabaseClient, claim: ProcessingClaim, sizeBytes: number): Promise<boolean> {
  if (!(Number.isInteger(sizeBytes) && sizeBytes > 0)) return false;
  const { data, error } = await sc.from("media_assets").update({ size_bytes: sizeBytes })
    .eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken).eq("size_bytes", 0)
    .select("id, size_bytes");
  if (error || !Array.isArray(data) || data.length !== 1) return false;
  return data[0]?.id === claim.assetId && Number(data[0]?.size_bytes) === sizeBytes;
}
