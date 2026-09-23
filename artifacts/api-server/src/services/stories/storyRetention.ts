/**
 * Story retention — the purge over the owner's archive.
 *
 * Owner decisions, 2026-09-22. What this job does, and nothing else:
 *
 *   1. An expired Story is permanently purged at `expires_at + 365 days`.
 *   2. An owner-deleted Story is permanently purged at `deleted_at + 30 days`.
 *      Before that it is recoverable by its owner and by nobody else.
 *   3. Viewer lists, reactions and story-specific private replies are purged at
 *      `expires_at + 30 days`, or earlier when the parent Story goes.
 *   6. A Story's media is NOT deleted while another feature still references
 *      the same bytes (a saved Highlight, a Memory item, a passport memory).
 *      The Story row is still purged; the bytes belong to the surviving
 *      reference. The reference does not restore audience access to the Story,
 *      because nothing here touches the expiry predicate that withholds it.
 *   7. Database and storage deletion are recoverable across partial failures.
 *
 * ── WHY A LEDGER AND NOT A DELETE STATEMENT ──────────────────────────────────
 * Two deletions have to happen for one Story — the storage object and the
 * database row — and they are in different systems with no transaction across
 * them. Whichever runs first, the process can die between them:
 *
 *   row first    the row was the only record of where the bytes live. The
 *                object is now unreferenced, unfindable and permanent. This is
 *                the failure decision 7 names by name.
 *   object first the row survives pointing at bytes that are gone: the archive
 *                shows a dead thumbnail until the next pass.
 *
 * So neither runs first. `story_purge_queue` (migration 2998) is written FIRST,
 * carrying the storage path, and is removed only once BOTH deletions have been
 * confirmed by reading the world back. A crash at any point leaves a durable
 * entry that the next pass retries. The ledger has no foreign key to `stories`
 * precisely so that it outlives the row.
 *
 * ── WHY EVERY SUCCESS IS A READ-BACK ─────────────────────────────────────────
 * CONTRIBUTING.md's rule, and it is not ceremony here. `storage.remove()`
 * resolves with `{ data: [] }` for a path that was never there and for a path
 * it failed to touch; supabase-js RESOLVES on database errors, so an unchecked
 * `.delete()` reads as success. A purge that reports "done" without looking is
 * how an archive silently stops being purged — and the sweep this job replaces
 * (routes/stories.ts:973) sat unwired for months with nobody able to tell.
 *
 * So: `object_deleted_at` is set only after a storage listing no longer shows
 * the object, and `row_deleted_at` only after a select by id returns nothing.
 *
 * ── WHAT THIS JOB DOES NOT DO ────────────────────────────────────────────────
 * It does not expire anything, does not change any read path, and does not
 * touch audience access. An expired Story is withheld from its audience by
 * `expires_at` at four independent layers (routes/stories.ts:497-498 and
 * :600-601, migrations/0068_stories.sql:51-53, lib/mediaAccess.ts:544-549) and
 * this file changes none of them. It also never purges `state='saved'` (the
 * media belongs to a Highlight) or `state='removed'` (a moderation record,
 * which the privacy policy retains).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { appStorageUrlInfo } from "../../lib/mediaUrl.js";
import {
  resolveStoryRetentionConfig,
  describeDivergence,
  type StoryRetentionConfig,
} from "./storyRetentionPolicy.js";

/** Rows enqueued, and ledger entries worked, in one pass. Keeps a tick bounded. */
export const DEFAULT_BATCH_LIMIT = 200;

/** Retry backoff for a ledger entry that could not be completed, by attempt count. */
export const RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 720] as const;

/**
 * Tables that may hold a second reference to the same bytes, and the column
 * that holds it. Taken from AccountDeletionService's inventory of storage
 * references (AccountDeletionService.ts:80-100), restricted to the ones a
 * Story's media can plausibly reach:
 *
 *   highlights.media_url        save-to-highlight copies the Story's media_url
 *                               verbatim (routes/stories.ts:909-920)
 *   memory_items.media_url      a Memory built from a Story
 *   passport_memories.photo_url the passport surface's own copy
 *
 * `memory_evidence` is deliberately absent: it has no migration in this tree
 * (services/memory/memoryDeletionLifecycle.ts:21) and does not exist in
 * production — verified 2026-09-22. It is not "checked and empty"; there is
 * nothing to check. If it is ever created, it belongs in this list.
 */
