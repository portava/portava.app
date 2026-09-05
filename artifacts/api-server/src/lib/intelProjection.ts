/**
 * Claim projection (IG-04) — turns stored claims into publishable live state.
 *
 * This is the only writer of intel_state_snapshots and of its append-only
 * history, intel_state_snapshot_versions. It reads active claims for a subject,
 * scores each with the spec's confidence formula, asks the shared privacy gate
 * whether the aggregate may be published, and writes the result — TWICE: once
 * as an immutable version row (the record), once as the current-state upsert
 * (the cache readers key on).
 *
 * WHAT IT IS NOT. It does not capture anything (that is IG-03) and it does not
 * decide what a surface shows (that is lib/liveClaimRead.ts, which applies its
 * own gates on the way out). The two-sided arrangement is deliberate: a snapshot
 * written with privacy_eligible=false is inert even if a reader is buggy, and a
 * reader that filters on privacy_eligible is inert even if a writer is buggy.
 * Neither side trusts the other.
 *
 * REPLAYABILITY (unit I1; spec §1, §8, §11 Table 17, Appendix B). Every write
 * carries the full ConfidenceResult (components, penalties, raw, penalty,
 * formulaVersion), the freshness inputs, the algorithm version and the exact
 * claim versions it was computed from. lib/intelReplay.ts recomputes a stored
 * version from those inputs and reports equal/diverged. The ORDER of the two
 * writes is load-bearing: the version row is appended FIRST, and if that append
 * fails the current-state row is NOT written. A state that cannot be replayed is
 * never served — fail-closed, in the same direction as everything else here.
 *
 * FAIL-CLOSED AT EVERY STEP:
 *   * flag off, unreadable, or no client  => project nothing;
 *   * a claim whose TTL has no policy     => skipped (freshnessPolicy already
 *                                            treats unknown claim types as stale);
 *   * privacy gate says no                => the snapshot is still written, with
 *                                            privacy_eligible=false, because a
 *                                            suppressed aggregate is a fact worth
 *                                            recording; the reader will not show it;
 *   * version append fails                => that claim is skipped, the current
 *                                            state is NOT overwritten;
 *   * any error                           => that subject is skipped, not
 *                                            partially written.
 *
 * §24 LINEAGE LOGS. Every write emits one structured `intel.projection.lineage`
 * line (algorithm version, input claim versions, the version-row id, the
 * candidate counts before/after each constraint) and every subject pass emits
 * one `intel.projection.candidates` summary. No actor ids, no coordinates, no
 * media — counts and claim ids only.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import {
  scoreConfidence,
  CONFIDENCE_FORMULA_VERSION,
  type ConfidenceComponents,
  type ConfidencePenalties,
  type ConfidenceResult,
} from "./confidenceScore.js";
import { evaluatePrivacy, type PrivacyDecision, type SuppressionReason } from "./privacyGate.js";
import { expiresAt as policyExpiresAt, FRESHNESS_CURVE_VERSION } from "./freshnessPolicy.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES, SOURCE_CLASSES, type SourceClass } from "./intelContracts.js";
import { toStoredConflictState, type ConflictState, type StoredConflictState } from "./intelConflict.js";

/**
 * The projection algorithm version stamped on every snapshot and version row
 * (Table 17 `algorithm_version`). Composite on purpose: a replay that finds a
 * different string can say WHICH part moved. Bump the leading component when
 * the projection itself changes (how inputs are assembled, gated, or written);
 * the other two follow their own modules.
 *
 *   projection/2   — v1 was the in-place upsert that kept only `confidence`;
 *                    v2 persists the replay record and appends version rows.
 */
export const PROJECTION_ALGORITHM_VERSION =
  `projection/2+confidence/${CONFIDENCE_FORMULA_VERSION}+freshness/${FRESHNESS_CURVE_VERSION}`;

/** One entry of Table 17's `input_claim_versions` — the exact lineage array. */
export interface InputClaimVersion {
  claim_id: string;
  /** intel_claims.updated_at (2274); null for a row written before the column existed. */
  updated_at: string | null;
  /** intel_claims.version (2274); null for a row written before the column existed. */
  version: number | null;
  status?: string | null;
}

