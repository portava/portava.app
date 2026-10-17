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
import {
  acknowledgeEpisodeCheckpoint, readDeadLetterSnapshot, readRetryDetail, saveEpisodeCheckpoint,
  type EpisodeCheckpoint, type EpisodeCheckpointState,
} from "./memoryDeletionDeadLetters.js";

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
  input: {
    ownerId: string; episodeIds: readonly string[]; now: Date; memoryId?: string;
    checkpoints?: readonly EpisodeCheckpoint[];
    checkpointState?: EpisodeCheckpointState;
    /**
     * `retire_first` (the deletion lifecycle): the link row is the only way back
     * from the Memory to its episode, so the episode is retired before the link
     * is purged, and a failed purge is retried with the link still there.
     * `purge_first` (a Keep that found its Memory deleted, which has NO link to
     * follow): purge, then retire. A failed purge leaves the episode `confirmed`,
     * so the inbox keeps it in front of the owner and the next Keep — refused by
     * the deleted Memory, not by the episode state — retries the purge. Retiring
     * first there would orphan the evidence under a tombstone nothing revisits.
     */
    order?: "retire_first" | "purge_first";
  },
): Promise<EvidenceErasureOutcome> {
  const episodes = [...new Set(input.episodeIds)];
  if (episodes.length === 0) return { state: "done", episodes, retired: 0, purged: 0 };
  try {
    const retireFirst = new Set(episodes);
    if (input.order === "purge_first") {
      retireFirst.clear();
      for (const episodeId of episodes) {
        const link = await readMemoryLink(sc, input.ownerId, episodeId, input.memoryId);
        if (link.state !== "done") return link;
        if (link.id !== null) retireFirst.add(episodeId);
      }
      for (const checkpoint of input.checkpoints ?? []) {
        if (episodes.includes(checkpoint.episodeId)) retireFirst.add(checkpoint.episodeId);
      }
    }
    const retired = await retire(sc, input.ownerId, [...retireFirst], input.now);
    if (retired.state !== "done") return retired;
    let purged = 0;
    for (const episodeId of episodes) {
      const result = await purge(sc, input.ownerId, episodeId, retireFirst.has(episodeId), input.now,
        input.memoryId, input.checkpoints?.find((checkpoint) => checkpoint.episodeId === episodeId), input.checkpointState);
      if (result.state !== "done") return result;
      purged += result.count;
    }
    const retireLast = episodes.filter((episodeId) => !retireFirst.has(episodeId));
    const retirementCheckpoints: EpisodeCheckpoint[] = [];
    if (input.memoryId) {
      for (const episodeId of retireLast) {
        const saved = await saveEpisodeCheckpoint(sc, { ownerId: input.ownerId, memoryId: input.memoryId, episodeId, now: input.now });
        if (!saved.ok) return { state: "failed", detail: saved.detail, episodes };
        rememberCheckpoint(input.checkpointState, saved.checkpoint);
        retirementCheckpoints.push(saved.checkpoint);
      }
    }
    const retiredLast = await retire(sc, input.ownerId, retireLast, input.now);
    if (retiredLast.state !== "done") return retiredLast;
    for (const checkpoint of retirementCheckpoints) {
      const empty = await confirmEvidenceEmpty(sc, input.ownerId, checkpoint.episodeId, null);
      if (empty.state !== "done") return empty;
      const acknowledged = await acknowledgeEpisodeCheckpoint(sc, {
        ownerId: input.ownerId, memoryId: input.memoryId!, checkpoint, now: input.now,
      });
      if (!acknowledged.ok) return { state: "failed", detail: acknowledged.detail, episodes };
      forgetCheckpoint(input.checkpointState, checkpoint);
    }
    return { state: "done", episodes, retired: retired.count + retiredLast.count, purged };
  } catch (error) {
    return { state: "failed", detail: `memory evidence erasure: ${error instanceof Error ? error.message : String(error)}`, episodes };
  }
}