export const REFERENCE_SOURCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "highlights", column: "media_url" },
  { table: "memory_items", column: "media_url" },
  { table: "passport_memories", column: "photo_url" },
];

export interface RetentionReport {
  /** ISO time the pass started. */
  startedAt: string;
  config: StoryRetentionConfig;
  enqueuedArchive: number;
  enqueuedDeleted: number;
  /** Ledger entries fully completed and removed this pass. */
  completed: number;
  /** Entries whose object was deliberately kept for a surviving reference. */
  retained: number;
  /** Entries that could not be completed and were rescheduled. */
  deferred: number;
  /** Stories whose engagement rows were purged. */
  engagementStoriesPurged: number;
  engagementRowsPurged: number;
  /** Entries still outstanding in the ledger after this pass. */
  backlog: number;
  /** Human-readable reasons this pass was not a clean success. Empty on success. */
  failures: string[];
}

function daysAgoIso(now: number, days: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

function backoffMinutes(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length) - 1;
  return RETRY_BACKOFF_MINUTES[i];
}

/**
 * Split a storage path into the directory the listing call needs and the exact
 * basename the read-back compares against. `list()` takes a prefix, never a
 * full object path, so passing the whole path returns an empty listing for an
 * object that is very much still there — which would read as "confirmed gone".
 */
export function splitStoragePath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

/**
 * Which of these media URLs are still referenced by something other than the
 * Story being purged.
 *
 * FAILS CLOSED, and this is the one place in this file where failing closed
 * means keeping bytes rather than deleting them. A read that errors returns the
 * URL as "referenced (unverifiable)", so the object is not deleted and the
 * entry is retried later. Treating an unreadable table as "no reference" would
 * delete a live Highlight's media, which is unrecoverable; treating it as a
 * reference costs one more pass.
 *
 * A table that does not exist is a different thing from a table that would not
 * answer. PostgREST answers a missing relation with code 42P01 / PGRST205, and
 * that IS an establishable result — there are no references in a table that
 * does not exist — so it is not treated as a failure.
 */
export async function findSurvivingReferences(
  sc: SupabaseClient,
  mediaUrls: string[],
): Promise<Map<string, string>> {
  const referenced = new Map<string, string>();
  if (mediaUrls.length === 0) return referenced;

  // Each source is read through a literal `.from("…").select("…")` below rather
  // than through `.from(table)` over REFERENCE_SOURCES. The loop read better,
  // but check:write-path-columns could not resolve a dynamic table name, so
  // these four reads were blind spots to the guard that compares every
  // write/read site against the live schema — on the one code path whose whole
  // job is deciding whether media is safe to destroy. The shared body stays in
  // one place; only the builder is passed in.
  const sources: ReadonlyArray<{ table: string; column: string; read: () => any }> = [
    { table: "highlights", column: "media_url",
      read: () => sc.from("highlights").select("media_url").in("media_url", mediaUrls) },
    { table: "memory_items", column: "media_url",
      read: () => sc.from("memory_items").select("media_url").in("media_url", mediaUrls) },
    { table: "passport_memories", column: "photo_url",
      read: () => sc.from("passport_memories").select("photo_url").in("photo_url", mediaUrls) },
  ];

  // The literal list above and REFERENCE_SOURCES must not drift: the const is
  // what the docs and tests name, and a source dropped from one but not the
  // other would silently stop protecting a feature's media. Cheap to assert,
  // and an assertion is the only thing that makes "must not drift" true.
  if (
    sources.length !== REFERENCE_SOURCES.length ||
    sources.some((s, i) => s.table !== REFERENCE_SOURCES[i].table || s.column !== REFERENCE_SOURCES[i].column)
  ) {
    throw new Error(
      "storyRetention: the reference reads and REFERENCE_SOURCES disagree — refusing to decide what is safe to delete",
    );
  }

  for (const { table, column, read } of sources) {
    const { data, error } = await read();

    if (error) {
      const code = String((error as any)?.code ?? "");
      const missingRelation = code === "42P01" || code === "PGRST205" || code === "PGRST106";
      if (missingRelation) continue; // Establishable: no such table, so no references in it.
      // Anything else: we do not know, so we do not delete.
      for (const url of mediaUrls) {
        if (!referenced.has(url)) referenced.set(url, `${table}.${column} unreadable (${code || "unknown"})`);
      }
      continue;
    }
    for (const row of (data ?? []) as any[]) {
      const url = row?.[column];
      if (typeof url === "string" && url) referenced.set(url, `referenced by ${table}.${column}`);
    }
  }
  return referenced;
}

