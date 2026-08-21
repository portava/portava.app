/**
 * AccountDeletionService
 *
 * Single implementation of "execute an account deletion request", shared by:
 *   - POST /admin/deletion-requests/:id/execute   (routes/admin.ts, manual)
 *   - accountDeletionScheduler                    (lib/accountDeletionScheduler.ts)
 *   - POST /internal/deletion-requests/execute-due (routes/profile.ts, worker endpoint)
 *
 * All paths MUST go through executeAccountDeletion() so the manual and the
 * scheduled path can never drift — a partial cascade in one of them is exactly
 * the kind of gap that turns the privacy policy into a false statement.
 *
 * ── Why a tombstone instead of `delete from profiles` ────────────────────────
 * Deleting the profiles row is NOT viable on the live schema:
 *   * 163 tables FK to profiles(id) ON DELETE CASCADE — that part would work;
 *   * but 54 more FK to it with NO ACTION (moderation_actions.performed_by,
 *     reports.reviewed_by, rent_buddy_earnings_ledger.*, posts.created_by, …).
 *     Any one referencing row makes the DELETE fail with a FK violation, so a
 *     row-delete strategy would abort partway for exactly the users who have
 *     the most history.
 *   * moderation and financial records are deliberately retained (the privacy
 *     policy says so), and they need a stable subject row to point at.
 *
 * So we keep an ANONYMISED tombstone profile and delete the user's *content*
 * explicitly. Because the tombstone survives, none of those 163 cascades fire
 * on their own — every content table below has to be handled here by hand.
 *
 * ── Why auth.admin.deleteUser is safe to call ────────────────────────────────
 * Migration 2121 deliberately removes the profiles(id) -> auth.users(id)
 * cascade and rebinds the deletion-request audit row to the retained profile.
 * Removing the auth user therefore drops the email address without deleting
 * the tombstone or the still-pending request that must be marked executed.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * Storage paths are collected BEFORE the owning DB rows are deleted, because
 * deleting posts cascades post_media away and we would lose the paths.
 */

import { randomUUID } from "node:crypto";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  deleteJourneySegmentsForUser,
  revokeJourneyConsentAndDeleteSegments,
} from "../../lib/journeySegmentRetention.js";

const logger = rootLogger.child({ service: "AccountDeletionService" });

export const PROFILE_MEDIA_BUCKET = "profile-media";
export const POST_MEDIA_BUCKET = "post-media";
const DELETED_HANDLE_PREFIX = "deleted_";
const DELETED_HANDLE_RANDOM_HEX_LENGTH = 22;
const PROFILE_HANDLE_MAX_ATTEMPTS = 3;
const DELETION_EXECUTION_LEASE_MS = 60 * 60 * 1000;

/** Per-step outcome. Steps are independent so one failure cannot hide another. */
export interface DeletionStepResult {
  step: string;
  ok: boolean;
  /** Rows (or storage objects) affected, when the step can report it. */
  count?: number;
  error?: string;
}

export interface DeletionOutcome {
  ok: boolean;
  userId: string;
  executedAt: string;
  steps: DeletionStepResult[];
  /** Steps that failed but are not fatal (storage, caches, best-effort writes). */
  warnings: string[];
}

export interface ExecuteOptions {
  /** Admin user id for the audit row, or null when executed by the scheduler. */
  actorId: string | null;
  reason?: string | null;
  /**
   * When true the profile tombstone + auth user are left alone and only the
   * content cascade runs. Used by tests; not exposed over HTTP.
   */
  contentOnly?: boolean;
  /**
   * Optional fail-closed audit hook. It runs after this service atomically
   * claims the request, but before the first destructive write.
   */
  beforeDestructiveWork?: () => Promise<void>;
}

/** Strip a public storage URL down to the object path inside `bucket`. */
export function storagePathFromPublicUrl(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null;
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length);
  return path.length > 0 ? path : null;
}

/**
 * Opaque public-schema placeholder for an anonymised profile.
 *
 * It intentionally contains no user/Auth identifier. The 22 random hex
 * characters keep the complete handle within the product's 30-character
 * lowercase username contract while making collisions vanishingly unlikely.
 */
