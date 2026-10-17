import { randomUUID } from "node:crypto";

export const EVIDENCE_STORE_REQUIRED = "[memory-evidence:v1:required] ";
export const EVIDENCE_STORE_ABSENT = "[memory-evidence:v1:absent] ";
export const DEAD_LETTER_DETAIL_MAX = 4000;
export const MAX_DEAD_LETTER_WRITE_ATTEMPTS = 3;
export const MAX_EPISODE_CHECKPOINTS = 32;
const CHECKPOINT_PREFIX = "[memory-episodes:v1] ";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeadLetterError { code?: unknown; message?: unknown }
export interface EpisodeCheckpoint { episodeId: string; token: string }
export interface EpisodeCheckpointState { required: boolean; checkpoints: EpisodeCheckpoint[] }
export interface DeadLetterSnapshot {
  memory_id: string;
  owner_id: string;
  detail: string;
  letters: number;
  first_failed_at: string;
  last_failed_at: string;
  resolved_at: string | null;
}

type RetryDetail = { ok: true; required: boolean; checkpoints: EpisodeCheckpoint[]; diagnostic: string; versioned: boolean }
  | { ok: false; detail: string };

export function readRetryDetail(detail: string): RetryDetail {
  const required = !detail.startsWith(EVIDENCE_STORE_ABSENT);
  const marker = required ? EVIDENCE_STORE_REQUIRED : EVIDENCE_STORE_ABSENT;
  const remainder = detail.startsWith(marker) ? detail.slice(marker.length) : detail;
  const invalid: RetryDetail = { ok: false, detail: "malformed or unsupported episode checkpoint" };
  if (detail.startsWith("[memory-evidence:") && !detail.startsWith(EVIDENCE_STORE_REQUIRED) && !detail.startsWith(EVIDENCE_STORE_ABSENT)) return invalid;
  if (!remainder.startsWith("[memory-episodes:")) {
    if (detail.includes("[memory-episodes")) return invalid;
    return { ok: true, required, checkpoints: [], diagnostic: remainder, versioned: false };
  }
  if (!detail.startsWith(EVIDENCE_STORE_REQUIRED) || !remainder.startsWith(CHECKPOINT_PREFIX)) return invalid;
  const end = remainder.indexOf("\n");
  if (end < 0) return invalid;
  try {
    const values: unknown = JSON.parse(remainder.slice(CHECKPOINT_PREFIX.length, end));
    if (!Array.isArray(values) || values.length > MAX_EPISODE_CHECKPOINTS) return invalid;
    const checkpoints: EpisodeCheckpoint[] = [];
    for (const value of values) {
      if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== "string" || !UUID_PATTERN.test(part))
        || checkpoints.some((checkpoint) => checkpoint.episodeId === value[0])) return invalid;
      checkpoints.push({ episodeId: value[0], token: value[1] });
    }
    return { ok: true, required: true, checkpoints, diagnostic: remainder.slice(end + 1), versioned: true };
  } catch {
    return invalid;
  }
}

export function writeRetryDetail(required: boolean, checkpoints: readonly EpisodeCheckpoint[], diagnostic: string, versioned = false): string {
  if (checkpoints.length > MAX_EPISODE_CHECKPOINTS) throw new Error("episode checkpoint capacity exhausted");
  const prefix = (required || checkpoints.length > 0 || versioned ? EVIDENCE_STORE_REQUIRED : EVIDENCE_STORE_ABSENT)
    + (versioned || checkpoints.length > 0 ? `${CHECKPOINT_PREFIX}${JSON.stringify(checkpoints.map(({ episodeId, token }) => [episodeId, token]))}\n` : "");
  if (prefix.length > DEAD_LETTER_DETAIL_MAX) throw new Error("episode checkpoint exceeds detail capacity");
  return prefix + diagnostic.slice(0, DEAD_LETTER_DETAIL_MAX - prefix.length);
}

export async function readDeadLetterSnapshot(sc: any, memoryId: string, ownerId: string): Promise<{ prior: DeadLetterSnapshot | null; error: DeadLetterError | null }> {
  const { data, error } = await sc.from("memory_deletion_dead_letters")
    .select("memory_id, owner_id, detail, letters, first_failed_at, last_failed_at, resolved_at")
    .eq("memory_id", memoryId).maybeSingle();
  if (error) return { prior: null, error };
  if (data === null) return { prior: null, error: null };
  if (!data || typeof data !== "object" || Array.isArray(data)
    || data.memory_id !== memoryId || data.owner_id !== ownerId || typeof data.detail !== "string" || data.detail.length > DEAD_LETTER_DETAIL_MAX
    || !Number.isSafeInteger(data.letters) || data.letters < 1 || data.letters >= 2147483647
    || typeof data.first_failed_at !== "string" || !Number.isFinite(Date.parse(data.first_failed_at))
    || typeof data.last_failed_at !== "string" || !Number.isFinite(Date.parse(data.last_failed_at))
    || Date.parse(data.last_failed_at) < Date.parse(data.first_failed_at)
    || (data.resolved_at !== null && (typeof data.resolved_at !== "string" || !Number.isFinite(Date.parse(data.resolved_at))))) {
    return { prior: null, error: { message: "malformed or mismatched deletion retry state" } };
  }
  return { prior: { ...data }, error: null };
}

export function matchingDeadLetter(query: any, prior: DeadLetterSnapshot): any {
  const matched = query.eq("memory_id", prior.memory_id).eq("owner_id", prior.owner_id)
    .eq("letters", prior.letters).eq("last_failed_at", prior.last_failed_at);
  return prior.resolved_at === null ? matched.is("resolved_at", null) : matched.eq("resolved_at", prior.resolved_at);
}