/**
 * Write ledger entries for every Story now past its window, capturing the
 * storage path before anything is destroyed. Enqueueing is idempotent: the
 * ledger's primary key is the story id, so a Story already queued is left
 * alone rather than having its attempt counter reset by a re-enqueue.
 *
 * THROWS on a read error. A purge pass that cannot see the archive must not
 * report that it found nothing to do.
 */
export async function enqueueDueStories(
  sc: SupabaseClient,
  cfg: StoryRetentionConfig,
  nowMs: number,
  limit: number,
): Promise<{ archive: number; deleted: number }> {
  const archiveCutoff = daysAgoIso(nowMs, cfg.archiveRetentionDays);
  const deletedCutoff = daysAgoIso(nowMs, cfg.deletedRecoveryDays);

  // 1. Expired archive entries.
  //    `state IN ('active','expired')` rather than 'expired' alone: a Story
  //    whose row never got flipped is still past its window, and keying the
  //    purge on the state flag would make the archive retention depend on a
  //    separate sweep having run. It is the clock that decides, not the flag.
  //    'saved' is excluded (its bytes belong to a Highlight), 'removed' is
  //    excluded (a moderation record), 'deleted' has its own shorter clock.
  const { data: archiveRows, error: archiveErr } = await sc
    .from("stories")
    .select("id, owner_id, media_url")
    .in("state", ["active", "expired"])
    .is("saved_to_highlight_id", null)
    .lt("expires_at", archiveCutoff)
    .order("expires_at", { ascending: true })
    .limit(limit);
  if (archiveErr) throw archiveErr;

  // 2. Owner-deleted entries whose recovery window has closed.
  //
  //    The window closes at whichever comes FIRST: `deleted_at + recovery
  //    days`, or the archive deadline the Story already had. Deleting is a
  //    request to remove something sooner, so it must never buy the row more
  //    time than leaving it alone would have — and without the second
  //    predicate it does. `deleted_at` is set afresh on each delete (the 2998
  //    trigger only refuses to move it while the row STAYS deleted), so
  //    delete, recover, delete renews the 30 days, and a caller repeating that
  //    cycle would hold a Story past its 365-day cap indefinitely. Capping the
  //    window at the archive deadline closes that without weakening the
  //    never-reset rule the trigger enforces.
  //
  //    `.or()` rather than two queries: one row can satisfy both predicates and
  //    enqueuing it twice is a duplicate-key round trip for nothing.
  const { data: deletedRows, error: deletedErr } = await sc
    .from("stories")
    .select("id, owner_id, media_url")
    .eq("state", "deleted")
    .not("deleted_at", "is", null)
    .or(`deleted_at.lt.${deletedCutoff},expires_at.lt.${archiveCutoff}`)
    .order("deleted_at", { ascending: true })
    .limit(limit);
  if (deletedErr) throw deletedErr;

  // The bookkeeping columns are written explicitly rather than left to the
  // table's defaults. `next_attempt_at` is a scan predicate — processPurgeQueue
  // selects on `next_attempt_at <= now` — so an entry that arrives without one
  // is invisible to the job that is supposed to work it. A column default is
  // the right belt; naming the value here is the braces, and it keeps the two
  // halves of this file honest without a round trip to read the default back.
  const nowIso = new Date(nowMs).toISOString();

  // The two result sets are paired with their reason FIRST and mapped to rows
  // ONCE, rather than each being mapped through a shared `toEntry` helper.
  // Both spellings produce the same rows; only this one is legible to
  // check:write-path-columns, whose extractor reads the object literal a
  // `.map()` callback returns but cannot follow a call to a named builder. A
  // helper here would make every column this job writes a blind spot in the
  // check that exists to catch a phantom column before it reaches the
  // database, and story_purge_queue is a brand-new table whose columns have
  // never been checked against a live schema at all.
  const queued: ReadonlyArray<{
    row: any;
    reason: "archive_expired" | "owner_deleted";
  }> = [
    ...((archiveRows ?? []) as any[]).map((row) => ({
      row,
      reason: "archive_expired" as const,
    })),
    ...((deletedRows ?? []) as any[]).map((row) => ({
      row,
      reason: "owner_deleted" as const,
    })),
  ];

  const entries = queued.map(({ row, reason }) => {
    const mediaUrl = String(row.media_url ?? "");
    const ref = appStorageUrlInfo(mediaUrl);
    return {
      story_id: row.id as string,
      owner_id: row.owner_id as string,
      media_url: mediaUrl,
      storage_bucket: ref?.bucket ?? null,
      storage_path: ref?.path ?? null,
      reason,
      enqueued_at: nowIso,
      attempts: 0,
      next_attempt_at: nowIso,
      object_deleted_at: null,
      object_retained_reason: null,
      row_deleted_at: null,
      last_attempt_at: null,
      last_error: null,
    };
  });
  if (entries.length === 0) return { archive: 0, deleted: 0 };

  // ignoreDuplicates: an entry already in the ledger is mid-retry. Re-inserting
  // it would reset attempts and next_attempt_at, turning a failing entry into
  // one that is retried every tick forever without its backoff ever growing.
  const { error: insErr } = await sc
    .from("story_purge_queue")
    .upsert(entries, { onConflict: "story_id", ignoreDuplicates: true });
  if (insErr) throw insErr;

  return {
    archive: (archiveRows ?? []).length,
    deleted: (deletedRows ?? []).length,
  };
}

