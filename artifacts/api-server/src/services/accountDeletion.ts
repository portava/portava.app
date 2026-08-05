/**
 * accountDeletion — full account deletion cascade (store-compliance requirement).
 *
 * Deletes all user-generated content rows, the user's storage objects
 * (avatar / cover), anonymises the profile row, and finally removes the
 * Supabase Auth user via the admin API.
 *
 * Every table is cleared inside its own try/catch so one failing table never
 * aborts the rest of the cascade — failures are collected per-table in the
 * returned summary instead.
 *
 * Callers:
 *   - routes/admin.ts     POST /admin/deletion-requests/:id/execute (manual)
 *   - routes/profile.ts   POST /internal/deletion-requests/execute-due (worker)
 *
 * SCHEDULING — the worker endpoint must be invoked once a day:
 *   Set up a Replit Scheduled Deployment (or any external cron) that runs
 *   daily, e.g.:
 *     curl -X POST "$API_BASE_URL/api/internal/deletion-requests/execute-due" \
 *          -H "X-Internal-Secret: $INTERNAL_API_SECRET"
 *   The endpoint is idempotent and caps each run at 20 requests, so a daily
 *   schedule drains the queue safely. It fails closed (503) when
 *   INTERNAL_API_SECRET is unset.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../lib/supabase";
import { invalidateCompassHomeCache } from "../routes/compassHome.js";

const PROFILE_MEDIA_BUCKET = "profile-media";

export interface AccountDeletionSummary {
  userId: string;
  /** Tables (or pseudo-steps like "storage:profile-media", "auth:user") cleared without error. */
  tablesCleared: string[];
  errors: { table: string; message: string }[];
}

type Sc = SupabaseClient | any;

/** Run one delete step; record success or failure in the summary. */
async function step(
  summary: AccountDeletionSummary,
  table: string,
  fn: () => PromiseLike<{ error: { message?: string } | null } | void>,
): Promise<void> {
  try {
    const result = await fn();
    const error = (result as any)?.error ?? null;
    if (error) {
      summary.errors.push({ table, message: error.message ?? String(error) });
    } else {
      summary.tablesCleared.push(table);
    }
  } catch (err: any) {
    summary.errors.push({ table, message: err?.message ?? String(err) });
  }
}

/** Collect all ids for `column = userId` on `table` (paged, capped at 50k rows). */
async function collectIds(sc: Sc, table: string, column: string, userId: string): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await sc
      .from(table)
      .select("id")
      .eq(column, userId)
      .range(i * PAGE, i * PAGE + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as any[]) if (row?.id) ids.push(row.id);
    if (data.length < PAGE) break;
  }
  return ids;
}

/**
 * Execute the full deletion cascade for one user.
 *
 * @param userId  The auth/profile UUID to delete.
 * @param client  Optional Supabase client (tests / admin routes inject theirs);
 *                defaults to the service-role client.
 */