type CheckpointResult = { ok: true; checkpoint: EpisodeCheckpoint } | { ok: false; detail: string };

export async function saveEpisodeCheckpoint(
  sc: any, input: { memoryId: string; ownerId: string; episodeId: string; now: Date; expectedToken?: string },
): Promise<CheckpointResult> {
  const checkpoint = { episodeId: input.episodeId, token: randomUUID() };
  if (!UUID_PATTERN.test(input.memoryId) || !UUID_PATTERN.test(input.episodeId)) return { ok: false, detail: "invalid episode checkpoint identity" };
  try {
    for (let attempt = 0; attempt < MAX_DEAD_LETTER_WRITE_ATTEMPTS; attempt++) {
      const { prior, error } = await readDeadLetterSnapshot(sc, input.memoryId, input.ownerId);
      if (error) return { ok: false, detail: `episode checkpoint read: ${String(error.message ?? "unavailable")}` };
      const parsed = readRetryDetail(prior?.detail ?? EVIDENCE_STORE_REQUIRED);
      if (!parsed.ok) return parsed;
      if (input.expectedToken !== undefined && !parsed.checkpoints.some((entry) => entry.episodeId === input.episodeId && entry.token === input.expectedToken)) {
        return { ok: false, detail: "episode checkpoint changed or was lost before cleanup" };
      }
      const checkpoints = parsed.checkpoints.filter((entry) => entry.episodeId !== input.episodeId);
      if (checkpoints.length >= MAX_EPISODE_CHECKPOINTS) return { ok: false, detail: "episode checkpoint capacity exhausted" };
      checkpoints.push(checkpoint);
      const nowIso = new Date(Math.max(input.now.getTime(), prior ? Date.parse(prior.last_failed_at) : input.now.getTime())).toISOString();
      const values = {
        detail: writeRetryDetail(true, checkpoints, parsed.diagnostic, true),
        letters: (prior?.letters ?? 0) + 1,
        last_failed_at: nowIso,
        resolved_at: null,
      };
      const query = prior ? matchingDeadLetter(sc.from("memory_deletion_dead_letters").update(values), prior)
        : sc.from("memory_deletion_dead_letters").upsert({
          ...values, memory_id: input.memoryId, owner_id: input.ownerId, failed_steps: ["RAW_EVIDENCE_PURGED"],
          reached_state: null, lifecycle_version: "memory-deletion@1", first_failed_at: nowIso,
        }, { onConflict: "memory_id", ignoreDuplicates: true });
      const { data, error: writeError } = await query.select("memory_id");
      if (writeError) return { ok: false, detail: `episode checkpoint write: ${String(writeError.message ?? "unavailable")}` };
      if (!Array.isArray(data) || data.length > 1 || (data.length === 1 && data[0]?.memory_id !== input.memoryId)) {
        return { ok: false, detail: "episode checkpoint write returned malformed confirmation" };
      }
      if (data.length === 1) return { ok: true, checkpoint };
    }
    return { ok: false, detail: "episode checkpoint changed concurrently; save unconfirmed after bounded retries" };
  } catch (error) {
    return { ok: false, detail: `episode checkpoint save threw: ${String(error instanceof Error ? error.message : error)}` };
  }
}

export async function acknowledgeEpisodeCheckpoint(
  sc: any, input: { memoryId: string; ownerId: string; checkpoint: EpisodeCheckpoint; now: Date },
): Promise<{ ok: boolean; detail: string }> {
  try {
    for (let attempt = 0; attempt < MAX_DEAD_LETTER_WRITE_ATTEMPTS; attempt++) {
      const { prior, error } = await readDeadLetterSnapshot(sc, input.memoryId, input.ownerId);
      if (error) return { ok: false, detail: `episode checkpoint acknowledgment read: ${String(error.message ?? "unavailable")}` };
      if (!prior) return { ok: false, detail: "episode checkpoint was lost before acknowledgment" };
      const parsed = readRetryDetail(prior.detail);
      if (!parsed.ok) return parsed;
      if (!parsed.checkpoints.some((entry) => entry.episodeId === input.checkpoint.episodeId && entry.token === input.checkpoint.token)) {
        return { ok: false, detail: "episode checkpoint changed or was lost before acknowledgment" };
      }
      const checkpoints = parsed.checkpoints.filter((entry) => entry.episodeId !== input.checkpoint.episodeId);
      const { data, error: writeError } = await matchingDeadLetter(sc.from("memory_deletion_dead_letters").update({
        detail: writeRetryDetail(true, checkpoints, parsed.diagnostic, true),
        letters: prior.letters + 1,
        last_failed_at: new Date(Math.max(input.now.getTime(), Date.parse(prior.last_failed_at))).toISOString(),
      }), prior).select("memory_id");
      if (writeError) return { ok: false, detail: `episode checkpoint acknowledgment write: ${String(writeError.message ?? "unavailable")}` };
      if (!Array.isArray(data) || data.length > 1 || (data.length === 1 && data[0]?.memory_id !== input.memoryId)) {
        return { ok: false, detail: "episode checkpoint acknowledgment returned malformed confirmation" };
      }
      if (data.length === 1) return { ok: true, detail: "" };
    }
    return { ok: false, detail: "episode checkpoint changed concurrently; acknowledgment unconfirmed after bounded retries" };
  } catch (error) {
    return { ok: false, detail: `episode checkpoint acknowledgment threw: ${String(error instanceof Error ? error.message : error)}` };
  }
}
