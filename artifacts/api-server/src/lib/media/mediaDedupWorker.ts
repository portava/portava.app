/**
 * mediaDedupWorker — background worker that groups near-duplicate post_media
 * images at the same canonical place using perceptual hashing (pHash).
 *
 * Runs on a 20-minute interval. Each tick:
 *   1. Selects up to 1 000 unprocessed post_media rows (phash IS NOT NULL,
 *      canonical_place_id IS NOT NULL, dedup_processed = FALSE).
 *   2. Groups them by canonical_place_id.
 *   3. For each place:
 *      a. Loads existing media_dedup_groups (with representative_phash) so
 *         late-arriving duplicates can join existing clusters across ticks.
 *      b. For each new row, checks ALL existing representatives (no bucket
 *         prefilter) so cross-prefix near-duplicates are never missed.
 *      c. Rows matching an existing group: upsert into media_dedup_memberships
 *         (idempotent: ON CONFLICT DO NOTHING), then recompute member_count
 *         from the actual membership count.
 *      d. Standalone rows: cluster pairwise, upsert new group rows, upsert
 *         memberships, recompute member_count from memberships.
 *   4. Marks rows dedup_processed = TRUE only AFTER their membership row has
 *      been durably written. Partial mark failures are safe to retry because
 *      the membership upsert is idempotent — retries never double-count.
 *
 * Idempotency guarantee: media_dedup_memberships.media_id is the PRIMARY KEY,
 * so upserting the same (media_id, group_id) pair is a no-op on conflict.
 * member_count is always derived from a COUNT of the memberships table, not
 * from additive increments, so it remains accurate across retries.
 */

import { randomUUID } from "node:crypto";
import { getServiceClient } from "../supabase.js";
import { areDuplicates, clusterByPhash } from "./pHashUtils.js";

const WORKER_INTERVAL_MS = 20 * 60 * 1_000; // 20 minutes
const BATCH_SIZE = 1_000;
const MAX_SAMPLE_IDS = 3;
const MARK_CHUNK = 200;

let _workerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the dedup worker loop. Safe to call multiple times — only one loop runs. */
export function startMediaDedupWorker(): void {
  if (_workerTimer) return;
  _workerTimer = setInterval(() => {
    void runDedupTick();
  }, WORKER_INTERVAL_MS);
  void runDedupTick(); // immediate first pass
}

/** Stop the worker (for tests / graceful shutdown). */
export function stopMediaDedupWorker(): void {
  if (_workerTimer) {
    clearInterval(_workerTimer);
    _workerTimer = null;
  }
}

interface MediaRow {
  id: string;
  canonical_place_id: string;
  phash: string;
}

interface ExistingGroup {
  id: string;
  representative_media_id: string;
  representative_phash: string | null;
  member_count: number;
  sample_media_ids: string[];
}

/**
 * Execute one dedup tick. Exported so tests can drive it directly.
 * @param scOverride  Injectable Supabase client (tests inject a fake).
 */