export async function executeAccountDeletion(
  userId: string,
  client?: Sc,
): Promise<AccountDeletionSummary> {
  const sc: Sc = client ?? getServiceClient();
  const summary: AccountDeletionSummary = { userId, tablesCleared: [], errors: [] };

  if (!sc) {
    summary.errors.push({ table: "*", message: "service client unavailable" });
    return summary;
  }

  // ── 1. Posts + their child rows ─────────────────────────────────────────────
  // Delete children of the user's posts first (reactions/comments/shares/saves/
  // media left by OTHER users on this user's posts), then the posts themselves.
  let postIds: string[] = [];
  try {
    postIds = await collectIds(sc, "posts", "author_id", userId);
  } catch { /* posts table lookup failed — child deletes by post_id are skipped */ }

  if (postIds.length > 0) {
    for (const child of ["post_reactions", "posts_comments", "post_shares", "post_saves", "posts_likes", "post_media"]) {
      await step(summary, `${child}(post_id)`, () => sc.from(child).delete().in("post_id", postIds));
    }
  }
  // The user's own interactions on other users' content.
  for (const t of ["post_reactions", "posts_comments", "post_shares", "post_saves", "posts_likes", "comment_likes"]) {
    await step(summary, t, () => sc.from(t).delete().eq("user_id", userId));
  }
  await step(summary, "posts", () => sc.from("posts").delete().eq("author_id", userId));

  // ── 2. Stories ──────────────────────────────────────────────────────────────
  await step(summary, "story_reactions", () => sc.from("story_reactions").delete().eq("user_id", userId));
  await step(summary, "story_replies",   () => sc.from("story_replies").delete().eq("user_id", userId));
  await step(summary, "story_views",     () => sc.from("story_views").delete().eq("viewer_id", userId));
  await step(summary, "stories",         () => sc.from("stories").delete().eq("owner_id", userId));

  // ── 3. Reviews ──────────────────────────────────────────────────────────────
  await step(summary, "reviews", () => sc.from("reviews").delete().eq("reviewer_id", userId));

  // ── 4. Hidden gems (authored submissions + saves) ───────────────────────────
  await step(summary, "hidden_gem_saves", () => sc.from("hidden_gem_saves").delete().eq("user_id", userId));
  await step(summary, "hidden_gems",      () => sc.from("hidden_gems").delete().eq("submitted_by", userId));

  // ── 5. Saved items ──────────────────────────────────────────────────────────
  await step(summary, "saved_places",    () => sc.from("saved_places").delete().eq("user_id", userId));
  await step(summary, "user_saves",      () => sc.from("user_saves").delete().eq("saver_id", userId));
  await step(summary, "wishlist_places", () => sc.from("wishlist_places").delete().eq("user_id", userId));
  await step(summary, "event_saves",     () => sc.from("event_saves").delete().eq("user_id", userId));

  // ── 6. Follows (both directions) ────────────────────────────────────────────
  await step(summary, "user_follows(follower)",  () => sc.from("user_follows").delete().eq("follower_id", userId));
  await step(summary, "user_follows(following)", () => sc.from("user_follows").delete().eq("following_id", userId));

  // ── 7. Devices + E2EE key packages (key_packages FK's devices via device_id) ─
  try {
    const deviceIds = await collectIds(sc, "devices", "user_id", userId);
    if (deviceIds.length > 0) {
      await step(summary, "key_packages", () => sc.from("key_packages").delete().in("device_id", deviceIds));
    }
  } catch (err: any) {
    summary.errors.push({ table: "key_packages", message: err?.message ?? String(err) });
  }
  await step(summary, "devices", () => sc.from("devices").delete().eq("user_id", userId));

  // ── 8. Notifications (received + ones naming the user as actor) ─────────────
  await step(summary, "notifications(user)",  () => sc.from("notifications").delete().eq("user_id", userId));
  await step(summary, "notifications(actor)", () => sc.from("notifications").delete().eq("actor_id", userId));
  await step(summary, "notification_devices", () => sc.from("notification_devices").delete().eq("user_id", userId));

  // ── 9. Search history ───────────────────────────────────────────────────────
  await step(summary, "search_history", () => sc.from("search_history").delete().eq("user_id", userId));

  // ── 10. Storage objects (avatar / cover) — same approach as admin execute ───
  try {
    const { data: profileRow } = await sc
      .from("profiles")
      .select("avatar_url, cover_photo_url")
      .eq("id", userId)
      .maybeSingle();
    const avatarUrl: string | null = (profileRow as any)?.avatar_url ?? null;
    const coverUrl:  string | null = (profileRow as any)?.cover_photo_url ?? null;
    const pathsToDelete: string[] = [];
    for (const url of [avatarUrl, coverUrl]) {
      if (!url) continue;
      const marker = `/object/public/${PROFILE_MEDIA_BUCKET}/`;
      const idx = url.indexOf(marker);
      if (idx !== -1) pathsToDelete.push(url.slice(idx + marker.length));
    }
    if (pathsToDelete.length > 0) {
      await sc.storage.from(PROFILE_MEDIA_BUCKET).remove(pathsToDelete);
    }
    summary.tablesCleared.push(`storage:${PROFILE_MEDIA_BUCKET}`);
  } catch (err: any) {
    // best-effort: storage deletion failure must not abort the cascade
    summary.errors.push({ table: `storage:${PROFILE_MEDIA_BUCKET}`, message: err?.message ?? String(err) });
  }

  // ── 11. Anonymise profile row (same fields as the admin execute path) ───────
  await step(summary, "profiles(anonymised)", () => sc.from("profiles").update({
    handle:          null,
    username:        null,
    display_name:    "Deleted User",
    name:            "Deleted User",
    bio:             null,
    avatar_url:      null,
    cover_photo_url: null,
    home_city:       null,
    home_country:    null,
    current_city:    null,
    account_status:  "deleted",
  }).eq("id", userId));

  // Profile visibility changed — drop any cached Compass Home payload so the
  // deleted account never serves stale personalised content.
  try { invalidateCompassHomeCache(userId); } catch { /* cache invalidation is best-effort */ }

  // ── 12. Supabase Auth user (admin API) — last, so a failure leaves ──────────
  //        the anonymised row queryable and the request retryable.
  try {
    if (sc.auth?.admin?.deleteUser) {
      const { error } = await sc.auth.admin.deleteUser(userId);
      if (error) {
        summary.errors.push({ table: "auth:user", message: error.message ?? String(error) });
      } else {
        summary.tablesCleared.push("auth:user");
      }
    } else {
      summary.errors.push({ table: "auth:user", message: "auth.admin.deleteUser unavailable on client" });
    }
  } catch (err: any) {
    summary.errors.push({ table: "auth:user", message: err?.message ?? String(err) });
  }

  return summary;
}