/** Confirm by reading storage back that `path` is absent from `bucket`. */
async function confirmObjectAbsent(
  sc: SupabaseClient,
  bucket: string,
  path: string,
): Promise<{ absent: boolean; detail: string }> {
  const { dir, base } = splitStoragePath(path);
  const { data, error } = await sc.storage.from(bucket).list(dir, { search: base, limit: 100 });
  if (error) return { absent: false, detail: `listing ${bucket}/${dir} failed: ${(error as any)?.message ?? "unknown"}` };
  const stillThere = ((data ?? []) as any[]).some((o) => o?.name === base);
  return stillThere
    ? { absent: false, detail: `${bucket}/${path} is still listed after remove()` }
    : { absent: true, detail: "" };
}

/** Confirm by reading the table back that the Story row is gone. */
async function confirmRowAbsent(sc: SupabaseClient, storyId: string): Promise<{ absent: boolean; detail: string }> {
  const { data, error } = await sc.from("stories").select("id").eq("id", storyId).maybeSingle();
  if (error) return { absent: false, detail: `re-read of stories.${storyId} failed: ${(error as any)?.message ?? "unknown"}` };
  return data ? { absent: false, detail: `stories row ${storyId} still present after delete` } : { absent: true, detail: "" };
}

/**
 * Work the ledger: for each due entry, delete the object (unless something else
 * still references it), delete the row, verify both, and only then drop the
 * entry.
 *
 * THROWS on a failure to read the ledger. Per-entry failures do not throw —
 * they are recorded on the entry and retried — but they are counted and
 * reported, because a pass where every entry failed must never be reported as
 * a pass that had no work.
 */
