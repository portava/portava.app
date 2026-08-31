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
 * public.profiles has NO foreign key to auth.users (verified against the live
 * schema), so removing the auth user does not cascade into the tombstone. It
 * removes the email address, which is the one identifier that otherwise
 * persists forever. This is the step the audit called out as missing.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * Storage paths are collected BEFORE the owning DB rows are deleted, because
 * deleting posts cascades post_media away and we would lose the paths. The same
 * rule is what puts `collect_intel_evidence_paths` in section 1 rather than next
 * to the intel steps in section 3: erase_intel_for_actor deletes the evidence
 * rows, and their `reference` is the only record of where the bytes live.
 *
 * ── The gap this class of bug lives in ──────────────────────────────────────
 * `check:deletion-coverage` asks whether every user-keyed TABLE has a stated
 * fate. Nothing asks whether every stored OBJECT does. A table can be fully
 * erased — row-complete, guard green — while the bytes its rows pointed at stay
 * in the bucket, which is exactly how intel_evidence's media survived. Any new
 * table holding a storage reference must therefore be added to section 1 by
 * hand; being ERASED_BY_CASCADE says nothing about its objects.
 *
 * ── Every storage-bearing column this service knows about ───────────────────
 * The inventory, so the next person does not have to rediscover it:
 *
 *   COLLECTED (section 1), row-deleting step named alongside:
 *     post_media.storage_path / thumbnail_storage_path / feed_storage_path
 *     media_assets.storage_path / thumbnail_path        → delete_media_assets
 *     profiles.avatar_url / cover_photo_url             → anonymise_profile
 *     memory_items.media_url                            → delete_memory_items
 *     intel_evidence.reference                          → erase_intel_contributions
 *     stories.media_url                                 → delete_stories
 *     messages.media_url / media_thumbnail_url          → delete_messages
 *     hidden_gems.image_url                             → delete_hidden_gems
 *     reviews.photos (text[])                           → delete_reviews
 *
 *   NOT COLLECTED, deliberately:
 *     passport_memories.photo_url — the ROWS are not deleted either. The table
 *     sits in deletionDispositions' UNCLASSIFIED_BACKLOG, which is explicitly
 *     "NOT a decision" and carries no D6 classification, so nothing here has
 *     been authorised to erase it. Deleting the bytes under a row that survives
 *     would manufacture a broken record and pre-empt a ruling nobody has made;
 *     the row's survival is the larger defect and is the thing to fix first.
 *     When it is classified ERASE, add the row delete AND this collection in the
 *     same change — either alone leaves the account half-erased.
 *     highlights.media_url is the same shape: also UNCLASSIFIED_BACKLOG, also
 *     never row-deleted here. Note that a story SAVED to a highlight has its
 *     bytes collected below (delete_stories takes every story regardless of
 *     state), so the surviving highlight row will point at removed bytes until
 *     highlights gets its own fate. That is the backlog entry showing through,
 *     not a regression: erasing a departing user's uploads is the promise, and
 *     retaining their story media to keep a row that should not exist would
 *     invert it.
 *
 * ── The four client-supplied columns need guards the server-written ones do not
 * intel_evidence.reference is written by lib/intelEvidenceCapture, which has
 * ALREADY proven the object is ours and theirs. The four added here have not:
 *   * stories.media_url    — POST /stories checks appStorageUrlInfo AND
 *                            ownerFromPath === user.id (routes/stories.ts).
 *   * messages.media_url / media_thumbnail_url — POST /threads/:id/media checks
 *                            appStorageUrlInfo only; NO ownership check, so a
 *                            sender can legitimately store another user's key.
 *   * hidden_gems.image_url — `z.string().url()`, nothing more.
 *   * reviews.photos        — `z.array(z.string().url())`, nothing more.
 * A value in any of them may be a foreign URL, a data URI, someone else's key
 * or junk. So collection RESOLVES rather than trusts: a reference that does not
 * land in an allow-listed bucket is skipped (it is somebody else's URL and we
 * have no business issuing a delete for it), and one whose path names a
 * different owner is refused. On a DELETE path "should only ever hold their own
 * media" is not a guarantee, and a mismatched remove() destroys a third party's
 * file — a worse outcome than the orphan being fixed.
 */

import { logger as rootLogger } from "../../lib/logger.js";
import { resolveStoragePath } from "../../lib/storagePath.js";
import { ownerFromPath } from "../../lib/mediaAccess.js";

