import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EVIDENCE_NORMALIZER_VERSION, ELIGIBILITY_POLICY_VERSION, normalizeEvidence,
  evaluateEligibility, stableStringify, type NormalizedEvidence,
} from "../memoryProjections/evidence.js";
import {
  EPISODE_DETECTOR_VERSION, detectEpisodes, featureFromEvidence,
} from "../memoryProjections/episodeDetection.js";

export const MEMORY_SNAPSHOT_ENGINES = Object.freeze({
  normalizer: EVIDENCE_NORMALIZER_VERSION,
  eligibility: ELIGIBILITY_POLICY_VERSION,
  detector: EPISODE_DETECTOR_VERSION,
});

export type MemorySnapshotFailure = "invalid_snapshot" | "unsupported_version" | "not_found" | "not_deployed" | "feature_disabled" | "unavailable" | "conflict";
export type MemorySnapshotResult<Value> = { ok: true; value: Value } | { ok: false; reason: MemorySnapshotFailure };

const timestamp = z.string().min(1).refine((value) => Number.isFinite(Date.parse(value)));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stringSet = z.array(z.string().min(1)).max(1000).transform((values) => [...new Set(values)].sort());
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json),
]));
const signal = z.object({
  owner_id: z.string().uuid(), source_type: z.string().min(1), source_id: z.string().min(1),
  assertion_type: z.string().min(1), observed_at: timestamp,
  observed_timezone: z.string().nullable().optional(),
  assertion_json: z.record(json).nullable().optional(), confidence: z.number().finite().optional(),
  provenance_json: z.record(json).nullable().optional(), expires_at: timestamp.nullable().optional(),
}).strict();

export const memorySnapshotSourceSchema = z.object({
  memory_id: z.string().uuid(), owner_id: z.string().uuid(), source_version: z.string().min(1),
  source_token: digest, captured_at: timestamp, command_cursor: z.string().regex(/^\d+$/).nullable(),
  facts: z.object({
    title: z.string().nullable(), caption: z.string().nullable(), original_language: z.string().min(1),
    starts_at: timestamp.nullable(), ends_at: timestamp.nullable(), place_id: z.string().nullable(),
    location_city: z.string().nullable(), location_country: z.string().nullable(),
  }).strict(),
  signals: z.array(signal).max(500),
  detector_context: z.object({
    visited_place_ids: stringSet, user_splits: stringSet, user_merges: stringSet,
    thresholds: z.object({
      time_gap_minutes: z.number().finite().positive().optional(),
      geo_transition_km: z.number().finite().positive().optional(),
      participant_overlap_min: z.number().min(0).max(1).optional(),
      activity_change_min_gap_minutes: z.number().finite().nonnegative().optional(),
    }).strict(),
  }).strict(),
  eligibility_context: z.object({
    mode: z.enum(["AUTOMATIC", "USER_INITIATED"]), suppressed_classes: stringSet,
    existing_fingerprints: stringSet.optional(), sensitive_place_ids: stringSet.optional(),
    min_dwell_seconds: z.number().finite().nonnegative().optional(),
    significance_tier: z.enum(["AUTO_PRIVATE", "SUGGESTED", "NO_CANDIDATE"]).optional(),
  }).strict(),
}).strict();

export type MemorySnapshotSource = z.infer<typeof memorySnapshotSourceSchema>;
export interface MemorySnapshot {
  schema_version: 1;
  engine_versions: typeof MEMORY_SNAPSHOT_ENGINES;
  source: MemorySnapshotSource;
  content_hash: string;
}

function bounded(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 2_000_000; } catch { return false; }
}

function normalizedSource(source: MemorySnapshotSource): MemorySnapshotResult<NormalizedEvidence[]> {
  const evidence: NormalizedEvidence[] = [];
  const identities = new Set<string>();
  for (const raw of source.signals) {
    const identity = `${raw.source_type}:${raw.source_id}`;
    if (raw.owner_id !== source.owner_id || identities.has(identity)
      || (raw.expires_at && Date.parse(raw.expires_at) <= Date.parse(source.captured_at))) {
      return { ok: false, reason: "invalid_snapshot" };
    }
    identities.add(identity);
    const result = normalizeEvidence(raw, new Date(source.captured_at));
    if (!result.ok) return { ok: false, reason: "invalid_snapshot" };
    evidence.push(result.evidence);
  }
  if ([...source.detector_context.user_splits, ...source.detector_context.user_merges].some((identity) => !identities.has(identity))) {
    return { ok: false, reason: "invalid_snapshot" };
  }
  return { ok: true, value: evidence };
}

function hashSnapshot(value: Omit<MemorySnapshot, "content_hash">): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function buildMemorySnapshot(input: unknown): MemorySnapshotResult<MemorySnapshot> {
  if (!bounded(input)) return { ok: false, reason: "invalid_snapshot" };
  const parsed = memorySnapshotSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_snapshot" };
  const source = parsed.data;
  source.signals.sort((left, right) => {
    const first = stableStringify(left), second = stableStringify(right);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const evidence = normalizedSource(source);
  if (!evidence.ok) return evidence;
  const snapshot = { schema_version: 1 as const, engine_versions: { ...MEMORY_SNAPSHOT_ENGINES }, source };
  return { ok: true, value: { ...snapshot, content_hash: hashSnapshot(snapshot) } };
}

export function parseMemorySnapshot(input: unknown): MemorySnapshotResult<MemorySnapshot> {
  if (!bounded(input) || !input || typeof input !== "object") return { ok: false, reason: "invalid_snapshot" };
  const envelope = input as Record<string, unknown>;
  if (envelope.schema_version !== 1 || stableStringify(envelope.engine_versions) !== stableStringify(MEMORY_SNAPSHOT_ENGINES)) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (Object.keys(envelope).sort().join(",") !== "content_hash,engine_versions,schema_version,source") return { ok: false, reason: "invalid_snapshot" };
  const built = buildMemorySnapshot(envelope.source);
  if (!built.ok) return built;
  if (built.value.content_hash !== envelope.content_hash) return { ok: false, reason: "invalid_snapshot" };
  return built;
}

export function replayMemorySnapshot(input: unknown) {
  const parsed = parseMemorySnapshot(input);
  if (!parsed.ok) return parsed;
  const source = parsed.value.source;
  const normalized = normalizedSource(source);
  if (!normalized.ok) return normalized;
  const detector = source.detector_context;
  const eligibility = source.eligibility_context;
  return {
    ok: true as const,
    value: {
      facts: source.facts,
      source_version: source.source_version,
      command_cursor: source.command_cursor,
      engine_versions: parsed.value.engine_versions,
      evidence: normalized.value,
      detection: detectEpisodes(normalized.value.map(featureFromEvidence), {
        thresholds: detector.thresholds, visited_place_ids: new Set(detector.visited_place_ids),
        user_splits: new Set(detector.user_splits), user_merges: new Set(detector.user_merges),
      }),
      eligibility: evaluateEligibility(normalized.value, {
        ...eligibility, suppressed_classes: new Set(eligibility.suppressed_classes),
        existing_fingerprints: new Set(eligibility.existing_fingerprints),
        sensitive_place_ids: new Set(eligibility.sensitive_place_ids),
      }),
    },
  };
}