/**
 * §24 "candidates before/after each constraint", as counted by the aggregator
 * for one claim's observation cohort. Logged, never persisted with identities.
 */
export interface ProjectionCandidateLineage {
  /** Observations read for (subject, claim_type) in an admissible moderation state. */
  observations_total: number;
  /** ... still fresh (expires_at null or in the future). */
  after_freshness: number;
  /** ... whose actor holds valid, un-withdrawn consent. */
  after_consent: number;
  /** ... that the Table-16 family rule allowed to EXTEND the freshness clock. */
  freshness_extenders: number;
}

export interface ProjectionInput {
  claimType: string;
  value: unknown;
  /** Newest-observation timestamp — the freshness/serving clock (snapshot
   *  observed_at + TTL expiry). NOT the publication-delay clock. */
  observedAt: string;
  /**
   * STABLE anchor for the publication-delay clock (the earliest qualifying
   * observation, or when the claim first crossed the k-anon threshold). Keeping
   * this separate from `observedAt` is what stops a venue with continuous fresh
   * signals from perpetually resetting the delay and never publishing. Falls back
   * to `observedAt` when the caller does not supply it.
   */
  publicationAnchorAt?: string;
  /**
   * Absolute ceiling past which this claim may NEVER serve, however fresh the
   * newest observation is. Caps the snapshot's servable `expires_at`. Null/absent
   * means no code-side ceiling (e.g. an unknown claim type).
   */
  hardExpiresAt?: string | null;
  /** Distinct PEOPLE who contributed, counted by the caller from confirmations. */
  distinctActors: number;
  distinctGroups?: number;
  maxGroupShare?: number;
  sensitiveSubject?: boolean;
  components: Partial<ConfidenceComponents>;
  penalties?: Partial<ConfidencePenalties>;
  /**
  /**
   * The freshness inputs the aggregator derived `components.freshness` from.
   * Stored in the replay record so a replay can recompute the curve, not just
   * re-add weighted components.
   */
  freshness?: { ageSeconds: number; ttlSeconds: number };
  /** Table 17 lineage: the claim rows (with their versions) this input came from. */
  inputClaimVersions?: InputClaimVersion[];
  /** §24 candidate counts, for the lineage log line. */
  candidateLineage?: ProjectionCandidateLineage;
  /**
   * §10 material-conflict state of the cohort (lib/intelConflict), persisted
   * onto the snapshot by projectAndStore. Absent ⇒ 'none'. It never feeds the
   * score here — the aggregator already folded the penalty into `penalties`.
   */
  conflictState?: ConflictState;
  /**
   * The epistemic class of the cohort behind this claim (§5 source classes), as
   * derived by lib/intelProjectionAggregator from the observations themselves.
   * Persisted onto intel_state_snapshots.source_class (2279) so the read path
   * (lib/liveClaimRead.deriveSourceClass) can apply the truth boundary
   * (mayRenderAsLive) and the consensus-badge rule (mayCountAsConsensus) instead
   * of assuming the Phase-1 default. Absent / unrecognised ⇒ not written.
   */
  sourceClass?: SourceClass;
  /**
   * FAIL-CLOSED VALUE SUPPORT. False when the live cohort supplies NO currently
   * supported value for this claim — e.g. the cohort's most-recent values TIE
   * for the lead and the frozen anchor `claim.value` is not among them (its
   * author may have withdrawn consent). Publishing the anchor there would
   * republish an answer nobody in the live cohort gives. `projectClaim` then
   * WITHHOLDS the snapshot entirely rather than serve an unsupported value.
   * Absent ⇒ supported (hand-built inputs are unaffected).
   */
  cohortSupportsValue?: boolean;
}

/**
 * What is persisted in `confidence_components`: the ConfidenceResult verbatim
 * plus the freshness inputs. Everything lib/intelReplay needs, nothing else.
 */
export interface ConfidenceReplayRecord {
  formulaVersion: ConfidenceResult["formulaVersion"];
  raw: number;
  penalty: number;
  invalid: boolean;
  components: ConfidenceComponents;
  penalties: ConfidencePenalties;
  freshness: { ageSeconds: number; ttlSeconds: number; curve: string } | null;
}

