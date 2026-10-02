/**
 * The canonical Memory object — the typed contract for the provenance spine.
 *
 * WHAT THIS IS
 * ------------
 * Migration 2320 adds two tables that together answer the one question nothing
 * in Portava could answer before: **what happened, and how do we know**.
 *
 *   memory_episodes  — a BOUNDED OCCURRENCE. It has an extent, a place, an
 *                      owner, a deterministic detection reason code, and a
 *                      detector version, so detection is replayable.
 *   memory_evidence  — what that episode RESTS ON. Append-only, each row citing
 *                      one canonical source at one truth level.
 *
 * This module is the TypeScript side of that contract: the vocabularies (as
 * const arrays, so they cannot drift from the CHECK constraints without a diff),
 * the row and domain types, total parsers that refuse rather than guess, and the
 * assembled `MemoryEpisode` object. The lifecycle machine lives next door in
 * memoryEpisodeLifecycle.ts, as data.
 *
 * WHAT THIS IS NOT
 * ----------------
 * There is no writer here, and there is no reader wired into any route,
 * producer, scheduler or surface. `readEpisode` exists so the refusal semantics
 * are specified and tested; nothing calls it. The spine is INERT BY
 * CONSTRUCTION — RLS deny-default, service_role-only grants, no flag flipped,
 * `memory_projection` still false. A Memory cannot yet be produced, and that is
 * the current, intended state.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE
 * ----------------------------------------
 * **Raw sensing must not automatically become Memory.** A detector may propose
 * candidates freely; nothing becomes Memory without passing through an
 * outcome/significance assessment. That is enforced three times over, on purpose:
 * by a CHECK constraint in 2320, by the lifecycle machine's `not_significant`
 * refusal, and by `isEligibleForMemory` below. The database is the enforcement;
 * these are the explanation and the early refusal.
 *
 * A FAILED READ NEVER FABRICATES AN EPISODE
 * -----------------------------------------
 * `readEpisode` returns a discriminated union, following the better of the two
 * patterns already in the memory lane (lib/mapProducers/memoryProducer.ts's
 * `MemoryReadResult`, rather than PassportRemembersService's silent-empty). A
 * transport error, a missing row, and a row that fails to parse are three
 * DIFFERENT outcomes and are reported as three different outcomes. None of them
 * is an episode, and none of them is an empty episode with defaults filled in:
 * an episode nobody can prove is not a Memory.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  INITIAL_EPISODE_STATE,
  UNSCORED_EPISODE_STATES,
  isEpisodeState,
  type EpisodeState,
} from "./memoryEpisodeLifecycle.js";

export {
  EPISODE_STATES,
  EPISODE_TRANSITIONS,
  TERMINAL_EPISODE_STATES,
  UNSCORED_EPISODE_STATES,
  INITIAL_EPISODE_STATE,
  canTransition,
  decideTransition,
  isEpisodeState,
  nextStates,
  type EpisodeState,
  type TransitionContext,
  type TransitionDecision,
  type TransitionRefusal,
} from "./memoryEpisodeLifecycle.js";

/** Table names, so a typo is a compile error in one place rather than a silent empty read. */
export const EPISODES_TABLE = "memory_episodes";
export const EVIDENCE_TABLE = "memory_evidence";

/* ───────────────────────────── Vocabularies ─────────────────────────────── */
/*
 * Each array below is the exact literal set of the matching CHECK constraint in
 * 2320. They are duplicated in TS deliberately and narrowly: the repo's
 * enumLiteralGuard / writeLiteralGuard tests exist because a TS literal that the
 * database cannot hold is a dead query (22P02), and the only way to check that
 * statically is to have the set written down on both sides.
 */

/** What kind of occurrence this was. */
export const EPISODE_KINDS = [
  "visit",
  "stay",
  "meal",
  "activity",
  "journey",
  "gathering",
  "milestone",
] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

/**
 * Why a detector concluded the episode exists. A CODE, never prose: the reason
 * must be comparable across runs, or detection is not auditable.
 */
export const DETECTION_REASONS = [
  "user_declared",
  "dwell_cluster",
  "checkin_sequence",
  "media_cluster",
  "plan_completion",
  "contribution_outcome",
  "manual_curation",
] as const;
export type DetectionReason = (typeof DETECTION_REASONS)[number];

