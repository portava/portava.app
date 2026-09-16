import type { SupabaseClient } from "@supabase/supabase-js";
import { trackBackgroundWork, type BackgroundWorkLogger } from "../../lib/backgroundWork.js";

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
}

export interface RetryProcessingResult {
  ok: boolean;
  alreadyQueued: boolean;
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
    const { error: releaseError } = await sc.from("media_assets").update({
      processing_lease_until: null,
      processing_lease_token: null,
      processing_error: "Could not persist processing attempt",
      updated_at: new Date().toISOString(),
    }).eq("id", assetId).eq("processing_lease_token", leaseToken);
    if (releaseError) return null;
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
    processing_status: terminal ? "failed" : "failed",
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

async function purgeStorage(sc: SupabaseClient, assetId: string, actorUserId: string): Promise<void> {
  const { data: asset, error } = await sc.from("media_assets")
    .select("storage_bucket, storage_path, thumbnail_path, owner_user_id")
    .eq("id", assetId).maybeSingle();
  if (error || !asset || asset.owner_user_id !== actorUserId) throw new Error("Media asset owner changed or asset is missing");
  const paths = [...new Set([asset.storage_path, asset.thumbnail_path].filter((p): p is string => Boolean(p)))];
  if (paths.length) {
    const { error: storageError } = await sc.storage.from(asset.storage_bucket).remove(paths);
    if (storageError) throw storageError;
  }
  const now = new Date().toISOString();
  const { error: completionError } = await sc.from("media_assets").update({ purge_status: "completed", purged_at: now, purge_error: null, updated_at: now }).eq("id", assetId);
  if (completionError) throw completionError;
  const { error: auditError } = await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId, event_type: "purge_succeeded", details: { objectCount: paths.length } });
  if (auditError) throw auditError;
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
  opts: { logger?: BackgroundWorkLogger | null } = {},
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
  trackBackgroundWork(
    purgeStorage(sc, assetId, actorUserId).catch(async (purgeError) => {
      const message = purgeError instanceof Error ? purgeError.message : String(purgeError);
      const failedAt = new Date().toISOString();
      await sc.from("media_assets").update({ purge_status: "failed", purge_error: message.slice(0, 2000), updated_at: failedAt }).eq("id", assetId);
      await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId, event_type: "purge_failed", details: { error: message.slice(0, 2000) } });
      throw purgeError;
    }),
    { label: "media-asset-storage-purge", logger: opts.logger, context: { assetId } },
  );
  return { ok: true, alreadyDeleted: false, purgeScheduled: true };
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
  if (readError || !asset || asset.owner_user_id !== actorUserId || asset.purge_status === "completed") {
    return { ok: false, alreadyQueued: false };
  }
  if (asset.processing_status === "queued" || asset.processing_status === "processing") {
    return { ok: true, alreadyQueued: true };
  }
  const { error } = await sc.from("media_assets").update({
    processing_status: "queued",
    processing_terminal: false,
    processing_next_retry_at: new Date().toISOString(),
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", assetId).eq("owner_user_id", actorUserId);
  return { ok: !error, alreadyQueued: false };
}