export function createDeletedProfileHandle(): string {
  const randomHex = randomUUID().replaceAll("-", "").slice(0, DELETED_HANDLE_RANDOM_HEX_LENGTH);
  return `${DELETED_HANDLE_PREFIX}${randomHex}`;
}

function isProfileHandleUniqueConflict(error: any): boolean {
  if (error?.code !== "23505") return false;
  const detail = [
    error?.message,
    error?.details,
    error?.hint,
    error?.constraint,
  ].filter(Boolean).join(" ").toLowerCase();
  return detail.includes("profiles_handle_key")
    || detail.includes("profiles_handle")
    || detail.includes("(handle)");
}

function isAuthUserAlreadyAbsent(error: any): boolean {
  const code = String(error?.code ?? error?.error_code ?? "").toLowerCase();
  if (code === "user_not_found" || code === "user_not_found_error") return true;
  const status = Number(error?.status ?? error?.statusCode);
  const message = String(error?.message ?? "").toLowerCase();
  return status === 404 && message.includes("user") && message.includes("not found");
}

function timestampsRepresentSameInstant(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expected);
  return Number.isFinite(actualMs)
    && Number.isFinite(expectedMs)
    && actualMs === expectedMs;
}

interface DeletionClaim {
  token: string;
  startedAt: string;
}

async function claimDeletionRequest(sc: any, userId: string): Promise<DeletionClaim> {
  const token = randomUUID();
  const nowMs = Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + DELETION_EXECUTION_LEASE_MS).toISOString();
  const claimPatch = {
    status: "executing",
    execution_token: token,
    execution_started_at: startedAt,
    execution_lease_expires_at: leaseExpiresAt,
    cancelled_at: null,
    executed_at: null,
  };

  const attempt = async (status: "pending" | "executing") => {
    let query = sc
      .from("user_deletion_requests")
      .update(claimPatch)
      .eq("user_id", userId)
      .eq("status", status);
    if (status === "executing") {
      query = query.lte("execution_lease_expires_at", startedAt);
    }
    return query
      .select("user_id, status, execution_token, execution_started_at, execution_lease_expires_at")
      .maybeSingle();
  };

  let res = await attempt("pending");
  if (!res?.error && !res?.data) res = await attempt("executing");
  must(res, "claim deletion request");

  const row = res?.data as any;
  if (!row) {
    throw new Error("claim deletion request: no cancellable or expired request row matched");
  }
  if (
    row.user_id !== userId
    || row.status !== "executing"
    || row.execution_token !== token
    || !timestampsRepresentSameInstant(row.execution_started_at, startedAt)
    || !timestampsRepresentSameInstant(row.execution_lease_expires_at, leaseExpiresAt)
  ) {
    throw new Error("claim deletion request: verification failed");
  }
  return { token, startedAt };
}

async function releaseUndestructiveClaim(
  sc: any,
  userId: string,
  claim: DeletionClaim,
): Promise<void> {
  const res = await sc
    .from("user_deletion_requests")
    .update({
      status: "pending",
      execution_token: null,
      execution_started_at: null,
      execution_lease_expires_at: null,
    })
    .eq("user_id", userId)
    .eq("status", "executing")
    .eq("execution_token", claim.token)
    .select("user_id, status")
    .maybeSingle();
  must(res, "release deletion request claim");
  if (!res?.data || res.data.user_id !== userId || res.data.status !== "pending") {
    throw new Error("release deletion request claim: verification failed");
  }
}

async function expireDestructiveClaim(
  sc: any,
  userId: string,
  claim: DeletionClaim,
): Promise<void> {
  const expiredAt = new Date(
    Math.max(Date.now(), Date.parse(claim.startedAt) + 1),
  ).toISOString();
  const res = await sc
    .from("user_deletion_requests")
    .update({ execution_lease_expires_at: expiredAt })
    .eq("user_id", userId)
    .eq("status", "executing")
    .eq("execution_token", claim.token)
    .select("user_id, status, execution_token")
    .maybeSingle();
  must(res, "expire deletion request claim");
  if (
    !res?.data
    || res.data.user_id !== userId
    || res.data.status !== "executing"
    || res.data.execution_token !== claim.token
  ) {
    throw new Error("expire deletion request claim: verification failed");
  }
}