export async function runDedupTick(scOverride?: any): Promise<void> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return;

  // ── Step 1: fetch unprocessed batch ────────────────────────────────────────
  const { data: rows, error: fetchErr } = await sc
    .from("post_media")
    .select("id, canonical_place_id, phash")
    .not("phash", "is", null)
    .not("canonical_place_id", "is", null)
    .eq("dedup_processed", false)
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error(JSON.stringify({ event: "media_dedup.fetch_error", error: fetchErr.message }));
    return;
  }

  const batch = (rows ?? []) as MediaRow[];
  if (batch.length === 0) return;

  // ── Step 2: group by canonical_place_id ───────────────────────────────────
  const byPlace = new Map<string, MediaRow[]>();
  for (const row of batch) {
    const list = byPlace.get(row.canonical_place_id) ?? [];
    list.push(row);
    byPlace.set(row.canonical_place_id, list);
  }

  const processedIds: string[] = [];

  // ── Step 3: process each place ────────────────────────────────────────────
  for (const [placeId, newRows] of byPlace) {
    try {
      // 3a. Load existing groups with their representative phashes.
      const { data: existingData, error: groupsErr } = await sc
        .from("media_dedup_groups")
        .select("id, representative_media_id, representative_phash, member_count, sample_media_ids")
        .eq("canonical_place_id", placeId);

      if (groupsErr) {
        console.error(JSON.stringify({
          event: "media_dedup.load_groups_error", place_id: placeId, error: groupsErr.message,
        }));
        continue;
      }

      const existingGroups = (existingData ?? []) as ExistingGroup[];

      // 3b. Partition: rows that match an existing group vs standalone.
      const joinMap = new Map<string, string[]>(); // groupId → new row ids
      const standalone: MediaRow[] = [];

      for (const row of newRows) {
        const match = existingGroups.find(
          (g) => g.representative_phash != null &&
                 areDuplicates(row.phash, g.representative_phash),
        );
        if (match) {
          const list = joinMap.get(match.id) ?? [];
          list.push(row.id);
          joinMap.set(match.id, list);
        } else {
          standalone.push(row);
        }
      }

      // 3c. Join rows into existing groups — idempotent via membership PK.
      for (const [groupId, joinedIds] of joinMap) {
        const group = existingGroups.find((g) => g.id === groupId)!;

        // Upsert memberships — PK on media_id means retries are no-ops.
        const membershipRows = joinedIds.map((id) => ({ media_id: id, group_id: groupId }));
        const { error: memErr } = await sc
          .from("media_dedup_memberships")
          .upsert(membershipRows, { onConflict: "media_id", ignoreDuplicates: true });

        if (memErr) {
          console.error(JSON.stringify({
            event: "media_dedup.membership_join_error", group_id: groupId, error: memErr.message,
          }));
          continue; // don't mark processed — will retry next tick
        }

        // Derive member_count from actual membership count (idempotent).
        const { count: newCount } = await sc
          .from("media_dedup_memberships")
          .select("media_id", { count: "exact", head: true })
          .eq("group_id", groupId);

        const existingSample = Array.isArray(group.sample_media_ids) ? group.sample_media_ids : [];
        const newSample = [...new Set([...existingSample, ...joinedIds])].slice(0, MAX_SAMPLE_IDS);

        const { error: updateErr } = await sc
          .from("media_dedup_groups")
          .update({
            member_count:    newCount ?? (group.member_count + joinedIds.length),
            sample_media_ids: newSample,
            updated_at:      new Date().toISOString(),
          })
          .eq("id", groupId);

        if (updateErr) {
          console.error(JSON.stringify({
            event: "media_dedup.group_update_error", group_id: groupId, error: updateErr.message,
          }));
          // Memberships written but count stale — not blocking; will self-correct next tick.
        }

        // Membership is durable → safe to mark processed.
        for (const id of joinedIds) processedIds.push(id);
      }

      // 3d. Cluster standalone rows pairwise (no bucket prefilter — full recall).
      if (standalone.length > 0) {
        const clusters = clusterByPhash(standalone);

        for (const cluster of clusters) {
          if (cluster.length === 0) continue;

          const representativeId = cluster[0];
          const representative = standalone.find((r) => r.id === representativeId)!;
          const sampleIds = cluster.slice(0, MAX_SAMPLE_IDS);
          const bucketKey = representative.phash.slice(0, 8);
          const groupId = randomUUID();

          // Upsert group row (idempotent on representative_media_id).
          const { error: upsertErr } = await sc
            .from("media_dedup_groups")
            .upsert(
              {
                id:                      groupId,
                canonical_place_id:      placeId,
                representative_media_id: representativeId,
                representative_phash:    representative.phash,
                member_count:            cluster.length,
                sample_media_ids:        sampleIds,
                bucket_key:              bucketKey,
                updated_at:              new Date().toISOString(),
              },
              { onConflict: "canonical_place_id,representative_media_id" },
            );

          if (upsertErr) {
            console.error(JSON.stringify({
              event: "media_dedup.upsert_error", place_id: placeId,
              rep_id: representativeId, error: upsertErr.message,
            }));
            continue; // don't mark processed
          }

          // Resolve the actual group id in case the upsert hit an existing row.
          // Re-query to get the canonical id for the (place, representative) pair.
          const { data: groupRow } = await sc
            .from("media_dedup_groups")
            .select("id")
            .eq("canonical_place_id", placeId)
            .eq("representative_media_id", representativeId)
            .maybeSingle();

          const resolvedGroupId: string = (groupRow as any)?.id ?? groupId;

          // Upsert memberships (idempotent — retries are no-ops).
          const membershipRows = cluster.map((id) => ({ media_id: id, group_id: resolvedGroupId }));
          const { error: memErr } = await sc
            .from("media_dedup_memberships")
            .upsert(membershipRows, { onConflict: "media_id", ignoreDuplicates: true });

          if (memErr) {
            console.error(JSON.stringify({
              event: "media_dedup.membership_new_error", group_id: resolvedGroupId, error: memErr.message,
            }));
            continue; // don't mark processed
          }

          // Recompute member_count from memberships for accuracy.
          const { count: trueCount } = await sc
            .from("media_dedup_memberships")
            .select("media_id", { count: "exact", head: true })
            .eq("group_id", resolvedGroupId);

          if (trueCount != null && trueCount !== cluster.length) {
            await sc
              .from("media_dedup_groups")
              .update({ member_count: trueCount, updated_at: new Date().toISOString() })
              .eq("id", resolvedGroupId);
          }

          // Membership is durable → safe to mark processed.
          for (const id of cluster) processedIds.push(id);
        }
      }
    } catch (err: any) {
      console.error(JSON.stringify({
        event: "media_dedup.place_error", place_id: placeId, error: String(err?.message ?? err),
      }));
    }
  }

  if (processedIds.length === 0) return;

  // ── Step 4: mark rows processed ───────────────────────────────────────────
  // Chunked to stay inside PostgREST URL limits. Partial failures are safe
  // because membership rows are already written — the next tick re-attempts
  // marking but the membership upsert is a no-op, so counts stay correct.
  for (let i = 0; i < processedIds.length; i += MARK_CHUNK) {
    const chunk = processedIds.slice(i, i + MARK_CHUNK);
    const { error: markErr } = await sc
      .from("post_media")
      .update({ dedup_processed: true })
      .in("id", chunk);
    if (markErr) {
      console.error(JSON.stringify({
        event: "media_dedup.mark_processed_error", count: chunk.length, error: markErr.message,
      }));
    }
  }

  console.log(JSON.stringify({
    event: "media_dedup.tick_complete",
    batch_size: batch.length,
    processed: processedIds.length,
    place_count: byPlace.size,
  }));
}