const logger = rootLogger.child({ service: "AccountDeletionService" });

export const PROFILE_MEDIA_BUCKET = "profile-media";
export const POST_MEDIA_BUCKET = "post-media";

/**
 * The buckets a stored `<bucket>/<path>` reference is allowed to name.
 *
 * Mirrors `lib/mediaUrl`'s ALLOWED_BUCKETS, which is the allow-list every write
 * path validates against before a reference is ever persisted. Kept as an
 * explicit list here because this is a DELETE path: a reference that names
 * anything else is skipped, never coerced onto a default bucket, so a malformed
 * or foreign row can never turn into a remove() against a bucket nobody meant.
 */
const REFERENCE_BUCKETS: readonly string[] = [POST_MEDIA_BUCKET, PROFILE_MEDIA_BUCKET];

/**
 * Stamped onto every completed deletion receipt (owner ruling 3, 2026-08-23).
 *
 * A receipt that does not say which rules it ran under cannot be read later: the
 * counts alone do not tell you whether a post was kept because the doctrine said
 * to, or because the worker of the day had a bug. Bump the worker version when
 * the STEPS change; bump the policy version when the RULES do.
 */
export const DELETION_POLICY_VERSION = "d6-2026-08-23";
export const DELETION_WORKER_VERSION = "2026-08-31.2";

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
  /**
   * Per-domain counts, mirrored onto the deletion receipt. Two separate maps
   * because "we removed 12 things" and "we kept 12 things without your name on
   * them" are different promises, and a single total would blur them.
   */
  deletedCounts: Record<string, number>;
  tombstonedCounts: Record<string, number>;
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

/**
 * Resolve ONE stored media reference and, only if it is provably this user's
 * object in one of our buckets, add it to the removal set. Returns whether it
 * was collected, so a step can report a count.
 *
 * This is the single guard every storage-reference collector routes through —
 * one implementation rather than six copies that can drift apart. Each check is
 * load-bearing on a DELETE path:
 *
 *   * resolveStoragePath is the repo's ONE reference parser. It understands
 *     `<bucket>/<path>` as well as the public / sign / authenticated URL forms,
 *     and returns a non-"path" kind for anything that is not in the bucket
 *     asked about — which is what makes trying each allowed bucket in turn safe
 *     rather than a way to cross-match one bucket's key onto another's remove().
 *   * A reference naming no allowed bucket (an external host, a data URI, a
 *     foreign object store, junk) resolves to "external"/"unresolvable"/"none"
 *     for every bucket and is SKIPPED. Skipping is the correct outcome, not a
 *     miss: those bytes are not ours to delete.
 *   * `..` and an owner mismatch RETURN rather than continue to the next bucket:
 *     the reference matched this bucket and was refused. Falling through would
 *     let a refused reference get a second chance under a different bucket.
 *   * ownerFromPath must equal the user being erased even for columns that
 *     "should" only hold their own media. messages.media_url provably does not
 *     — its write path validates the bucket and not the owner — and on this
 *     path a wrong answer deletes a third party's file.
 */
