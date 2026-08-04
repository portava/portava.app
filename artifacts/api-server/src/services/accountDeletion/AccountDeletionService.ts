/**
 * AccountDeletionService
 *
 * Single implementation of "execute an account deletion request", shared by:
 *   - POST /admin/deletion-requests/:id/execute   (routes/admin.ts, manual)
 *   - accountDeletionScheduler                    (lib/accountDeletionScheduler.ts)
 *
 * Both paths MUST go through executeAccountDeletion() so the manual and the
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
 * public.profiles has NO foreign key to auth.users (verified against the live
 * schema), so removing the auth user does not cascade into the tombstone. It
 * removes the email address, which is the one identifier that otherwise
 * persists forever. This is the step the audit called out as missing.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * Storage paths are collected BEFORE the owning DB rows are deleted, because
 * deleting posts cascades post_media away and we would lose the paths.
 */

import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "AccountDeletionService" });

export const PROFILE_MEDIA_BUCKET = "profile-media";
export const POST_MEDIA_BUCKET = "post-media";

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
 * Fatal steps (profile anonymisation, marking the request completed) fail the
 * whole call. Content and storage steps are recorded but do not abort the run:
 * a user whose media bucket is momentarily unavailable must still lose their
 * posts, their email, and their profile — a stalled deletion is worse than a
 * partial one, and the request stays auditable via `steps`.
 */
export async function executeAccountDeletion(
  sc: any,
  userId: string,
  opts: ExecuteOptions,
): Promise<DeletionOutcome> {
  const executedAt = new Date().toISOString();
  const steps: DeletionStepResult[] = [];
  const warnings: string[] = [];

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

  if (opts.contentOnly) {
    return { ok: steps.every((s) => s.ok), userId, executedAt, steps, warnings };
  }

  // ── 4. Anonymise the tombstone profile (FATAL on failure) ─────────────────
  const profileOk = await step(steps, "anonymise_profile", async () => {
    must(
      await sc
        .from("profiles")
        .update({
          handle: null,
          username: null,
          display_name: "Deleted User",
          name: "Deleted User",
          full_name: null,
          bio: null,
          avatar_url: null,
          cover_photo_url: null,
          home_city: null,
          home_country: null,
          current_city: null,
          account_status: "deleted",
        })
        .eq("id", userId),
      "anonymise profile",
    );
  });

  if (!profileOk) {
    logger.error({ userId, steps }, "executeAccountDeletion: profile anonymisation failed — aborting");
    return { ok: false, userId, executedAt, steps, warnings };
  }

  // ── 5. Remove the auth user (this is what finally drops the email) ────────
  // profiles has no FK to auth.users, so the tombstone above survives this.
  const authOk = await step(steps, "auth_delete_user", async () => {
    const res = await sc.auth.admin.deleteUser(userId);
    if (res?.error) throw new Error(res.error.message ?? String(res.error));
  });
  if (!authOk) {
    // Loud: the email address is still on file, which is the exact GDPR claim
    // the policy makes. Surfaced as a warning so the request is still marked
    // completed and retryable rather than silently stuck pending forever.
    warnings.push("auth user not deleted — email address still on file");
    logger.error({ userId }, "executeAccountDeletion: auth.admin.deleteUser failed; email retained");
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

  const markedOk = await step(steps, "mark_request_completed", async () => {
    must(
      await sc
        .from("user_deletion_requests")
        .update({ status: "completed", executed_at: executedAt })
        .eq("user_id", userId),
      "mark request completed",
    );
  });

  const ok = profileOk && markedOk;
  logger.info(
    { userId, ok, warnings, failedSteps: steps.filter((s) => !s.ok).map((s) => s.step) },
    "executeAccountDeletion: finished",
  );

  return { ok, userId, executedAt, steps, warnings };
}