export async function processPurgeQueue(
  sc: SupabaseClient,
  nowMs: number,
  limit: number,
): Promise<{ completed: number; retained: number; deferred: number; failures: string[] }> {
  const nowIso = new Date(nowMs).toISOString();
  const { data: due, error: dueErr } = await sc
    .from("story_purge_queue")
    .select("*")
    .lte("next_attempt_at", nowIso)
    .order("enqueued_at", { ascending: true })
    .limit(limit);
  if (dueErr) throw dueErr;

  const entries = (due ?? []) as any[];
  if (entries.length === 0) return { completed: 0, retained: 0, deferred: 0, failures: [] };

  const pending = entries.filter((e) => !e.object_deleted_at && !e.object_retained_reason && e.storage_path);
  const surviving = await findSurvivingReferences(sc, pending.map((e) => String(e.media_url)));

  let completed = 0;
  let retained = 0;
  let deferred = 0;
  const failures: string[] = [];

  for (const entry of entries) {
    const storyId = String(entry.story_id);
    let objectDeletedAt: string | null = entry.object_deleted_at ?? null;
    let objectRetainedReason: string | null = entry.object_retained_reason ?? null;
    let rowDeletedAt: string | null = entry.row_deleted_at ?? null;
    let failure: string | null = null;

    // ── Step 1: the bytes ────────────────────────────────────────────────────
    if (!objectDeletedAt && !objectRetainedReason) {
      if (!entry.storage_path || !entry.storage_bucket) {
        // media_url never resolved to one of this app's buckets. There is no
        // object of ours to delete, and saying so is not the same as claiming
        // we deleted one.
        objectRetainedReason = "no app-storage object claimed by this media_url";
      } else {
        const stillReferenced = surviving.get(String(entry.media_url));
        if (stillReferenced) {
          objectRetainedReason = stillReferenced;
        } else {
          const bucket = String(entry.storage_bucket);
          const path = String(entry.storage_path);
          try {
            const { error: rmErr } = await sc.storage.from(bucket).remove([path]);
            if (rmErr) {
              failure = `remove(${bucket}/${path}) failed: ${(rmErr as any)?.message ?? "unknown"}`;
            } else {
              const check = await confirmObjectAbsent(sc, bucket, path);
              if (check.absent) objectDeletedAt = nowIso;
              else failure = check.detail;
            }
          } catch (err) {
            failure = `remove(${bucket}/${path}) threw: ${(err as any)?.message ?? String(err)}`;
          }
        }
      }
    }

    // ── Step 2: the row, only once the bytes are settled ─────────────────────
    // Ordering matters and is the whole point of the ledger: the row is the
    // archive entry the owner sees, and deleting it while the object is still
    // in doubt would leave nothing pointing at the bytes except this ledger.
    // The ledger is durable, so that is survivable — but there is no reason to
    // lean on it when waiting one pass costs nothing.
    if (!failure && !rowDeletedAt && (objectDeletedAt || objectRetainedReason)) {
      const { error: delErr } = await sc.from("stories").delete().eq("id", storyId);
      if (delErr) {
        failure = `delete stories.${storyId} failed: ${(delErr as any)?.message ?? "unknown"}`;
      } else {
        const check = await confirmRowAbsent(sc, storyId);
        if (check.absent) rowDeletedAt = nowIso;
        else failure = check.detail;
      }
    }

    // ── Step 3: settle the entry ─────────────────────────────────────────────
    if (!failure && rowDeletedAt && (objectDeletedAt || objectRetainedReason)) {
      const { error: clearErr } = await sc.from("story_purge_queue").delete().eq("story_id", storyId);
      if (clearErr) {
        failure = `could not clear ledger entry ${storyId}: ${(clearErr as any)?.message ?? "unknown"}`;
      } else {
        completed += 1;
        if (objectRetainedReason) retained += 1;
        continue;
      }
    }

    // Progress is persisted even when the entry did not finish, so a partially
    // completed purge never repeats the half it already did.
    const attempts = Number(entry.attempts ?? 0) + 1;
    const { error: updErr } = await sc
      .from("story_purge_queue")
      .update({
        object_deleted_at: objectDeletedAt,
        object_retained_reason: objectDeletedAt ? null : objectRetainedReason,
        row_deleted_at: rowDeletedAt,
        attempts,
        last_attempt_at: nowIso,
        last_error: failure,
        next_attempt_at: new Date(nowMs + backoffMinutes(attempts) * 60_000).toISOString(),
      })
      .eq("story_id", storyId);
    deferred += 1;
    if (failure) failures.push(failure);
    if (updErr) failures.push(`could not record retry state for ${storyId}: ${(updErr as any)?.message ?? "unknown"}`);
  }

  return { completed, retained, deferred, failures };
}

/**
 * Purge viewer lists, reactions and story-specific private replies for Stories
 * past `expires_at + engagementRetentionDays` that are still in the archive.
 *
 * Stories that are being purged outright need nothing here: the three tables
 * cascade from `stories` (migrations/0068_stories.sql:57, :86, :116).
 *
 * ── ON THE REPLIES ───────────────────────────────────────────────────────────
 * The decision asked whether story replies also exist as Telegraph messages, so
 * that this policy does not silently delete an independent conversation record.
 * Verified 2026-09-22 against main at 364cfcd: `story_replies` is written by
 * exactly one route (routes/stories.ts:752, POST /stories/:id/reply), which
 * inserts into that table and nowhere else; the client calls only that endpoint
 * (travel-buddy-standalone/src/services/stories.ts:227); and the only other
 * code that touches the table is account deletion. There is no Telegraph
 * mirror, so nothing independent is destroyed here.
 */