async function anonymiseProfileTombstone(sc: any, userId: string): Promise<void> {
  for (let attempt = 1; attempt <= PROFILE_HANDLE_MAX_ATTEMPTS; attempt += 1) {
    const handle = createDeletedProfileHandle();
    const updatedAt = new Date().toISOString();
    const res = await sc
      .from("profiles")
      .update({
        handle,
        username: null,
        username_updated_at: null,
        display_name: null,
        name: "Deleted User",
        full_name: null,
        bio: null,
        bio_original_language: null,
        avatar_url: null,
        cover_photo_url: null,
        avatar_image_width: null,
        avatar_image_height: null,
        cover_image_width: null,
        cover_image_height: null,
        home_city: null,
        home_country: null,
        current_city: null,
        location_city: null,
        location_country: null,
        city: null,
        country: null,
        country_code: null,
        flag_emoji: null,
        tagline: null,
        travel_style: null,
        interests: [],
        spoken_languages: [],
        default_language: null,
        preferred_language: null,
        travel_styles: [],
        travel_pace: null,
        budget_style: null,
        travel_group_style: [],
        looking_for: [],
        comfort_level: null,
        availability_tags: [],
        planning_style: null,
        public_social_links: {},
        expo_push_token: null,
        date_of_birth: null,
        dob_verified: false,
        verified: false,
        verification_status: "unverified",
        verified_at: null,
        verification_method: null,
        verification_expires_at: null,
        verification_level: "none",
        verified_since: null,
        id_verified_at: null,
        selfie_verified_at: null,
        home_country_verified_at: null,
        host_verified_at: null,
        buddy_verified_at: null,
        location_verified: false,
        open_to_meet: false,
        is_private: true,
        passport_visibility: "private",
        passport_section_order: null,
        passport_tab_order: null,
        passport_hidden_sections: null,
        preferred_message_language: "en",
        auto_translate_messages: true,
        show_original_messages: false,
        translation_updated_at: null,
        show_telegraph_dm: false,
        show_telegraph_trip: false,
        show_telegraph_circle: false,
        notifications_inbox_viewed_at: null,
        highlights_last_viewed_at: null,
        tag_permission: "nobody",
        trust_score: null,
        trust_label: null,
        is_official: false,
        featured_count: 0,
        show_profile_picture_publicly: false,
        account_status: "deleted",
        updated_at: updatedAt,
      })
      .eq("id", userId)
      .select("id, handle, account_status")
      .maybeSingle();

    if (res?.error) {
      if (
        attempt < PROFILE_HANDLE_MAX_ATTEMPTS
        && isProfileHandleUniqueConflict(res.error)
      ) {
        continue;
      }
      throw new Error(`anonymise profile: ${res.error.message ?? res.error}`);
    }

    const row = res?.data as any;
    if (!row) {
      throw new Error("anonymise profile: no profile row matched");
    }
    if (
      row.id !== userId
      || row.handle !== handle
      || row.account_status !== "deleted"
    ) {
      throw new Error("anonymise profile: tombstone verification failed");
    }
    return;
  }

  throw new Error("anonymise profile: exhausted handle collision retries");
}

async function step(
  steps: DeletionStepResult[],
  name: string,
  fn: () => Promise<number | void>,
): Promise<boolean> {
  try {
    const count = await fn();
    steps.push({ step: name, ok: true, ...(typeof count === "number" ? { count } : {}) });
    return true;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    steps.push({ step: name, ok: false, error: message });
    return false;
  }
}

/** Throw on a supabase-js `{ error }` envelope so `step` can record it. */
function must<T extends { error?: any }>(res: T, what: string): T {
  if (res?.error) throw new Error(`${what}: ${res.error.message ?? res.error}`);
  return res;
}

/**
 * Execute a deletion request end to end.
 *
 * Fatal steps (claiming the request, profile anonymisation, auth-user deletion,
 * marking the request executed) fail the whole call. Once destructive work has
 * started, a failed claim is expired for retry but remains non-cancellable.
 * Content and storage steps are recorded but do not abort the run: a user
 * whose media bucket is momentarily unavailable must still lose their posts,
 * their email, and their profile — a stalled deletion is worse than a partial
 * one, and the request stays auditable via `steps`.
 */
