/**
 * memoryEvidenceErasure — §21's RAW_EVIDENCE_PURGED for ONE Memory, on the
 * provenance spine migration 2320 actually creates.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1 §21
 *       "DELETION_REQUESTED → PUBLIC_REVOKED → DERIVATIVES_PURGED →
 *        RAW_EVIDENCE_PURGED → DELETED"; §3.6 memory_evidence; §7 the candidate
 *       inbox whose kept candidates are the only Memories that HAVE evidence.
 *
 * CENSUS: H52 (deletion lifecycle), H190 ("purge canonical/eligible evidence").
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
 * The lifecycle's step 4 deleted `memory_evidence WHERE memory_id = <id>`.
 * 2320's memory_evidence has NO `memory_id` column: evidence hangs off an
 * EPISODE (`episode_id`), and a kept candidate names its Memory with one
 * EXPLICIT evidence row (`source_table = 'memories'`, `source_id = <memory id>`,
 * written by episodeCandidates.confirmCandidate). So on any database where 2320
 * is applied the purge was a 42703, retried three times and dead-lettered on
 * EVERY Memory deletion — and the captures that made the Memory, plus the link
 * naming it, survived the deletion. Before 2320 the same query read as "table
 * absent", which is why nothing ever noticed.
 *
 * ── WHAT ERASING A MEMORY'S EVIDENCE MEANS ───────────────────────────────────
 *   1. FIND the episodes this Memory was kept from: the owner's evidence rows
 *      whose source is this Memory. A Memory nobody kept from a candidate has
 *      none, and "nothing to purge" is then TRUE (the read succeeded).
 *   2. RETIRE each such episode FIRST: state → `deleted` (a terminal state the
 *      lifecycle machine admits from every live state, and one the 2320
 *      eligibility CHECK exempts), with everything that describes the
 *      occurrence beyond its time window cleared — summary, place, city,
 *      country, significance. The window, kind and detector replay key stay,
 *      as a tombstone: storeCandidate suppresses any later detection that
 *      overlaps a `deleted` episode, so the same photos are never proposed
 *      again after their Memory was deleted (lane H proposed ruling H-1).
 *   3. PURGE every evidence row of those episodes — the captures and the link.
 *
 * WHY RETIRE BEFORE PURGE. The link row is the only way back from a Memory to
 * its episode. Purging first and failing to retire would leave a `confirmed`
 * episode with no link, which the inbox shows as an interrupted Keep — and
 * Keep again would rebuild the very Memory the owner deleted. Retiring first,
 * a failed purge is retried and finds the link still there; a failed retire is
 * retried before anything is lost.
 *
 * Account deletion does not come through here: erase_memory_for_user (2320)
 * deletes every episode and every evidence row of the user by user_id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

export type EvidenceErasureOutcome =
  /** The reads and writes ran. `episodes` may be empty: a Memory with no candidate behind it. */
  | { state: "done"; episodes: string[]; retired: number; purged: number }
  /** The spine is not deployed on this database (42P01 / PGRST205 only). */
  | { state: "absent"; detail: string }
  /** The spine exists and a read or write failed. Retryable. */
  | { state: "failed"; detail: string; episodes: string[] };

/** The occurrence-describing columns a retired episode keeps no trace of. */
export const RETIRED_EPISODE_CLEARED = {
  summary: null,
  place_id: null,
  city: null,
  country: null,
  significance: null,
  significance_basis: null,
  merged_into_id: null,
} as const;

/**
 * Retire episodes and purge their evidence — the shared second half, also used
 * when a Keep finds that the Memory it would finish was deleted.
 * Owner-scoped on every statement: an id that is not this owner's changes nothing.
 */
export async function retireEpisodesAndPurgeEvidence(
  sc: SupabaseClient,
  input: { ownerId: string; episodeIds: readonly string[]; now: Date },
): Promise<EvidenceErasureOutcome> {
  const episodes = [...new Set(input.episodeIds)];
  if (episodes.length === 0) return { state: "done", episodes, retired: 0, purged: 0 };

  const { data: retiredRows, error: retireErr } = await sc
    .from("memory_episodes")
    .update({ state: "deleted", state_changed_at: input.now.toISOString(), ...RETIRED_EPISODE_CLEARED })
    .eq("user_id", input.ownerId)
    .in("id", episodes)
    .select("id");
  if (retireErr) {
    if (isTableAbsentError(retireErr)) return { state: "absent", detail: `memory_episodes: ${retireErr.message}` };
    return { state: "failed", detail: `memory_episodes retire: ${retireErr.message}`, episodes };
  }

  const { data: purgedRows, error: purgeErr } = await sc
    .from("memory_evidence")
    .delete()
    .eq("user_id", input.ownerId)
    .in("episode_id", episodes)
    .select("id");
  if (purgeErr) {
    if (isTableAbsentError(purgeErr)) return { state: "absent", detail: `memory_evidence: ${purgeErr.message}` };
    return { state: "failed", detail: `memory_evidence purge: ${purgeErr.message}`, episodes };
  }

  return {
    state: "done",
    episodes,
    retired: Array.isArray(retiredRows) ? retiredRows.length : 0,
    purged: Array.isArray(purgedRows) ? purgedRows.length : 0,
  };
}

/** §21 RAW_EVIDENCE_PURGED for one Memory. Never throws for a resolved error. */
export async function eraseEvidenceForMemory(
  sc: SupabaseClient,
  input: { ownerId: string; memoryId: string; now: Date },
): Promise<EvidenceErasureOutcome> {
  const { data, error } = await sc
    .from("memory_evidence")
    .select("episode_id")
    .eq("user_id", input.ownerId)
    .eq("source_table", "memories")
    .eq("source_id", input.memoryId);
  if (error) {
    if (isTableAbsentError(error)) return { state: "absent", detail: `memory_evidence: ${error.message}` };
    return { state: "failed", detail: `memory_evidence link read: ${error.message}`, episodes: [] };
  }
  const episodeIds = ((data as Array<{ episode_id: string }> | null) ?? []).map((r) => r.episode_id);
  return retireEpisodesAndPurgeEvidence(sc, { ownerId: input.ownerId, episodeIds, now: input.now });
}