export interface ProjectedSnapshot {
  subject_id: string;
  zone_id: string;
  claim_type: string;
  value: unknown;
  confidence: number;
  confidence_band: string;
  source_count: number;
  distinct_actors: number;
  privacy_eligible: boolean;
  observed_at: string;
  expires_at: string;
  confidence_components: ConfidenceReplayRecord;
  algorithm_version: string;
  input_claim_versions: InputClaimVersion[];
  /** Table 17 conflict_state, in the PERSISTED vocabulary the 2273 CHECKs admit
   *  ('none' | 'contextualized' | 'material'). Column added in I1; unit I2 (2275)
   *  populates it — projectClaim leaves it null and projectAndStore writes the
   *  assessed state through toStoredConflictState. */
  conflict_state: StoredConflictState | null;
}

/** One row of intel_state_snapshot_versions, as this writer inserts it. */
export interface SnapshotVersionRow extends ProjectedSnapshot {
  id: string;
  privacy_reason: SuppressionReason | null;
  generated_at: string;
}

export interface ProjectionResult {
  snapshot: ProjectedSnapshot | null;
  /** Why it is not publishable, when it is not. */
  privacy: PrivacyDecision;
  skippedReason?: "no_ttl_policy" | "invalid_input" | "value_not_supported";
  /** The full scored record, for callers that want it without re-reading the snapshot. */
  scored?: ConfidenceResult;
}

/** Build the persisted replay record from a scored result and its freshness inputs. */
export function buildReplayRecord(
  scored: ConfidenceResult,
  freshness?: { ageSeconds: number; ttlSeconds: number },
): ConfidenceReplayRecord {
  return {
    formulaVersion: scored.formulaVersion,
    raw: scored.raw,
    penalty: scored.penalty,
    invalid: scored.invalid,
    components: { ...scored.components },
    penalties: { ...scored.penalties },
    freshness:
      freshness && Number.isFinite(freshness.ageSeconds) && Number.isFinite(freshness.ttlSeconds)
        ? { ageSeconds: freshness.ageSeconds, ttlSeconds: freshness.ttlSeconds, curve: FRESHNESS_CURVE_VERSION }
        : null,
  };
}

/**
 * Project one claim. Pure apart from the TTL lookup, so it can be tested without
 * writing anything.
 */