type StepFailure = Exclude<EvidenceErasureOutcome, { state: "done" }>;
type StepOutcome = { state: "done"; count: number } | StepFailure;

function rememberCheckpoint(state: EpisodeCheckpointState | undefined, checkpoint: EpisodeCheckpoint): void {
  if (!state) return;
  state.required = true;
  state.checkpoints = state.checkpoints.filter((entry) => entry.episodeId !== checkpoint.episodeId);
  state.checkpoints.push(checkpoint);
}

function forgetCheckpoint(state: EpisodeCheckpointState | undefined, checkpoint: EpisodeCheckpoint): void {
  if (state) state.checkpoints = state.checkpoints.filter((entry) => entry.episodeId !== checkpoint.episodeId || entry.token !== checkpoint.token);
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

function isIdRows(data: unknown): data is Array<{ id: string }> {
  return Array.isArray(data) && data.every((row) =>
    isRecord(row) && typeof row.id === "string" && row.id.length > 0)
    && new Set(data.map((row) => row.id)).size === data.length;
}

async function retire(sc: SupabaseClient, ownerId: string, episodes: string[], now: Date): Promise<StepOutcome> {
  if (episodes.length === 0) return { state: "done", count: 0 };
  const { data: retiredRows, error: retireErr } = await sc
    .from("memory_episodes")
    .update({ state: "deleted", state_changed_at: now.toISOString(), ...RETIRED_EPISODE_CLEARED })
    .eq("user_id", ownerId)
    .in("id", episodes)
    .select("id");
  if (retireErr) {
    if (isTableAbsentError(retireErr)) return { state: "absent", detail: `memory_episodes: ${retireErr.message}` };
    return { state: "failed", detail: `memory_episodes retire: ${retireErr.message}`, episodes };
  }
  if (!isIdRows(retiredRows) || retiredRows.some((row) => !episodes.includes(row.id))) {
    return { state: "failed", detail: "memory_episodes retire: malformed mutation response", episodes };
  }
  let count = 0;
  for (const episodeId of episodes) {
    const { data, error } = await sc.from("memory_episodes")
      .select(`id, user_id, state, ${Object.keys(RETIRED_EPISODE_CLEARED).join(", ")}`)
      .eq("user_id", ownerId).eq("id", episodeId).maybeSingle();
    if (error) return { state: "failed", detail: `memory_episodes retirement confirmation: ${error.message}`, episodes };
    const episode: unknown = data;
    if (episode === null) continue;
    if (!isRecord(episode) || episode.id !== episodeId || episode.user_id !== ownerId
      || episode.state !== "deleted" || Object.keys(RETIRED_EPISODE_CLEARED).some((field) => episode[field] !== null)) {
      return { state: "failed", detail: "memory_episodes retirement confirmation: episode is not retired and scrubbed", episodes };
    }
    count++;
  }
  return { state: "done", count };
}

async function readMemoryLink(
  sc: SupabaseClient, ownerId: string, episodeId: string, memoryId?: string,
): Promise<{ state: "done"; id: string | null; memoryId: string | null } | StepFailure> {
  const episodes = [episodeId];
  let query = sc.from("memory_evidence").select("id, user_id, episode_id, source_table, source_id")
    .eq("user_id", ownerId).eq("episode_id", episodeId).eq("source_table", "memories");
  if (memoryId !== undefined) query = query.eq("source_id", memoryId);
  const { data, error } = await query.order("id", { ascending: true }).limit(1);
  if (error) return { state: "failed", detail: `memory_evidence retry link read: ${error.message}`, episodes };
  if (!isIdRows(data) || data.length > 1 || data.some((row) => {
    const link = row as Record<string, unknown>;
    return link.user_id !== ownerId || link.episode_id !== episodeId || link.source_table !== "memories"
      || typeof link.source_id !== "string" || link.source_id.length === 0 || (memoryId !== undefined && link.source_id !== memoryId);
  })) return { state: "failed", detail: "memory_evidence retry link read: malformed link", episodes };
  if (data.length === 0 && memoryId !== undefined) return readMemoryLink(sc, ownerId, episodeId);
  return { state: "done", id: data[0]?.id ?? null, memoryId: data.length > 0 ? (data[0] as Record<string, unknown>).source_id as string : null };
}

async function confirmEvidenceEmpty(sc: SupabaseClient, ownerId: string, episodeId: string, retainedId: string | null): Promise<StepOutcome> {
  let query = sc.from("memory_evidence").select("id").eq("user_id", ownerId).eq("episode_id", episodeId);
  if (retainedId !== null) query = query.neq("id", retainedId);
  const { data, error } = await query.limit(1);
  if (error) return { state: "failed", detail: `memory_evidence purge confirmation: ${error.message}`, episodes: [episodeId] };
  if (!Array.isArray(data) || data.length !== 0) {
    return { state: "failed", detail: "memory_evidence purge confirmation: evidence is not confirmed empty", episodes: [episodeId] };
  }
  return { state: "done", count: 0 };
}

async function purge(sc: SupabaseClient, ownerId: string, episodeId: string, retirementConfirmed: boolean, now: Date, memoryId?: string, checkpoint?: EpisodeCheckpoint, checkpointState?: EpisodeCheckpointState): Promise<StepOutcome> {
  const episodes = [episodeId];
  const link = await readMemoryLink(sc, ownerId, episodeId, memoryId);
  if (link.state !== "done") return link;
  if (link.id !== null && !retirementConfirmed) {
    return { state: "failed", detail: "memory_evidence purge: retry link appeared before retirement", episodes };
  }
  let query = sc.from("memory_evidence").delete().eq("user_id", ownerId).eq("episode_id", episodeId);
  query = link.id === null ? query.neq("source_table", "memories") : query.neq("id", link.id);
  const { data: purgedRows, error: purgeErr } = await query.select("id");
  if (purgeErr) {
    if (isTableAbsentError(purgeErr)) return { state: "absent", detail: `memory_evidence: ${purgeErr.message}` };
    return { state: "failed", detail: `memory_evidence purge: ${purgeErr.message}`, episodes };
  }
  if (!isIdRows(purgedRows) || purgedRows.some((row) => row.id === link.id)) {
    return { state: "failed", detail: "memory_evidence purge: malformed mutation response", episodes };
  }
  const empty = await confirmEvidenceEmpty(sc, ownerId, episodeId, link.id);
  if (empty.state !== "done") return empty;
  if (link.id === null && !checkpoint) return { state: "done", count: purgedRows.length };
  const checkpointMemory = memoryId ?? link.memoryId;
  if (!checkpointMemory) return { state: "failed", detail: "episode checkpoint has no Memory identity", episodes };
  const saved = await saveEpisodeCheckpoint(sc, { ownerId, memoryId: checkpointMemory, episodeId, now, expectedToken: checkpoint?.token });
  if (!saved.ok) return { state: "failed", detail: saved.detail, episodes };
  rememberCheckpoint(checkpointState, saved.checkpoint);
  let linksPurged = 0;
  if (link.id !== null) {
    const { data: linkRows, error: linkErr } = await sc.from("memory_evidence").delete()
      .eq("user_id", ownerId).eq("episode_id", episodeId).eq("id", link.id).eq("source_table", "memories").select("id");
    if (linkErr) return { state: "failed", detail: `memory_evidence retry link purge: ${linkErr.message}`, episodes };
    if (!isIdRows(linkRows) || linkRows.some((row) => row.id !== link.id)) {
      return { state: "failed", detail: "memory_evidence retry link purge: malformed mutation response", episodes };
    }
    linksPurged = linkRows.length;
  }
  const allEmpty = await confirmEvidenceEmpty(sc, ownerId, episodeId, null);
  if (allEmpty.state !== "done") return allEmpty;
  const acknowledged = await acknowledgeEpisodeCheckpoint(sc, { ownerId, memoryId: checkpointMemory, checkpoint: saved.checkpoint, now });
  if (!acknowledged.ok) return { state: "failed", detail: acknowledged.detail, episodes };
  forgetCheckpoint(checkpointState, saved.checkpoint);
  return { state: "done", count: purgedRows.length + linksPurged };
}

const EVIDENCE_ERASURE_BATCH_SIZE = 100;
const MAX_EVIDENCE_ERASURE_BATCHES = 100;
const EPISODE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §21 RAW_EVIDENCE_PURGED for one Memory. Never throws for a resolved error. */
export async function eraseEvidenceForMemory(
  sc: SupabaseClient,
  input: { ownerId: string; memoryId: string; now: Date; checkpointState?: EpisodeCheckpointState },
): Promise<EvidenceErasureOutcome> {
  const episodes = new Set<string>();
  let retired = 0;
  let purged = 0;
  const failed = (detail: string): EvidenceErasureOutcome => ({ state: "failed", detail, episodes: [...episodes] });
  try {
    const { prior, error } = await readDeadLetterSnapshot(sc, input.memoryId, input.ownerId);
    if (error) return failed(`episode checkpoint read: ${String(error.message ?? "unavailable")}`);
    const parsed = readRetryDetail(prior?.detail ?? "");
    if (!parsed.ok) return failed(parsed.detail);
    if (input.checkpointState?.required && (!prior || !parsed.versioned)) return failed("episode checkpoint receipt was lost after a confirmed save");
    if (input.checkpointState && parsed.versioned) {
      input.checkpointState.required = true;
      input.checkpointState.checkpoints = parsed.checkpoints;
    }
    for (const checkpoint of parsed.checkpoints) {
      episodes.add(checkpoint.episodeId);
      const resumed = await retireEpisodesAndPurgeEvidence(sc, {
        ownerId: input.ownerId, memoryId: input.memoryId, now: input.now,
        episodeIds: [checkpoint.episodeId], checkpoints: [checkpoint], checkpointState: input.checkpointState,
      });
      if (resumed.state !== "done") return failed(resumed.detail);
      retired += resumed.retired;
      purged += resumed.purged;
    }
  } catch (error) {
    return failed(`episode checkpoint read threw: ${String(error instanceof Error ? error.message : error)}`);
  }
  for (let batch = 0; ; batch++) {
    const { data, error } = await sc
      .from("memory_evidence")
      .select("episode_id")
      .eq("user_id", input.ownerId)
      .eq("source_table", "memories")
      .eq("source_id", input.memoryId)
      .limit(EVIDENCE_ERASURE_BATCH_SIZE);
    if (error) {
      if (batch === 0 && isTableAbsentError(error)) return { state: "absent", detail: `memory_evidence: ${error.message}` };
      return failed(`memory_evidence link read: ${error.message}`);
    }
    if (!Array.isArray(data) || data.length > EVIDENCE_ERASURE_BATCH_SIZE || data.some((row) =>
      !row || typeof row !== "object" || Array.isArray(row) || typeof row.episode_id !== "string" || !EPISODE_ID_PATTERN.test(row.episode_id))) {
      return failed("memory_evidence link read: malformed episode links");
    }
    if (data.length === 0) return { state: "done", episodes: [...episodes], retired, purged };
    if (batch >= MAX_EVIDENCE_ERASURE_BATCHES) return failed("memory_evidence link read: erasure batch limit reached");
    const episodeIds = [...new Set(data.map((row) => row.episode_id))];
    if (episodeIds.some((id) => episodes.has(id))) return failed("memory_evidence link remains after purge");
    const erased = await retireEpisodesAndPurgeEvidence(sc, { ownerId: input.ownerId, episodeIds, now: input.now, memoryId: input.memoryId, checkpointState: input.checkpointState });
    if (erased.state === "absent") return failed(erased.detail);
    for (const id of episodeIds) episodes.add(id);
    if (erased.state === "failed") return failed(erased.detail);
    retired += erased.retired;
    purged += erased.purged;
  }
}