export async function executeAccountDeletion(
  sc: any,
  userId: string,
  opts: ExecuteOptions,
): Promise<DeletionOutcome> {
  const executedAt = new Date().toISOString();
  const steps: DeletionStepResult[] = [];
  const warnings: string[] = [];
  let claim: DeletionClaim | null = null;

  if (!opts.contentOnly) {
    const claimOk = await step(steps, "claim_deletion_request", async () => {
      claim = await claimDeletionRequest(sc, userId);
    });
    if (!claimOk || !claim) {
      return { ok: false, userId, executedAt, steps, warnings };
    }

    if (opts.beforeDestructiveWork) {
      const auditOk = await step(steps, "pre_deletion_audit", opts.beforeDestructiveWork);
      if (!auditOk) {
        await step(steps, "release_deletion_claim", async () => {
          await releaseUndestructiveClaim(sc, userId, claim!);
        });
        return { ok: false, userId, executedAt, steps, warnings };
      }
    }
  }

  // ── 1. Collect storage paths BEFORE the rows that hold them are deleted ────
  const storageTargets: Array<{ bucket: string; path: string }> = [];

  await step(steps, "collect_post_media_paths", async () => {
    const { data, error } = await sc
      .from("post_media")
      .select("storage_bucket, storage_path, thumbnail_storage_path")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as any[]) {
      const bucket = (row.storage_bucket as string) || POST_MEDIA_BUCKET;
      if (row.storage_path) storageTargets.push({ bucket, path: row.storage_path });
      if (row.thumbnail_storage_path) storageTargets.push({ bucket, path: row.thumbnail_storage_path });
    }
    return (data ?? []).length;
  });

  await step(steps, "collect_media_asset_paths", async () => {
    const { data, error } = await sc
      .from("media_assets")
      .select("storage_bucket, storage_path, thumbnail_path")
      .or(`owner_user_id.eq.${userId},uploader_user_id.eq.${userId}`);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as any[]) {
      const bucket = (row.storage_bucket as string) || POST_MEDIA_BUCKET;
      if (row.storage_path) storageTargets.push({ bucket, path: row.storage_path });
      if (row.thumbnail_path) storageTargets.push({ bucket, path: row.thumbnail_path });
    }
    return (data ?? []).length;
  });

  await step(steps, "collect_profile_media_paths", async () => {
    const { data, error } = await sc
      .from("profiles")
      .select("avatar_url, cover_photo_url")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    let found = 0;
    for (const url of [(data as any)?.avatar_url, (data as any)?.cover_photo_url]) {
      const path = storagePathFromPublicUrl(url, PROFILE_MEDIA_BUCKET);
      if (path) {
        storageTargets.push({ bucket: PROFILE_MEDIA_BUCKET, path });
        found += 1;
      }
    }
    return found;
  });

  // ── 2. Delete the storage objects ─────────────────────────────────────────
  if (storageTargets.length > 0) {
    const byBucket = new Map<string, string[]>();
    for (const t of storageTargets) {
      if (!byBucket.has(t.bucket)) byBucket.set(t.bucket, []);
      byBucket.get(t.bucket)!.push(t.path);
    }
    for (const [bucket, paths] of byBucket) {
      const ok = await step(steps, `delete_storage:${bucket}`, async () => {
        // Supabase caps remove() batches; chunk to stay well inside it.
        for (let i = 0; i < paths.length; i += 100) {
          must(await sc.storage.from(bucket).remove(paths.slice(i, i + 100)), "storage.remove");
        }
        return paths.length;
      });
      if (!ok) warnings.push(`storage objects in ${bucket} may remain`);
    }
  }

  // ── 3. Content rows ───────────────────────────────────────────────────────
  // posts CASCADEs to post_media, posts_comments, posts_likes, post_reactions,
  // post_saves, post_shares, post_edits, post_hides, pulse_geo_tags, …
  const postsOk = await step(steps, "delete_posts", async () => {
    must(await sc.from("posts").delete().eq("author_id", userId), "delete posts");
  });
  if (!postsOk) warnings.push("posts may remain");

  // messages CASCADEs to message_translations (decrypted/translated copies)
  // and saved_messages. This is the "message ciphertext" the policy promises
  // to remove.
  const msgOk = await step(steps, "delete_messages", async () => {
    must(await sc.from("messages").delete().eq("sender_id", userId), "delete messages");
  });
  if (!msgOk) warnings.push("message ciphertext may remain");

  // Verification rows: provider reference, over-18 flag, document country.
  const verOk = await step(steps, "delete_identity_verifications", async () => {
    must(
      await sc.from("identity_verifications").delete().eq("user_id", userId),
      "delete identity_verifications",
    );
  });
  if (!verOk) warnings.push("identity verification rows may remain");

  // media_assets has no cascade from profiles — delete explicitly.
  const maOk = await step(steps, "delete_media_assets", async () => {
    must(
      await sc.from("media_assets").delete().or(`owner_user_id.eq.${userId},uploader_user_id.eq.${userId}`),
      "delete media_assets",
    );
  });
  if (!maOk) warnings.push("media_assets rows may remain");

  // ── 3b. Content the posts/messages cascades do not reach ──────────────────
  // Because the profile row survives as a tombstone, none of the FK cascades
  // hanging off profiles(id) ever fire — every one of these tables has to be
  // cleared by hand (merged from the old services/accountDeletion.ts cascade).
  // One failing table records its own step and never aborts the rest.
  const contentDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
    // Stories + engagement the user left on OTHER users' stories.
    { name: "delete_story_reactions", run: () => sc.from("story_reactions").delete().eq("user_id", userId) },
    { name: "delete_story_replies",   run: () => sc.from("story_replies").delete().eq("user_id", userId) },
    { name: "delete_story_views",     run: () => sc.from("story_views").delete().eq("viewer_id", userId) },
    { name: "delete_stories",         run: () => sc.from("stories").delete().eq("owner_id", userId) },
    // The user's own interactions on other users' posts (deleting the user's
    // posts above only cascades children OF those posts, not these rows).
    { name: "delete_post_reactions",  run: () => sc.from("post_reactions").delete().eq("user_id", userId) },
    { name: "delete_posts_comments",  run: () => sc.from("posts_comments").delete().eq("user_id", userId) },
    { name: "delete_post_shares",     run: () => sc.from("post_shares").delete().eq("user_id", userId) },
    { name: "delete_post_saves",      run: () => sc.from("post_saves").delete().eq("user_id", userId) },
    { name: "delete_posts_likes",     run: () => sc.from("posts_likes").delete().eq("user_id", userId) },
    { name: "delete_comment_likes",   run: () => sc.from("comment_likes").delete().eq("user_id", userId) },
    // Reviews authored by the user.
    { name: "delete_reviews",         run: () => sc.from("reviews").delete().eq("reviewer_id", userId) },
    // Hidden gems: saves first (FK), then authored submissions.
    { name: "delete_hidden_gem_saves", run: () => sc.from("hidden_gem_saves").delete().eq("user_id", userId) },
    { name: "delete_hidden_gems",      run: () => sc.from("hidden_gems").delete().eq("submitted_by", userId) },
    // Saved items across the various save surfaces.
    { name: "delete_saved_places",    run: () => sc.from("saved_places").delete().eq("user_id", userId) },
    { name: "delete_user_saves",      run: () => sc.from("user_saves").delete().eq("saver_id", userId) },
    { name: "delete_wishlist_places", run: () => sc.from("wishlist_places").delete().eq("user_id", userId) },
    { name: "delete_event_saves",     run: () => sc.from("event_saves").delete().eq("user_id", userId) },
    // Follow graph, both directions.
    { name: "delete_follows_outgoing", run: () => sc.from("user_follows").delete().eq("follower_id", userId) },
    { name: "delete_follows_incoming", run: () => sc.from("user_follows").delete().eq("following_id", userId) },
  ];
  for (const d of contentDeletes) {
    const ok = await step(steps, d.name, async () => {
      must(await d.run(), d.name);
    });
    if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
  }

  // ── 3c. Journey / location tables ────────────────────────────────────────
  // Delete observations before their sessions. service_role no longer has direct
  // DELETE on journey_observations (SELECT/INSERT/DELETE all revoked), so raw
  // observations are erased via the SECURITY DEFINER RPC. In the full-deletion
  // path revoke_journey_consent_and_delete_segments already erased them, so this
  // RPC is idempotent (deletes zero). In the contentOnly path this RPC is the
  // ONLY thing that erases raw observations.
  // Preferences/session deletion can fire Journey revocation triggers, so delete
  // journey_revocation_jobs LAST to leave no trigger-created account orphan.
  // journey_retention_health is an operator singleton with no user_id column —
  // skip per-account deletion. trip_crew_location_events before
  // trip_crew_location_sessions and trip_crew_location_preferences (events FK sessions).
  const journeyLocationDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
    { name: "delete_journey_observations",          run: () => sc.rpc("delete_journey_observations_for_user_v1", { p_user_id: userId }) },
    { name: "delete_user_location_preferences",     run: () => sc.from("user_location_preferences").delete().eq("user_id", userId) },
    { name: "delete_location_sessions",             run: () => sc.from("location_sessions").delete().eq("user_id", userId) },
    { name: "delete_user_location_state",           run: () => sc.from("user_location_state").delete().eq("user_id", userId) },
    { name: "delete_location_snapshots",            run: () => sc.from("location_snapshots").delete().eq("user_id", userId) },
    { name: "delete_location_trust_events",         run: () => sc.from("location_trust_events").delete().eq("user_id", userId) },
    { name: "delete_trip_crew_location_events",     run: () => sc.from("trip_crew_location_events").delete().eq("user_id", userId) },
    { name: "delete_trip_crew_location_sessions",   run: () => sc.from("trip_crew_location_sessions").delete().eq("user_id", userId) },
    { name: "delete_trip_crew_location_preferences", run: () => sc.from("trip_crew_location_preferences").delete().eq("user_id", userId) },
  ];
  let journeyLocationOk = await step(
    steps,
    opts.contentOnly
      ? "delete_journey_segment_revisions"
      : "revoke_journey_consent_and_delete_segments",
    async () => opts.contentOnly
      ? deleteJourneySegmentsForUser(sc, userId)
      : revokeJourneyConsentAndDeleteSegments(sc, userId, {
          location_mode: "off",
          sharing_paused: true,
        }),
  );
  if (!journeyLocationOk) {
    warnings.push(
      opts.contentOnly
        ? "journey segment revisions may remain"
        : "journey consent may remain active or segment revisions may remain",
    );
  }
  for (const d of journeyLocationDeletes) {
    const ok = await step(steps, d.name, async () => {
      must(await d.run(), d.name);
    });
    if (!ok) {
      journeyLocationOk = false;
      warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
    }
  }
  if (journeyLocationOk) {
    journeyLocationOk = await step(steps, "delete_journey_revocation_jobs", async () => {
      must(
        await sc.from("journey_revocation_jobs").delete().eq("user_id", userId),
        "delete_journey_revocation_jobs",
      );
    });
    if (!journeyLocationOk) warnings.push("journey_revocation_jobs rows may remain");
  } else {
    warnings.push("journey_revocation_jobs retained so restricted-data deletion remains retryable");
  }

  // Devices + E2EE key packages. key_packages FKs devices via device_id, so
  // collect device ids and clear key_packages FIRST, then the devices rows.
  const kpOk = await step(steps, "delete_key_packages", async () => {
    const { data, error } = await sc.from("devices").select("id").eq("user_id", userId).limit(5000);
    if (error) throw new Error(`collect device ids: ${error.message ?? error}`);
    const deviceIds = ((data ?? []) as any[]).map((r) => r?.id).filter(Boolean);
    if (deviceIds.length === 0) return 0;
    must(await sc.from("key_packages").delete().in("device_id", deviceIds), "delete key_packages");
    return deviceIds.length;
  });
  if (!kpOk) warnings.push("key_packages rows may remain");
  const devOk = await step(steps, "delete_devices", async () => {
    must(await sc.from("devices").delete().eq("user_id", userId), "delete devices");
  });
  if (!devOk) warnings.push("devices rows may remain");

  // Notifications received AND ones naming the user as actor, plus push
  // registration rows; then search history.
  const tailDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
    { name: "delete_notifications_user",  run: () => sc.from("notifications").delete().eq("user_id", userId) },
    { name: "delete_notifications_actor", run: () => sc.from("notifications").delete().eq("actor_id", userId) },
    { name: "delete_notification_devices", run: () => sc.from("notification_devices").delete().eq("user_id", userId) },
    { name: "delete_search_history",      run: () => sc.from("search_history").delete().eq("user_id", userId) },
  ];
  for (const d of tailDeletes) {
    const ok = await step(steps, d.name, async () => {
      must(await d.run(), d.name);
    });
    if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
  }

  if (opts.contentOnly) {
    return { ok: steps.every((s) => s.ok), userId, executedAt, steps, warnings };
  }

  if (!journeyLocationOk) {
    logger.error(
      { userId, failedSteps: steps.filter((s) => !s.ok).map((s) => s.step) },
      "executeAccountDeletion: Journey/location cleanup incomplete — leaving request retryable",
    );
    await step(steps, "expire_deletion_claim", async () => {
      await expireDestructiveClaim(sc, userId, claim!);
    });
    return { ok: false, userId, executedAt, steps, warnings };
  }

  // ── 4. Anonymise the tombstone profile (FATAL on failure) ─────────────────
  const profileOk = await step(steps, "anonymise_profile", async () => {
    await anonymiseProfileTombstone(sc, userId);
  });

  if (!profileOk) {
    logger.error({ userId, steps }, "executeAccountDeletion: profile anonymisation failed — aborting");
    await step(steps, "expire_deletion_claim", async () => {
      await expireDestructiveClaim(sc, userId, claim!);
    });
    return { ok: false, userId, executedAt, steps, warnings };
  }

  // ── 5. Remove the auth user (this is what finally drops the email) ────────
  // Migration 2121 removes the Auth cascade, so the tombstone survives this.
  const authOk = await step(steps, "auth_delete_user", async () => {
    const res = await sc.auth.admin.deleteUser(userId);
    if (res?.error && !isAuthUserAlreadyAbsent(res.error)) {
      throw new Error(res.error.message ?? String(res.error));
    }
  });
  if (!authOk) {
    // Loud AND fatal: the email address is still on file, which is the exact
    // GDPR claim the policy makes. The request is NOT marked executed below;
    // its non-cancellable claim is expired so a worker can safely reclaim it.
    warnings.push("auth user not deleted — email address still on file");
    logger.error(
      { userId },
      "executeAccountDeletion: auth.admin.deleteUser failed; email retained — leaving request retryable",
    );
  }

  // ── 6. Bookkeeping ────────────────────────────────────────────────────────
  await step(steps, "mark_account_state", async () => {
    must(
      await sc.from("user_account_states").upsert(
        {
          user_id: userId,
          state: "deleted",
          reason: opts.reason ?? "Account deletion executed",
          set_by: opts.actorId,
          created_at: executedAt,
        },
        { onConflict: "user_id,state" },
      ),
      "user_account_states upsert",
    );
  });

  // Only mark the request executed when the auth user is actually gone —
  // an "executed" request is never re-selected, so marking it while the
  // email survives would strand personal data forever.
  let markedOk = false;
  if (authOk) {
    markedOk = await step(steps, "mark_request_executed", async () => {
      const res = await sc
        .from("user_deletion_requests")
        .update({
          status: "executed",
          executed_at: executedAt,
          execution_token: null,
          execution_lease_expires_at: null,
        })
        .eq("user_id", userId)
        .eq("status", "executing")
        .eq("execution_token", claim!.token)
        .select("user_id, status, executed_at")
        .maybeSingle();
      must(res, "mark request executed");
      const row = res?.data as any;
      if (!row) throw new Error("mark request executed: no request row matched");
      if (row.user_id !== userId || row.status !== "executed") {
        throw new Error("mark request executed: verification failed");
      }
    });
  }

  // Profile visibility just changed — drop any cached Compass Home payload so
  // the deleted account never serves stale personalised content. Lazy import
  // keeps the compass module graph out of this service's import chain.
  try {
    const { invalidateCompassHomeCache } = await import("../../routes/compassHome.js");
    invalidateCompassHomeCache(userId);
  } catch { /* cache invalidation is best-effort */ }

  const ok = profileOk && authOk && markedOk;
  if (!ok) {
    await step(steps, "expire_deletion_claim", async () => {
      await expireDestructiveClaim(sc, userId, claim!);
    });
  }
  logger.info(
    { userId, ok, warnings, failedSteps: steps.filter((s) => !s.ok).map((s) => s.step) },
    "executeAccountDeletion: finished",
  );

  return { ok, userId, executedAt, steps, warnings };
}