export async function projectClaim(
  sc: SupabaseClient,
  subjectId: string,
  input: ProjectionInput,
  opts: { zoneId?: string | null; now?: Date } = {},
): Promise<ProjectionResult> {
  const now = opts.now ?? new Date();

  if (!subjectId || !input?.claimType || !input.observedAt) {
    return { snapshot: null, privacy: { publishable: false, reason: "invalid_input" }, skippedReason: "invalid_input" };
  }

  // FAIL CLOSED ON AN UNSUPPORTED VALUE. The aggregator sets this false when no
  // consented, non-withdrawn cohort member currently asserts the value that
  // would be served — the tie case, where falling back to the frozen anchor
  // republishes an answer nobody live gives (and possibly one whose author has
  // WITHDRAWN CONSENT). Withholding is the honest outcome: no snapshot, so the
  // read path degrades to 'typical'/'unknown' rather than to a resurrected value.
  if (input.cohortSupportsValue === false) {
    return { snapshot: null, privacy: { publishable: false, reason: "invalid_input" }, skippedReason: "value_not_supported" };
  }

  // A claim type with no policy has no defined lifetime; freshnessPolicy already
  // treats it as stale, so projecting it would create a snapshot that can never
  // be live. Skip rather than invent a TTL.
  let expires = await policyExpiresAt(sc, input.claimType, input.observedAt);
  if (!expires) {
    return { snapshot: null, privacy: { publishable: false, reason: "invalid_input" }, skippedReason: "no_ttl_policy" };
  }

  // Absolute hard-expiry ceiling: however fresh the newest observation is, the
  // claim may never serve past this cap. The read path only checks
  // `expires_at > now`, so capping the servable horizon here is what actually
  // stops a continuously-refreshed claim from living forever (finding 5). A
  // ceiling already in the past collapses expires_at to it, and the reader then
  // drops the row as expired.
  if (input.hardExpiresAt) {
    const hardMs = Date.parse(input.hardExpiresAt);
    if (Number.isFinite(hardMs) && hardMs < Date.parse(expires)) {
      expires = new Date(hardMs).toISOString();
    }
  }

  const scored = scoreConfidence(input.components, input.penalties);
  const privacy = evaluatePrivacy({
    distinctActors: input.distinctActors,
    distinctGroups: input.distinctGroups,
    maxGroupShare: input.maxGroupShare,
    // Publication-delay clock keyed to the STABLE anchor (earliest qualifying
    // observation), NOT the newest-observation freshness clock — otherwise a
    // venue with continuous fresh signals resets the delay forever (H3).
    observedAt: input.publicationAnchorAt ?? input.observedAt,
    now,
    sensitiveSubject: input.sensitiveSubject,
  });

  return {
    snapshot: {
      subject_id: subjectId,
      // '' (not null) for a zone-less snapshot: the unique index + PostgREST
      // onConflict target are plain columns (2176), so the key must be a
      // concrete value. Writing null made ON CONFLICT (subject_id,zone_id,
      // claim_type) fail to match the old coalesce() index (SQLSTATE 42P10).
      zone_id: opts.zoneId ?? "",
      claim_type: input.claimType,
      value: input.value,
      confidence: scored.confidence,
      confidence_band: scored.band,
      source_count: Number.isFinite(input.distinctActors) ? input.distinctActors : 0,
      distinct_actors: Number.isFinite(input.distinctActors) ? input.distinctActors : 0,
      privacy_eligible: privacy.publishable,
      observed_at: new Date(input.observedAt).toISOString(),
      expires_at: expires,
      // Replay record (§8 "store every component"): the whole ConfidenceResult,
      // never just the number, plus the freshness inputs behind it.
      confidence_components: buildReplayRecord(scored, input.freshness),
      algorithm_version: PROJECTION_ALGORITHM_VERSION,
      // Exact lineage (Table 17). An input assembled without claim identity
      // (tests, ad-hoc callers) records an empty array — honest, not invented.
      input_claim_versions: Array.isArray(input.inputClaimVersions) ? input.inputClaimVersions : [],
      conflict_state: null,
    },
    privacy,
    scored,
  };
}

/**
 * Project and persist. For each claim: append ONE immutable row to
 * intel_state_snapshot_versions (the record), then upsert the current state on
 * (subject_id, zone_id, claim_type), matching the unique index in 2130/2176 — a
 * subject has one CURRENT snapshot per claim, and the history lives in the
 * version table. If the version append fails, the current state is left
 * untouched: a state we cannot replay is never served.
 */