/**
 * How significance was established. The presence of one of these — never a bare
 * signal — is what makes an occurrence eligible to become Memory.
 */
export const SIGNIFICANCE_BASES = [
  "user_affirmed",
  "outcome_recorded",
  "rarity",
  "corroborated",
  "sustained_duration",
  "social_shared",
] as const;
export type SignificanceBasis = (typeof SIGNIFICANCE_BASES)[number];

/**
 * How well we know it — a certainty ordering, weakest last. This is the axis
 * §6 needs and that nothing in the existing kernel carries.
 */
export const TRUTH_LEVELS = ["asserted", "observed", "corroborated", "inferred"] as const;
export type TruthLevel = (typeof TRUTH_LEVELS)[number];

/**
 * The class of source. This is the EXISTING provenance vocabulary, verbatim from
 * memory_events.source (migration 2183). A second, competing vocabulary here
 * would be exactly the duplication the memory spec §24 forbids.
 */
export const SOURCE_CLASSES = ["explicit", "system", "inferred", "live"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/** Privacy axes, matching memory_projections (2183/2192). */
export const EPISODE_SENSITIVITIES = ["normal", "sensitive"] as const;
export type EpisodeSensitivity = (typeof EPISODE_SENSITIVITIES)[number];

export const EPISODE_VISIBILITIES = ["private", "circle", "public"] as const;
export type EpisodeVisibility = (typeof EPISODE_VISIBILITIES)[number];

/**
 * The six retention classes. These are memory_policy's DATA (migration 2192) and
 * memory_episodes.retention_class is a FOREIGN KEY to it — this array is the
 * read-side mirror, not a second source of truth.
 */
export const RETENTION_CLASSES = [
  "ephemeral",
  "short_lived",
  "trip_context",
  "durable_fact",
  "derived_preference",
  "historical_contribution",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/* ─────────────────────────────── Domain types ───────────────────────────── */

/** One piece of evidence an episode rests on. Immutable by contract and by trigger. */
export interface MemoryEvidence {
  readonly id: string;
  readonly episodeId: string;
  readonly userId: string;
  readonly truthLevel: TruthLevel;
  readonly sourceClass: SourceClass;
  /** The canonical table this evidence cites. */
  readonly sourceTable: string;
  /** The id within that table. Text, because canonical keys are not all uuids. */
  readonly sourceId: string;
  readonly sourceRef: Readonly<Record<string, unknown>>;
  /** When the evidence is ABOUT. Distinct from when it was recorded. */
  readonly observedAt: string | null;
  readonly recordedAt: string;
  readonly weight: number;
}

/** How detection reached this episode. The replay identity. */
export interface EpisodeDetection {
  readonly reason: DetectionReason;
  readonly version: number;
  /** Digest of the detector's inputs. Null for a user-declared episode. */
  readonly digest: string | null;
}

/** The significance assessment, when one has been made. */
export interface EpisodeSignificance {
  readonly score: number;
  readonly basis: SignificanceBasis;
}

/** A bounded occurrence: what happened, when, where, for whom, and on what basis. */
export interface MemoryEpisode {
  readonly id: string;
  readonly userId: string;
  readonly kind: EpisodeKind;
  readonly summary: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly placeId: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly detection: EpisodeDetection;
  /** Null until something has assessed why this matters. Null ⇒ not Memory. */
  readonly significance: EpisodeSignificance | null;
  readonly state: EpisodeState;
  readonly stateChangedAt: string;
  readonly mergedIntoId: string | null;
  readonly sensitivity: EpisodeSensitivity;
  readonly visibility: EpisodeVisibility;
  readonly retentionClass: RetentionClass;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ─────────────────────────────── Parsers ────────────────────────────────── */

function oneOf<T extends string>(vocab: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (vocab as readonly string[]).includes(v) ? (v as T) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function finiteNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Parse a database row into a `MemoryEpisode`, or return null.
 *
 * Total and fail-closed. Every branch that returns null is a row this code
 * cannot vouch for, and a row it cannot vouch for is not turned into an episode
 * with plausible defaults. Notably: an unrecognised `state` is a refusal rather
 * than a fallback to `candidate` — silently downgrading an unknown state would
 * make a future state look like an unpromoted signal.
 */
export function parseEpisodeRow(row: unknown): MemoryEpisode | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;

  const id = str(r.id);
  const userId = str(r.user_id);
  const kind = oneOf(EPISODE_KINDS, r.episode_kind);
  const startedAt = str(r.started_at);
  const reason = oneOf(DETECTION_REASONS, r.detection_reason);
  const version = finiteNum(r.detector_version);
  const state = isEpisodeState(r.state) ? r.state : null;
  const sensitivity = oneOf(EPISODE_SENSITIVITIES, r.sensitivity);
  const visibility = oneOf(EPISODE_VISIBILITIES, r.visibility);
  const retentionClass = oneOf(RETENTION_CLASSES, r.retention_class);

  if (
    id === null ||
    userId === null ||
    kind === null ||
    startedAt === null ||
    reason === null ||
    version === null ||
    version < 1 ||
    state === null ||
    sensitivity === null ||
    visibility === null ||
    retentionClass === null
  ) {
    return null;
  }

  const endedAt = nullableStr(r.ended_at);
  // A bounded occurrence that ends before it starts is not an occurrence.
  if (endedAt !== null && endedAt < startedAt) return null;

  // Significance is present only when BOTH halves are: a score with no basis is
  // an unexplained number, and a basis with no score is an unquantified claim.
  const score = finiteNum(r.significance);
  const basis = oneOf(SIGNIFICANCE_BASES, r.significance_basis);
  const significance: EpisodeSignificance | null =
    score !== null && basis !== null && score >= 0 && score <= 1 ? { score, basis } : null;

  // The eligibility invariant, checked on the way IN as well as on the way out:
  // a row claiming a promoted state without a significance assessment is
  // corrupt (2320's CHECK makes it unwritable), so it is refused rather than
  // surfaced as a Memory nobody can justify.
  if (!UNSCORED_EPISODE_STATES.has(state) && significance === null) return null;

  const mergedIntoId = nullableStr(r.merged_into_id);
  // A merge names its survivor, and only a merge may.
  if (state === "merged" && mergedIntoId === null) return null;
  if (state !== "merged" && mergedIntoId !== null) return null;
  if (mergedIntoId !== null && mergedIntoId === id) return null;

  return {
    id,
    userId,
    kind,
    summary: nullableStr(r.summary),
    startedAt,
    endedAt,
    placeId: nullableStr(r.place_id),
    city: nullableStr(r.city),
    country: nullableStr(r.country),
    detection: { reason, version, digest: nullableStr(r.detection_digest) },
    significance,
    state,
    stateChangedAt: nullableStr(r.state_changed_at) ?? startedAt,
    mergedIntoId,
    sensitivity,
    visibility,
    retentionClass,
    createdAt: nullableStr(r.created_at) ?? startedAt,
    updatedAt: nullableStr(r.updated_at) ?? startedAt,
  };
}

/** Parse an evidence row, or return null. Same fail-closed discipline. */
export function parseEvidenceRow(row: unknown): MemoryEvidence | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;

  const id = str(r.id);
  const episodeId = str(r.episode_id);
  const userId = str(r.user_id);
  const truthLevel = oneOf(TRUTH_LEVELS, r.truth_level);
  const sourceClass = oneOf(SOURCE_CLASSES, r.source_class);
  const sourceTable = str(r.source_table);
  const sourceId = str(r.source_id);
  const recordedAt = str(r.recorded_at);

  if (
    id === null ||
    episodeId === null ||
    userId === null ||
    truthLevel === null ||
    sourceClass === null ||
    sourceTable === null ||
    sourceId === null ||
    recordedAt === null
  ) {
    return null;
  }

  const rawWeight = finiteNum(r.weight);
  // Out-of-range weight is a refusal, not a clamp: clamping would invent a
  // number the writer never asserted.
  if (rawWeight !== null && (rawWeight < 0 || rawWeight > 1)) return null;

  const ref = r.source_ref;
  const sourceRef: Record<string, unknown> =
    typeof ref === "object" && ref !== null && !Array.isArray(ref)
      ? (ref as Record<string, unknown>)
      : {};

  return {
    id,
    episodeId,
    userId,
    truthLevel,
    sourceClass,
    sourceTable,
    sourceId,
    sourceRef,
    observedAt: nullableStr(r.observed_at),
    recordedAt,
    weight: rawWeight ?? 1,
  };
}

/* ───────────────────────────── The eligibility rule ─────────────────────── */

/**
 * May this occurrence become Memory?
 *
 * The single sentence this whole unit exists to make true: **a signal is not a
 * Memory**. An occurrence is eligible only when something has assessed WHY it
 * matters — a recorded outcome, a corroboration, a user affirming it, a rarity.
 * Detection alone, however confident the detector, is never enough.
 *
 * Evidence is required too: an episode with no evidence rests on nothing, and
 * "how do we know" is the question this object exists to answer.
 */
export function isEligibleForMemory(
  episode: MemoryEpisode,
  evidence: readonly MemoryEvidence[],
): boolean {
  if (episode.significance === null) return false;
  if (evidence.length === 0) return false;
  // Evidence must belong to this episode. A caller passing someone else's
  // evidence should not be able to make an unsupported episode eligible.
  return evidence.every((e) => e.episodeId === episode.id && e.userId === episode.userId);
}

/* ───────────────────────────── Reads that refuse ────────────────────────── */

/**
 * The outcome of trying to read one episode. Three failures, three names — a
 * caller must not be able to confuse "the database is down" with "there is no
 * such episode", and neither may become an episode.
 */
export type EpisodeReadResult =
  | { readonly ok: true; readonly episode: MemoryEpisode }
  | { readonly ok: false; readonly reason: "read_failed"; readonly detail: string }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "unparsable" };

/**
 * Read a single episode by id for its owner.
 *
 * NOTHING CALLS THIS. It exists so the refusal semantics of the contract are
 * specified and provable before any writer exists. Whatever eventually reads the
 * spine inherits this shape: on failure it returns a REASON, never a fabricated
 * or partially defaulted episode, and never throws — a thrown error inside a
 * surface assembler is how a group silently vanishes (see the 42703 incident
 * recorded in PassportRemembersService).
 */
export async function readEpisode(
  client: Pick<SupabaseClient, "from">,
  userId: string,
  episodeId: string,
): Promise<EpisodeReadResult> {
  if (!userId || !episodeId) return { ok: false, reason: "not_found" };
  try {
    const { data, error } = await client
      .from(EPISODES_TABLE)
      .select("*")
      .eq("user_id", userId)
      .eq("id", episodeId)
      .maybeSingle();
    if (error) return { ok: false, reason: "read_failed", detail: String(error.message ?? error) };
    if (data === null || data === undefined) return { ok: false, reason: "not_found" };
    const episode = parseEpisodeRow(data);
    if (episode === null) return { ok: false, reason: "unparsable" };
    return { ok: true, episode };
  } catch (e) {
    return { ok: false, reason: "read_failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The outcome of reading an episode's evidence. */
export type EvidenceReadResult =
  | { readonly ok: true; readonly evidence: readonly MemoryEvidence[]; readonly skipped: number }
  | { readonly ok: false; readonly reason: "read_failed"; readonly detail: string };

/**
 * Read the evidence an episode rests on.
 *
 * A read error is a REFUSAL, not an empty list: "we could not check what this
 * rests on" and "this rests on nothing" must never be the same answer, because
 * `isEligibleForMemory` treats the second as disqualifying. Rows that fail to
 * parse are dropped and COUNTED in `skipped`, so a caller can tell a clean read
 * from a partially understood one.
 */
export async function readEvidence(
  client: Pick<SupabaseClient, "from">,
  userId: string,
  episodeId: string,
): Promise<EvidenceReadResult> {
  try {
    const { data, error } = await client
      .from(EVIDENCE_TABLE)
      .select("*")
      .eq("user_id", userId)
      .eq("episode_id", episodeId);
    if (error) return { ok: false, reason: "read_failed", detail: String(error.message ?? error) };
    if (!Array.isArray(data)) {
      return { ok: false, reason: "read_failed", detail: "evidence read returned a non-array" };
    }
    const evidence: MemoryEvidence[] = [];
    let skipped = 0;
    for (const row of data) {
      const parsed = parseEvidenceRow(row);
      if (parsed === null) skipped += 1;
      else evidence.push(parsed);
    }
    return { ok: true, evidence, skipped };
  } catch (e) {
    return { ok: false, reason: "read_failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The state a newly detected occurrence must start in. Exported as a function
 * rather than inlined so a writer cannot accidentally start one anywhere else.
 */
export function initialEpisodeState(): EpisodeState {
  return INITIAL_EPISODE_STATE;
}