export async function purgeExpiredEngagement(
  sc: SupabaseClient,
  cfg: StoryRetentionConfig,
  nowMs: number,
  limit: number,
): Promise<{ stories: number; rows: number; failures: string[] }> {
  const cutoff = daysAgoIso(nowMs, cfg.engagementRetentionDays);
  const failures: string[] = [];

  const { data: rows, error } = await sc
    .from("stories")
    .select("id")
    .lt("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const ids = ((rows ?? []) as any[]).map((r) => String(r.id));
  if (ids.length === 0) return { stories: 0, rows: 0, failures };

  let purged = 0;
  // Literal `.from("…")` per table, for the same reason as findSurvivingReferences
  // above: `.from(table)` over a list is a blind spot to check:write-path-columns,
  // and this is a DELETE path. The verification body below stays single-sourced;
  // only the two builders differ per table.
  const engagementTables: ReadonlyArray<{
    table: string;
    del: () => any;
    count: () => any;
  }> = [
    { table: "story_views",
      del: () => sc.from("story_views").delete().in("story_id", ids),
      count: () => sc.from("story_views").select("story_id", { count: "exact", head: true }).in("story_id", ids) },
    { table: "story_reactions",
      del: () => sc.from("story_reactions").delete().in("story_id", ids),
      count: () => sc.from("story_reactions").select("story_id", { count: "exact", head: true }).in("story_id", ids) },
    { table: "story_replies",
      del: () => sc.from("story_replies").delete().in("story_id", ids),
      count: () => sc.from("story_replies").select("story_id", { count: "exact", head: true }).in("story_id", ids) },
  ];

  for (const { table, del, count: readCount } of engagementTables) {
    const { error: delErr } = await del();
    if (delErr) {
      failures.push(`purge ${table} failed: ${(delErr as any)?.message ?? "unknown"}`);
      continue;
    }
    // Read the state back rather than trusting the delete: supabase-js resolves
    // on rejection, and "0 rows deleted" and "the delete was refused" are the
    // same shape from here.
    const { count, error: cntErr } = await readCount();
    if (cntErr) {
      failures.push(`could not verify ${table} purge: ${(cntErr as any)?.message ?? "unknown"}`);
      continue;
    }
    if ((count ?? 0) > 0) {
      failures.push(`${count} ${table} rows survived the purge for ${ids.length} stories`);
      continue;
    }
    purged += 1;
  }

  return { stories: ids.length, rows: purged, failures };
}

/** Outstanding ledger entries, for the health surface. Null when unreadable. */
export async function readPurgeBacklog(sc: SupabaseClient): Promise<number | null> {
  const { count, error } = await sc
    .from("story_purge_queue")
    .select("story_id", { count: "exact", head: true });
  if (error) return null;
  return count ?? 0;
}

/**
 * One retention pass.
 *
 * Returns a report rather than throwing for per-entry trouble, but propagates a
 * throw when the archive or the ledger could not be READ: a pass that cannot
 * see its own work has no result to report, and reporting zero would be a
 * fabricated one.
 */
export async function runStoryRetention(
  sc: SupabaseClient,
  opts: { now?: number; limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<RetentionReport> {
  const nowMs = opts.now ?? Date.now();
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const cfg = resolveStoryRetentionConfig(opts.env ?? process.env);
  const failures: string[] = cfg.divergences.map(describeDivergence);

  const enq = await enqueueDueStories(sc, cfg, nowMs, limit);
  const worked = await processPurgeQueue(sc, nowMs, limit);
  failures.push(...worked.failures);

  const engagement = await purgeExpiredEngagement(sc, cfg, nowMs, limit);
  failures.push(...engagement.failures);

  const backlog = await readPurgeBacklog(sc);
  if (backlog === null) failures.push("purge backlog is unreadable — treat the count as unknown, not zero");

  return {
    startedAt: new Date(nowMs).toISOString(),
    config: cfg,
    enqueuedArchive: enq.archive,
    enqueuedDeleted: enq.deleted,
    completed: worked.completed,
    retained: worked.retained,
    deferred: worked.deferred,
    engagementStoriesPurged: engagement.stories,
    engagementRowsPurged: engagement.rows,
    backlog: backlog ?? -1,
    failures,
  };
}