function collectOwnedReference(
  raw: unknown,
  userId: string,
  targets: Array<{ bucket: string; path: string }>,
): boolean {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return false;
  for (const bucket of REFERENCE_BUCKETS) {
    const ref = resolveStoragePath(value, bucket);
    if (ref.kind !== "path") continue;
    if (ref.path.includes("..")) return false;
    if (ownerFromPath(ref.path) !== userId) return false;
    targets.push({ bucket, path: ref.path });
    return true;
  }
  return false;
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
 * Fatal steps (profile anonymisation, auth-user deletion, marking the request
 * completed) fail the whole call, leaving the request pending so callers retry.
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

  // ── 1. Collect storage paths BEFORE the rows that hold them are deleted ────
  const storageTargets: Array<{ bucket: string; path: string }> = [];

  const pmPathsOk = await step(steps, "collect_post_media_paths", async () => {
    const { data, error } = await sc
      .from("post_media")
      .select("storage_bucket, storage_path, thumbnail_storage_path, feed_storage_path")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as any[]) {
      const bucket = (row.storage_bucket as string) || POST_MEDIA_BUCKET;
      if (row.storage_path) storageTargets.push({ bucket, path: row.storage_path });
      if (row.thumbnail_storage_path) storageTargets.push({ bucket, path: row.thumbnail_storage_path });
      // feed_storage_path is the 0208 1500px derivative — a THIRD object per
      // upload, written by POST /media/upload alongside the original and the
      // thumbnail. It was never collected here, so every feed variant a user
      // ever generated survived their deletion in the private post-media
      // bucket. Same table, same row, same query: one more column.
      if (row.feed_storage_path) storageTargets.push({ bucket, path: row.feed_storage_path });
    }
    return (data ?? []).length;
  });
  if (!pmPathsOk) warnings.push("post media objects may remain in storage — their paths could not be read");

  const maPathsOk = await step(steps, "collect_media_asset_paths", async () => {
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
  if (!maPathsOk) warnings.push("media_assets objects may remain in storage — their paths could not be read");

  const pfPathsOk = await step(steps, "collect_profile_media_paths", async () => {
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
  if (!pfPathsOk) warnings.push("profile media objects may remain in storage — their paths could not be read");

  // ── Memory UGC media (audit MEM·H2) ───────────────────────────────────────
  // Trip "Memories" and their photos/videos were entirely untouched by the
  // cascade: DELETE /memories/:id is a soft-delete (state='deleted', the rows
  // and their memory_items survive), and no step here ever read them. The media
  // lives in the post-media bucket at memories/{userId}/… and stayed PUBLICLY
  // served under the "Deleted User" tombstone. Collect the owner's memory ids
  // now — reused below to delete the rows — and the storage paths of their
  // items, BEFORE section 3 deletes them. No state filter: soft-deleted
  // memories still hold media, so they must be swept too.
  const memoryIds: string[] = [];
  const memPathsOk = await step(steps, "collect_memory_media_paths", async () => {
    const { data: mems, error } = await sc
      .from("memories")
      .select("id")
      .eq("owner_id", userId);
    if (error) throw new Error(error.message);
    for (const m of (mems ?? []) as any[]) {
      if (m?.id) memoryIds.push(m.id as string);
    }
    if (memoryIds.length === 0) return 0;

    const { data: items, error: itemErr } = await sc
      .from("memory_items")
      .select("media_url")
      .in("memory_id", memoryIds);
    if (itemErr) throw new Error(itemErr.message);
    let found = 0;
    for (const it of (items ?? []) as any[]) {
      const path = storagePathFromPublicUrl(it?.media_url, POST_MEDIA_BUCKET);
      // media_url is client-supplied at insert time (addItemSchema only checks
      // it is a URL), so an owner could point an item at another user's object.
      // Removing only paths under this user's own memories/{userId}/ prefix means
      // account deletion can never be weaponised to delete someone else's media —
      // the exact guard DELETE /memories/:id/items already enforces.
      if (path && path.startsWith(`memories/${userId}/`)) {
        storageTargets.push({ bucket: POST_MEDIA_BUCKET, path });
        found += 1;
      }
    }
    return found;
  });
  if (!memPathsOk) warnings.push("memory media objects may remain in storage — their paths could not be read");

  // ── IG-02 evidence media (map contributions) ──────────────────────────────
  // intel_evidence.reference holds a `<bucket>/<path>` STORAGE KEY for a photo
  // or video a contributor attached to an observation (lib/intelEvidenceCapture).
  // The ROWS were already erased — intel_evidence is in ERASED_BY_CASCADE and
  // erase_intel_for_actor deletes the actor's rows — so check:deletion-coverage
  // was green. The BYTES were not, and nothing checked them:
  //
  //   * POST /api/media/upload writes NO post_media row (the client persists
  //     that later, when a post is created), so an object referenced only by
  //     evidence is invisible to collect_post_media_paths;
  //   * its media_assets row is written by recordMediaAsset only when the
  //     `media_canonical_enabled` flag is on, and that flag ships OFF
  //     (migration 0191), so collect_media_asset_paths does not see it either.
  //
  // The object therefore survived in the private post-media bucket. It was
  // unreachable in practice (the uid no longer authenticates and mediaAccess
  // denies orphans) — but unreachable is not deleted when a user has asked to
  // be erased.
  //
  // ORDERING IS LOAD-BEARING. This must run here, in section 1, and not beside
  // the intel steps in section 3: `erase_intel_contributions` calls
  // erase_intel_for_actor, which deletes these very rows. Read them after that
  // and there is nothing left to read, and the bytes would be orphaned for good.
  const evPathsOk = await step(steps, "collect_intel_evidence_paths", async () => {
    const { data, error } = await sc
      .from("intel_evidence")
      .select("reference")
      .eq("actor_id", userId);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of (data ?? []) as any[]) {
      // NULL by design for 'text_note' and 'sensor' evidence — those reference
      // no stored object at all, so skipping is correct, not a miss. Defence in
      // depth: the producer validated bucket + owner on write
      // (appStorageUrlInfo + ownerFromPath), but a row is not a promise, so the
      // shared guard re-checks both here.
      if (collectOwnedReference(row?.reference, userId, storageTargets)) found += 1;
    }
    return found;
  });
  if (!evPathsOk) warnings.push("intel evidence media objects may remain in storage — their references could not be read");

  // ── Story media ───────────────────────────────────────────────────────────
  // stories.media_url is the photo/video of a 24h story. `delete_stories` (in
  // section 3b) removes the ROWS by owner_id with no state filter, so every
  // story — active, expired and saved-to-highlight — goes; nothing else records
  // where those bytes live, and the objects survived the account deletion.
  //
  // sweepExpiredStories (routes/stories.ts) already deletes story bytes on
  // EXPIRY, but only for stories with saved_to_highlight_id IS NULL, and only
  // for the ones that expire while the account exists. Neither restriction
  // applies to an erasure request: the account and all its content are going.
  //
  // POST /stories validates appStorageUrlInfo AND ownerFromPath on write, so
  // this is the best-validated of the four client-supplied columns — the guard
  // below should never fire on a row that endpoint wrote. It is still applied,
  // because "the current write path checks it" is not a property of the rows
  // already in the table.
  const storyPathsOk = await step(steps, "collect_story_media_paths", async () => {
    const { data, error } = await sc
      .from("stories")
      .select("media_url")
      .eq("owner_id", userId);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of (data ?? []) as any[]) {
      if (collectOwnedReference(row?.media_url, userId, storageTargets)) found += 1;
    }
    return found;
  });
  if (!storyPathsOk) warnings.push("story media objects may remain in storage — their references could not be read");

  // ── Message media ─────────────────────────────────────────────────────────
  // TWO objects per media message: messages.media_url and, for video, the
  // separately uploaded messages.media_thumbnail_url. `delete_messages` removes
  // the rows by sender_id, and the policy calls this "the message ciphertext we
  // remove" — the attachments were never part of that removal.
  //
  // This column is the reason the ownership guard is not optional. POST
  // /threads/:threadId/media validates appStorageUrlInfo (ours) and does NOT
  // check ownerFromPath, so a sender can store a key belonging to somebody
  // else and the row is legitimate. Collecting it unguarded would let one
  // user's deletion destroy another user's file.
  const msgPathsOk = await step(steps, "collect_message_media_paths", async () => {
    const { data, error } = await sc
      .from("messages")
      .select("media_url, media_thumbnail_url")
      .eq("sender_id", userId);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of (data ?? []) as any[]) {
      // Independent: a text message has neither, a photo has only the first,
      // a video has both, and a thumbnail that fails the guard must not
      // suppress its original.
      if (collectOwnedReference(row?.media_url, userId, storageTargets)) found += 1;
      if (collectOwnedReference(row?.media_thumbnail_url, userId, storageTargets)) found += 1;
    }
    return found;
  });
  if (!msgPathsOk) warnings.push("message media objects may remain in storage — their references could not be read");

  // ── Hidden gem media ──────────────────────────────────────────────────────
  // hidden_gems.image_url — the representative photo of a submitted gem
  // (migration 20260804). `delete_hidden_gems` removes the rows by submitted_by.
  // The write path types it `z.string().url().max(2048)` and nothing else: no
  // bucket check, no ownership check, so the stored value is as likely to be an
  // external URL as one of ours. The guard is what separates the two.
  const gemPathsOk = await step(steps, "collect_hidden_gem_media_paths", async () => {
    const { data, error } = await sc
      .from("hidden_gems")
      .select("image_url")
      .eq("submitted_by", userId);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of (data ?? []) as any[]) {
      if (collectOwnedReference(row?.image_url, userId, storageTargets)) found += 1;
    }
    return found;
  });
  if (!gemPathsOk) warnings.push("hidden gem media objects may remain in storage — their references could not be read");

  // ── Review photos ─────────────────────────────────────────────────────────
  // reviews.photos is `text[] NOT NULL DEFAULT '{}'` (migration 0196), up to 3
  // URLs per review, written straight through from
  // `z.array(z.string().url()).max(3)` — unvalidated beyond being URLs.
  // `delete_reviews` removes the rows by reviewer_id.
  //
  // Being an array changes the failure mode, so it is handled explicitly: one
  // element that resolves to a foreign host, another user's key or junk is
  // skipped ON ITS OWN. It must not discard the sibling elements of the same
  // review and it must not throw, or a single bad value in one review would
  // orphan every other photo the user ever attached.
  const reviewPathsOk = await step(steps, "collect_review_photo_paths", async () => {
    const { data, error } = await sc
      .from("reviews")
      .select("photos")
      .eq("reviewer_id", userId);
    if (error) throw new Error(error.message);
    let found = 0;
    for (const row of (data ?? []) as any[]) {
      const photos = row?.photos;
      if (!Array.isArray(photos)) continue;
      for (const photo of photos) {
        if (collectOwnedReference(photo, userId, storageTargets)) found += 1;
      }
    }
    return found;
  });
  if (!reviewPathsOk) warnings.push("review photo objects may remain in storage — their references could not be read");

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
  // ── Posts: tombstone or delete, per owner ruling 4 (2026-08-23) ──────────
  //
  // "Posts become tombstones whenever other people have contributed to their
  //  thread ... Hard-delete a post only when it has no third-party comments,
  //  moderation dependency, dispute hold, or shared-history dependency."
  //
  // This used to be one unconditional DELETE, and posts CASCADEs to
  // posts_comments — so deleting a post took every reply other people had
  // written under it. The rule is conditional, and a foreign key cannot ask a
  // question, so the decision is made here, per post.
  //
  // What is checked, stated plainly rather than implied: a comment authored by
  // anyone other than the departing user, and a moderation report naming the
  // post. Dispute holds and other shared-history dependencies are NOT checked —
  // no such marker exists on posts today. When one does, it belongs in
  // hasThirdPartyInterest() and nowhere else.
  const tombstonedCounts: Record<string, number> = {};
  const deletedCounts: Record<string, number> = {};

  async function hasThirdPartyInterest(postId: string): Promise<boolean> {
    const { data: otherComments } = await sc
      .from("posts_comments")
      .select("id")
      .eq("post_id", postId)
      .not("user_id", "is", null)
      .neq("user_id", userId)
      .limit(1);
    if (((otherComments as any[]) ?? []).length > 0) return true;

    const { data: reports } = await sc
      .from("moderation_reports")
      .select("id")
      .eq("subject_type", "post")
      .eq("subject_id", postId)
      .limit(1);
    return ((reports as any[]) ?? []).length > 0;
  }

  const postsOk = await step(steps, "tombstone_or_delete_posts", async () => {
    const { data, error } = await sc.from("posts").select("id").eq("author_id", userId);
    if (error) throw new Error(error.message);

    let tombstoned = 0;
    let deleted = 0;
    // Attempt every post independently. A failing tombstone (e.g. the RPC is
    // absent in an under-migrated environment, returning PGRST202/42883) must
    // NOT abort the loop: doing so leaves every not-yet-reached post untouched,
    // including ordinary posts the else-branch would have hard-deleted, while
    // the caller still marks the request completed. Collect per-post failures,
    // keep going, and throw once at the end so the step fails overall and the
    // account is never reported erased with survivors behind it.
    const postFailures: string[] = [];
    for (const row of ((data as any[]) ?? [])) {
      try {
        if (await hasThirdPartyInterest(row.id)) {
          // One auditable blanking path — see migration 2141. Assembling the
          // UPDATE here would miss a column the day someone adds one; posts has 70.
          const { error: rpcErr } = await sc.rpc("tombstone_post", { p_post_id: row.id });
          if (rpcErr) throw new Error(`tombstone_post(${row.id}): ${rpcErr.message}`);
          tombstoned += 1;
        } else {
          must(await sc.from("posts").delete().eq("id", row.id), `delete post ${row.id}`);
          deleted += 1;
        }
      } catch (e) {
        postFailures.push((e as Error).message);
      }
    }
    tombstonedCounts.posts = tombstoned;
    deletedCounts.posts = deleted;
    if (postFailures.length > 0) {
      throw new Error(
        `${postFailures.length} of ${((data as any[]) ?? []).length} post(s) failed to erase: ${postFailures.join("; ")}`,
      );
    }
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

  // ── Memory UGC rows (audit MEM·H2) ────────────────────────────────────────
  // The user's trip Memories and everything hanging off them. memory_items,
  // memory_tags, memory_likes and memory_saves all FK memories(id) ON DELETE
  // CASCADE, but — like every other table here — they are cleared explicitly so
  // the erasure is provable in the cascade test and independent of any one FK
  // staying ON DELETE CASCADE. Owned children first (keyed by the memory ids
  // collected above), then SEPARATELY the footprint this user left on OTHER
  // people's memories (likes/saves they made, tags OF them), which no
  // memory-scoped delete would reach, and finally the memories rows themselves.
  // memories is swept by owner_id with NO state filter, so soft-deleted
  // (state='deleted') memories left behind by DELETE /memories/:id go too.
  if (memoryIds.length > 0) {
    const ownedMemoryDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
      { name: "delete_memory_items",       run: () => sc.from("memory_items").delete().in("memory_id", memoryIds) },
      { name: "delete_memory_tags_owned",  run: () => sc.from("memory_tags").delete().in("memory_id", memoryIds) },
      { name: "delete_memory_likes_owned", run: () => sc.from("memory_likes").delete().in("memory_id", memoryIds) },
      { name: "delete_memory_saves_owned", run: () => sc.from("memory_saves").delete().in("memory_id", memoryIds) },
    ];
    for (const d of ownedMemoryDeletes) {
      const ok = await step(steps, d.name, async () => { must(await d.run(), d.name); });
      if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
    }
  }
  const memoryFootprintDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
    { name: "delete_memory_likes_by_user", run: () => sc.from("memory_likes").delete().eq("user_id", userId) },
    { name: "delete_memory_saves_by_user", run: () => sc.from("memory_saves").delete().eq("user_id", userId) },
    { name: "delete_memory_tags_of_user",  run: () => sc.from("memory_tags").delete().eq("tagged_user_id", userId) },
  ];
  for (const d of memoryFootprintDeletes) {
    const ok = await step(steps, d.name, async () => { must(await d.run(), d.name); });
    if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
  }
  const memOwnOk = await step(steps, "delete_memories", async () => {
    must(await sc.from("memories").delete().eq("owner_id", userId), "delete memories");
  });
  if (!memOwnOk) warnings.push("memories rows may remain");

  // ── 3b. Content the posts/messages cascades do not reach ──────────────────
  // Because the profile row survives as a tombstone, none of the FK cascades
  // hanging off profiles(id) ever fire — every one of these tables has to be
  // cleared by hand (merged from the old services/accountDeletion.ts cascade).
  // One failing table records its own step and never aborts the rest.
  const contentDeletes: Array<{ name: string; run: () => PromiseLike<{ error?: any }> }> = [
    // Outstanding phone-verification challenges. These carry a phone number and
    // a live credential hash. The FK to profiles is ON DELETE CASCADE, but this
    // service keeps an anonymised TOMBSTONE profile rather than deleting the
    // profiles row, so that cascade never fires — the rows must be cleared here
    // by hand like every other user-keyed table.
    { name: "delete_phone_challenges", run: () => sc.from("phone_verification_challenges").delete().eq("user_id", userId) },
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
    // Gem-visit check-ins store raw lat/lng; the FK to the tombstoned profile
    // never cascades, so clear them by hand (audit TRAIL·F3).
    { name: "delete_hidden_gem_visits", run: () => sc.from("hidden_gem_visits").delete().eq("user_id", userId) },
    // Saved items across the various save surfaces.
    { name: "delete_saved_places",    run: () => sc.from("saved_places").delete().eq("user_id", userId) },
    { name: "delete_user_saves",      run: () => sc.from("user_saves").delete().eq("saver_id", userId) },
    { name: "delete_wishlist_places", run: () => sc.from("wishlist_places").delete().eq("user_id", userId) },
    { name: "delete_event_saves",     run: () => sc.from("event_saves").delete().eq("user_id", userId) },
    // Follow graph, both directions.
    { name: "delete_follows_outgoing", run: () => sc.from("user_follows").delete().eq("follower_id", userId) },
    { name: "delete_follows_incoming", run: () => sc.from("user_follows").delete().eq("following_id", userId) },
    // Compass personal content + a projection source. compass_memories ("Teach My
    // Compass" statements) and compass_conversations (full chat history) are the
    // most literally personal text in the product and survived deletion (audit
    // MEM·H1). compass_user_preferences is one of the two sources the memory
    // projector re-enumerates a deleted user from (audit MEM·C1) — clearing it
    // removes that branch (the graph-edge branch is closed separately by the
    // project_all_memory deleted-account filter). erase_memory_for_user below
    // covers only the 2183 memory_* contract tables, not these.
    { name: "delete_compass_memories",      run: () => sc.from("compass_memories").delete().eq("user_id", userId) },
    { name: "delete_compass_conversations", run: () => sc.from("compass_conversations").delete().eq("user_id", userId) },
    { name: "delete_compass_user_preferences", run: () => sc.from("compass_user_preferences").delete().eq("user_id", userId) },
  ];
  for (const d of contentDeletes) {
    const ok = await step(steps, d.name, async () => {
      must(await d.run(), d.name);
    });
    if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
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
      // IG-02 intelligence contributions. Routed through the SECURITY DEFINER
      // erasure function rather than a direct .delete(): the intel tables are
      // append-only, and their triggers permit DELETE only inside a transaction
      // that has declared an erasure — which PostgREST cannot do on its own.
      // Derived claims/snapshots are intentionally not deleted; they are
      // aggregate beliefs about a place and are recomputed.
      { name: "erase_intel_contributions", run: () => sc.rpc("erase_intel_for_actor", { p_actor_id: userId }) },
      // IG-02 contribution consent (migration 2172). NOT append-only, so cleared
      // with a direct scoped delete rather than the erasure RPC. Its ON DELETE
      // CASCADE to profiles never fires — the deletion keeps an anonymised
      // tombstone profile rather than deleting the row (migration 2172's header
      // assumed the cascade would erase it; it cannot, the same mistake 2187 made
      // for derived memory and 2190 corrected). 2203 grants service_role DELETE on
      // the table so this step actually removes the row. Keyed by user_id (the PK).
      { name: "delete_intel_consent", run: () => sc.from("intel_contribution_consent").delete().eq("user_id", userId) },
      // IG-10 non-cash reward ledger (migration 2170). Keyed by actor_id →
      // profiles(id) ON DELETE CASCADE, but that cascade never fires under the
      // tombstone (same as consent above), so a departed contributor's earning
      // rows — actor_id + qiu + earned_units + source + timestamps — would survive
      // as orphaned personal data while the observations that earned them were
      // erased by erase_intel_for_actor. The ledger is append-only by grant (no
      // DELETE-blocking trigger), so a direct scoped delete clears it; migration
      // 2204 grants service_role the DELETE this needs. Non-cash (cash_amount = 0
      // enforced), so no financial-retention reason to keep it.
      { name: "delete_intel_reward_ledger", run: () => sc.from("intel_reward_ledger").delete().eq("actor_id", userId) },
    { name: "delete_search_history",      run: () => sc.from("search_history").delete().eq("user_id", userId) },
  ];
  for (const d of tailDeletes) {
    const ok = await step(steps, d.name, async () => {
      must(await d.run(), d.name);
    });
    if (!ok) warnings.push(`${d.name.replace(/^delete_/, "")} rows may remain`);
  }

  // ── IG mission-candidate acceptance (migration 2167) ──────────────────────
  // intel_mission_candidates.accepted_by names the contributor who accepted a
  // dispatched mission. The column is `uuid REFERENCES profiles(id) ON DELETE
  // SET NULL`, so the FK's declared intent is: when the profile goes away, NULL
  // the identifier and keep the ops row. That SET NULL never fires — the deletion
  // keeps an anonymised TOMBSTONE profile rather than deleting profiles(id), so no
  // profiles-keyed cascade or SET-NULL ever runs (the same mistake 2172/2170/2187
  // made for consent/reward-ledger/derived-memory, corrected by 2203/2204/2190).
  // The departed user's uuid would otherwise survive here as a residual identifier
  // in an operational record, still joinable to that uuid across tables, while the
  // contributions the mission produced were already erased by erase_intel_for_actor.
  //
  // This is a SET NULL, NOT a delete: the row is a city-scoped ops record with no
  // other user-identifying column, so it is retained and only the identifier is
  // removed — exactly what the FK declared. UPDATE was already granted to
  // service_role by 2167; migration 2211 reaffirms it so this step's authority is
  // explicit and drift-tolerant. Non-fatal, matching the surrounding intel steps.
  const missionOk = await step(steps, "null_intel_mission_accepted_by", async () => {
    must(
      await sc.from("intel_mission_candidates").update({ accepted_by: null }).eq("accepted_by", userId),
      "null intel_mission_candidates.accepted_by",
    );
  });
  if (!missionOk) warnings.push("intel_mission_candidates.accepted_by may still name the deleted user");

  // ── Derived memory (FATAL on failure) ─────────────────────────────────────
  // memory_projections / memory_events / memory_feedback hold derived facts about
  // the user (places visited, people followed, inferred preferences). They are
  // purged EXPLICITLY here and deliberately NOT left to a foreign-key cascade:
  //   * production's public.profiles has NO foreign key to auth.users at all, and
  //   * this service keeps an ANONYMISED TOMBSTONE profile rather than deleting
  //     the row, so a profiles-keyed cascade could never fire even if the FK
  //     existed. Migration 2187 assumed otherwise; 2190 corrects it.
  // Routed through the SECURITY DEFINER erase_memory_for_user so the purge is one
  // atomic, idempotent statement — the same shape as erase_intel_for_actor above.
  // FATAL: leaving derived personal memory behind after a deletion request is a
  // privacy failure, so it aborts the run rather than recording a warning. The
  // request stays retryable and the function is idempotent, so a retry is safe.
  const memoryOk = await step(steps, "erase_derived_memory", async () => {
    must(await sc.rpc("erase_memory_for_user", { p_user_id: userId }), "erase_memory_for_user");
  });
  if (!memoryOk) {
    warnings.push("derived memory may remain — deletion aborted before profile anonymisation; retry is safe");
    return { ok: false, userId, executedAt, steps, warnings, deletedCounts, tombstonedCounts };
  }

  if (opts.contentOnly) {
    return { ok: steps.every((s) => s.ok), userId, executedAt, steps, warnings, deletedCounts, tombstonedCounts };
  }

  // ── 4. Anonymise the tombstone profile (FATAL on failure) ─────────────────
  const profileOk = await step(steps, "anonymise_profile", async () => {
    must(
      await sc
        .from("profiles")
        .update({
          // NOT `null`. public.profiles.handle is `text NOT NULL UNIQUE`, so
          // nulling it raised 23502 and — because this step is FATAL — aborted
          // the deletion before step 5 removed the auth user. Every content step
          // above had already succeeded, so the outcome was the exact inverse of
          // a deletion: the user's content destroyed, their email retained, and
          // the request left pending to retry and fail identically forever.
          //
          // Derived from userId so it is UNIQUE (the index demands it) and
          // deterministic (a retry rewrites the same value, keeping this step
          // idempotent like every other one). This leaks nothing new: the
          // tombstone row is keyed by that same uuid as its primary key.
          handle: `deleted_${userId.replace(/-/g, "")}`,
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
    return { ok: false, userId, executedAt, steps, warnings, deletedCounts, tombstonedCounts };
  }

  // ── 5. Remove the auth user (this is what finally drops the email) ────────
  // profiles has no FK to auth.users, so the tombstone above survives this.
  const authOk = await step(steps, "auth_delete_user", async () => {
    const res = await sc.auth.admin.deleteUser(userId);
    if (res?.error) throw new Error(res.error.message ?? String(res.error));
  });
  if (!authOk) {
    // Loud AND fatal: the email address is still on file, which is the exact
    // GDPR claim the policy makes. The request is NOT marked completed below,
    // so callers (scheduler / worker endpoint / admin) leave it pending and
    // the whole cascade retries — every content step above is idempotent.
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

  // Only mark the request completed when the auth user is actually gone —
  // a "completed" request is never re-selected, so completing it while the
  // email survives would strand personal data forever.
  let markedOk = false;
  if (authOk) {
    markedOk = await step(steps, "mark_request_completed", async () => {
      must(
        await sc
          .from("user_deletion_requests")
          .update({
            status: "completed",
            executed_at: executedAt,
            completed_at: executedAt,
            // Owner ruling 3: on completion the receipt stops naming a person.
            // The WHERE below is evaluated before this SET, so clearing user_id
            // in the same statement is safe — and doing it in a SECOND statement
            // would leave a window where a completed receipt still identifies
            // someone, which is the state the ruling forbids.
            user_id: null,
            policy_version: DELETION_POLICY_VERSION,
            worker_version: DELETION_WORKER_VERSION,
            deleted_counts: deletedCounts,
            tombstoned_counts: tombstonedCounts,
          })
          .eq("user_id", userId),
        "mark request completed",
      );
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
  logger.info(
    { userId, ok, warnings, failedSteps: steps.filter((s) => !s.ok).map((s) => s.step) },
    "executeAccountDeletion: finished",
  );

  return { ok, userId, executedAt, steps, warnings, deletedCounts, tombstonedCounts };
}