export async function projectAndStore(
  sc: SupabaseClient,
  subjectId: string,
  inputs: readonly ProjectionInput[],
  opts: { zoneId?: string | null; now?: Date } = {},
): Promise<{ written: number; suppressed: number; skipped: number }> {
  const tally = { written: 0, suppressed: 0, skipped: 0 };
  if (!sc || !subjectId || !inputs?.length) return tally;
  if (!(await isFlagEnabled(sc, "intel_claim_projection_crowd"))) return tally;

  const now = opts.now ?? new Date();
  const zoneId = opts.zoneId ?? "";
  // §24 candidates before/after each hard constraint, for this subject pass.
  const funnel = { candidates: inputs.length, after_ttl_policy: 0, after_version_append: 0, after_privacy_gate: 0 };

  for (const input of inputs) {
    try {
      const r = await projectClaim(sc, subjectId, input, { ...opts, now });
      if (!r.snapshot) {
        tally.skipped++;
        logger.info(
          { event: "intel.projection.candidate_dropped", subject_id: subjectId, zone_id: zoneId, claim_type: input.claimType, constraint: r.skippedReason ?? "unknown", algorithm_version: PROJECTION_ALGORITHM_VERSION },
          "intel projection: candidate dropped before scoring",
        );
        continue;
      }
      funnel.after_ttl_policy++;

      // conflict_state (2275) rides alongside the projected row: the §10 state
      // the aggregator assessed for this cohort, 'none' when the caller did not
      // assess one. The read path treats NULL/absent as 'none' too.
      //
      // TRANSLATED to the PERSISTED vocabulary. Both CHECKs (2273) admit only
      // ('none','contextualized','material'); the in-memory middle state is
      // spelled 'minor'. Writing it raw failed the CHECK, and because the
      // version append below is the FIRST write and its failure skips the
      // current-state upsert, every cohort in mild disagreement silently stopped
      // projecting. normalizeConflictState reads 'contextualized' back as
      // 'minor', so nothing downstream changes.
      const snapshotRow = { ...r.snapshot, conflict_state: toStoredConflictState(input.conflictState ?? "none") };

      // 1. The record: append the immutable version row FIRST.
      // NOTE: intel_state_snapshot_versions (2273) has NO source_class column,
      // so the class below is written to the CURRENT-STATE row only. Adding it
      // to the history needs a migration and is deliberately not done here.
      const version: SnapshotVersionRow = {
        id: randomUUID(),
        ...snapshotRow,
        privacy_reason: r.privacy.reason,
        generated_at: now.toISOString(),
      };
      const { error: versionError } = await sc.from("intel_state_snapshot_versions").insert(version);
      if (versionError) {
        tally.skipped++;
        logger.warn(
          { err: versionError, subject_id: subjectId, zone_id: zoneId, claim_type: input.claimType },
          "intelProjection: version append failed; current state NOT written (fail-closed)",
        );
        continue;
      }
      funnel.after_version_append++;

      // 2. The cache: the current-state row readers key on. The cohort's source
      // class (2279 intel_state_snapshots.source_class) travels with it so
      // lib/liveClaimRead can apply mayRenderAsLive / mayCountAsConsensus to a
      // REAL class instead of the Phase-1 default — a wholly sponsored (disclosed
      // commercial) cohort must not wear an independent-consensus badge. Only a
      // canonical SOURCE_CLASSES value is written; anything else is omitted, and
      // the reader then falls back to its own default.
      const currentRow: Record<string, unknown> = { ...snapshotRow };
      if (input.sourceClass && (SOURCE_CLASSES as readonly string[]).includes(input.sourceClass)) {
        currentRow.source_class = input.sourceClass;
      }
      const { error } = await sc
        .from("intel_state_snapshots")
        .upsert(currentRow, { onConflict: "subject_id,zone_id,claim_type" });
      if (error) {
        tally.skipped++;
        logger.warn({ err: error, version_id: version.id }, "intelProjection: upsert failed");
        continue;
      }
      if (r.snapshot.privacy_eligible) { tally.written++; funnel.after_privacy_gate++; } else { tally.suppressed++; }

      // §24: projection lineage + algorithm version, one line per write. Counts
      // and claim ids only — never actor ids, coordinates or media.
      logger.info(
        {
          event: "intel.projection.lineage",
          version_id: version.id,
          subject_id: subjectId,
          zone_id: zoneId,
          claim_type: input.claimType,
          algorithm_version: PROJECTION_ALGORITHM_VERSION,
          input_claim_versions: r.snapshot.input_claim_versions,
          confidence: r.snapshot.confidence,
          confidence_band: r.snapshot.confidence_band,
          privacy_eligible: r.snapshot.privacy_eligible,
          privacy_reason: r.privacy.reason,
          expires_at: r.snapshot.expires_at,
          candidates: input.candidateLineage ?? null,
        },
        "intel projection lineage",
      );
    } catch (err) {
      tally.skipped++;
      logger.warn({ err }, "intelProjection: projection threw");
    }
  }

  logger.info(
    { event: "intel.projection.candidates", subject_id: subjectId, zone_id: zoneId, algorithm_version: PROJECTION_ALGORITHM_VERSION, ...funnel, suppressed: tally.suppressed, skipped: tally.skipped },
    "intel projection: candidates before/after constraints",
  );
  return tally;
}

/** Statuses a claim must hold to be projected at all. */
export const PROJECTABLE_STATUSES = LIVE_ELIGIBLE_CLAIM_STATUSES;
