/**
 * intelFunnelReport — the tally behind report:intel-funnel (IG-09, spec §26).
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * The IG density gate (lib/intelLiveScope.evaluateDensityGate) is the promotion
 * criterion for exposing public Live labels, and the pilot-metric shaper
 * (lib/intelPilotMetrics.assemblePilotMetrics) turns raw counts into its inputs.
 * Both are BUILT and tested — and both have zero non-test callers. Nothing reads
 * the intel tables into those functions, so the promotion decision has no
 * measured inputs and the capture→projection→serve funnel is invisible: an
 * operator cannot see how many observations became claims, how many claims
 * became publishable snapshots, or WHY the rest were suppressed.
 *
 * This is the same "library built, no driver" gap the projection scheduler
 * (lib/intelProjectionScheduler) just closed for the write path. This closes it
 * for measurement: a pure tally over the intel rows, plus a conservative
 * assembly of the density-gate inputs. The script (scripts/reportIntelFunnel.ts)
 * keeps only I/O so the arithmetic can be tested against inputs whose right
 * answer is known.
 *
 * THE ONE INVARIANT, INHERITED FROM discoveryServePointReport
 * ===========================================================
 * *Absence of evidence must never silently become evidence of absence.* An empty
 * intel table means "the pipeline was not exercised here", NOT "the pipeline
 * works and found nothing" and NOT "the gate is satisfied". Every count below is
 * reported so that zero reads as zero-evidence, and the density gate is
 * fail-closed: an input this instrument cannot yet measure is treated as UNMET,
 * never as cleared. The report refuses to certify the gate on that basis.
 *
 * WHY THE SUPPRESSION REASON IS RE-DERIVED, NOT READ
 * ==================================================
 * intel_state_snapshots records privacy_eligible (a boolean) but not the gate's
 * REASON for suppressing — the projection computes a PrivacyDecision and keeps
 * only its verdict. Rather than change the write path to persist the reason
 * (a serving-adjacent migration), this instrument RE-DERIVES the decision
 * read-only: for each live-eligible claim it reconstructs the exact inputs the
 * projection's aggregator builds — distinct fresh observers AND the
 * independent-group signal (distinct group_key values and the actor-based
 * max-group share) — and calls the very same evaluatePrivacy. The check ORDER is
 * load-bearing and is preserved by calling the real gate: below the k=15 actor
 * floor a claim suppresses as `below_actor_threshold`; once it clears k, too few
 * distinct groups surface as `below_group_threshold`.
 *
 * That `below_group_threshold` splits further into the owner's operational
 * distinction (groupSignal): claims that HAVE some group identity but < 5 distinct
 * groups (insufficientGroups) vs claims with NO group_key at all
 * (groupIdentityUnavailable). Together with the party-size distribution, that tells
 * an operator whether the limiter is adoption (below_actor_threshold), the V1 party
 * model (groupIdentityUnavailable — people arrive as non-crew parties that earn no
 * group credit), or simply not-enough-independent-parties-yet (insufficientGroups).
 *
 * RUNTIME EFFECT: NONE. Pure functions over rows. No writes, no flag reads.
 */
import {
  CLAIM_STATUSES,
  CONFIDENCE_BANDS,
  LIVE_ELIGIBLE_CLAIM_STATUSES,
  MIN_BAND_FOR_LIVE_STATE,
  MODERATION_STATES,
  PARTY_SIZE_BUCKETS,
  PRIVACY_THRESHOLD_V1,
  isModerationEligible,
  type ClaimStatus,
  type ConfidenceBand,
  type ModerationState,
} from "./intelContracts.js";
import { evaluatePrivacy, type SuppressionReason } from "./privacyGate.js";
import { assemblePilotMetrics, type RawPilotCounts } from "./intelPilotMetrics.js";
import { evaluateDensityGate, type DensityGateResult, type PilotDensityMetrics } from "./intelLiveScope.js";

// ── Row shapes (only the columns this tally needs) ────────────────────────────

/** A row from intel_observations. */
export interface ObservationRow {
  actor_id?: string | null;
  subject_id?: string | null;
  claim_type?: string | null;
  moderation_state?: string | null;
  observed_at?: string | null;
  expires_at?: string | null;
  group_key?: string | null;
  party_size_bucket?: string | null;
}

/** A row from intel_claims. */
export interface ClaimRow {
  subject_id?: string | null;
  claim_type?: string | null;
  status?: string | null;
  observed_at?: string | null;
}

/** A row from intel_state_snapshots. */
export interface SnapshotRow {
  privacy_eligible?: boolean | null;
  confidence_band?: string | null;
  expires_at?: string | null;
}

/** A row from intel_confirmations. */
export interface ConfirmationRow {
  stance?: string | null;
}

export interface FunnelRows {
  /** Observations for the flow tallies (§1-§4) — legitimately windowed by observed_at. */
  observations: readonly ObservationRow[];
  /**
   * The FULL fresh cohort (expires_at null or future, NO observed_at lower bound)
   * used for the §5/§5b gate re-derivation, so it matches the aggregator, which
   * counts every fresh observation regardless of age. Omit to reuse `observations`
   * (correct only when the window covers every claim's TTL — e.g. in unit tests).
   */
  freshObservations?: readonly ObservationRow[];
  claims: readonly ClaimRow[];
  snapshots: readonly SnapshotRow[];
  confirmations: readonly ConfirmationRow[];
}

// ── The tally shapes ──────────────────────────────────────────────────────────

/**
 * A count broken out by a known enum. `unknown` holds values the enum does not
 * contain — a DEFECT IN THIS READER (the writer emits something this build has
 * not heard of), surfaced separately so it can never be folded into a real
 * bucket. Same rule as discoveryServePointReport's `unknownMarker`.
 */
export interface EnumTally {
  total: number;
  byKey: Record<string, number>;
  unknown: number;
  unknownValues: string[];
}

export interface SuppressionTally {
  /** Live-eligible claims the gate was re-run over. */
  evaluatedClaims: number;
  /** Claims the gate would publish right now. */
  publishable: number;
  /** Non-publishable claims by the gate's reason (its check order preserved). */
  byReason: Record<SuppressionReason, number>;
}

export interface IntelFunnel {
  observations: {
    tally: EnumTally;                 // by moderation_state
    /** Rows whose moderation_state is 'allowed' — the only ones that may back a claim. */
    eligibleForClaim: number;
  };
  claims: {
    tally: EnumTally;                 // by status
    /** active + conflicting — the only statuses that may be projected. */
    liveEligible: number;
  };
  snapshots: {
    total: number;
    eligible: number;                 // privacy_eligible = true
    suppressed: number;               // privacy_eligible = false
    /** eligible AND band ≥ likely_current AND not expired — what a reader could serve now. */
    servableLive: number;
    expired: number;                  // expires_at ≤ now
    bandTally: EnumTally;             // by confidence_band ('(null)' bucket for unset)
  };
  confirmations: {
    tally: EnumTally;                 // by stance
    agree: number;
    disagree: number;
    unsure: number;
  };
  contributor: {
    distinctActors: number;           // distinct actor_id over ALL observations
    topActorObservations: number;     // the busiest single actor's observation count
    /** topActorObservations / totalObservations, 0..1. 0 when there are none. */
    topActorShare: number;
  };
  /** Re-derived, read-only — see the header note on why this is not read from snapshots. */
  suppression: SuppressionTally;
  /**
   * The independent-group signal (V1). Distinguishes the two operationally
   * different reasons a claim can fail the ≥5-group requirement — the owner's
   * refinement — so an operator can tell whether the V1 party model, not adoption,
   * is the limiter.
   */
  groupSignal: {
    /** by party_size_bucket ('(null)' = not attested). "Most arrive as non-crew parties" lives here. */
    partyTally: EnumTally;
    /** Observations carrying a non-null group_key (a solo or crew identity). */
    groupEligibleObservations: number;
    /** Observations with no group_key (non-crew "with others", trail, or pre-signal). */
    nullGroupObservations: number;
    /** (A) live-eligible claims past the k=15 floor with 1..4 distinct groups — HAS identity, not enough of it. */
    insufficientGroups: number;
    /** (B) live-eligible claims past the k=15 floor with 0 distinct groups — group identity UNAVAILABLE. */
    groupIdentityUnavailable: number;
  };
}

// ── Enum-keyed counting (recognises the enum, surfaces the rest) ──────────────

function newEnumTally(keys: readonly string[]): EnumTally {
  const byKey: Record<string, number> = {};
  for (const k of keys) byKey[k] = 0;
  return { total: 0, byKey, unknown: 0, unknownValues: [] };
}

function countInto(t: EnumTally, rawValue: string | null | undefined, known: ReadonlySet<string>): void {
  t.total += 1;
  const v = rawValue == null ? "(null)" : String(rawValue);
  if (known.has(v)) {
    t.byKey[v] = (t.byKey[v] ?? 0) + 1;
  } else {
    t.unknown += 1;
    if (!t.unknownValues.includes(v)) t.unknownValues.push(v);
  }
}

const ALL_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "below_actor_threshold",
  "below_group_threshold",
  "single_group_dominates",
  "publication_delay_not_elapsed",
  "sensitive_subject",
  "invalid_input",
];

/** Freshness rule the projection uses: an observation is fresh unless already expired. */
function isFresh(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (expiresAt == null) return true;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? true : t > nowMs;
}

const LIVE_BAND_INDEX = CONFIDENCE_BANDS.indexOf(MIN_BAND_FOR_LIVE_STATE);

function bandMeetsLive(band: string | null | undefined): boolean {
  if (band == null) return false;
  const i = CONFIDENCE_BANDS.indexOf(band as ConfidenceBand);
  return i >= 0 && i >= LIVE_BAND_INDEX;
}

/**
 * Tally the whole intel funnel from already-fetched rows. Pure. `now` is
 * injected so freshness/expiry are deterministic and testable.
 */
export function tallyIntelFunnel(rows: FunnelRows, now: Date): IntelFunnel {
  const nowMs = now.getTime();

  // 1. Observations by moderation_state.
  const obsTally = newEnumTally(MODERATION_STATES);
  const knownModeration = new Set<string>(MODERATION_STATES);
  let eligibleForClaim = 0;
  // Distinct-actor counting, both citywide and per (subject, claim_type) for the
  // suppression re-derivation. Only FRESH observations feed the gate's actor
  // count, matching the projection aggregator.
  const actorObsCount = new Map<string, number>();
  // partyTally includes a '(null)' bucket so unattested captures are visible (not
  // silently dropped) — the operator needs the unattested count as a denominator.
  const partyKeys = [...(PARTY_SIZE_BUCKETS as unknown as string[]), "(null)"];
  const partyTally = newEnumTally(partyKeys);
  const knownParty = new Set<string>(partyKeys);
  let groupEligibleObservations = 0, nullGroupObservations = 0;
  for (const o of rows.observations) {
    countInto(obsTally, o.moderation_state, knownModeration);
    if (typeof o.moderation_state === "string" && isModerationEligible(o.moderation_state as ModerationState)) {
      eligibleForClaim += 1;
    }
    if (o.actor_id) actorObsCount.set(o.actor_id, (actorObsCount.get(o.actor_id) ?? 0) + 1);
    countInto(partyTally, o.party_size_bucket ?? "(null)", knownParty);
    if (o.group_key != null && o.group_key !== "") groupEligibleObservations += 1; else nullGroupObservations += 1;
  }

  // Independent-group re-derivation inputs: per (subject, claim_type), the distinct
  // actors behind each non-null group_key among FRESH observations. Built from the
  // full fresh cohort (freshObservations), NOT the observed_at-windowed set, so it
  // matches the aggregator exactly — a long-TTL claim's older-but-fresh contributors
  // are counted, and the §5/§5b verdict cannot contradict what actually published.
  const freshSet = rows.freshObservations ?? rows.observations;
  const freshActorsByClaimKey = new Map<string, Set<string>>();
  const freshGroupActorsByClaimKey = new Map<string, Map<string, Set<string>>>();
  for (const o of freshSet) {
    if (!o.subject_id || !o.claim_type || !o.actor_id || !isFresh(o.expires_at, nowMs)) continue;
    const key = JSON.stringify([o.subject_id, o.claim_type]);
    let set = freshActorsByClaimKey.get(key);
    if (!set) { set = new Set(); freshActorsByClaimKey.set(key, set); }
    set.add(o.actor_id);
    if (o.group_key != null && o.group_key !== "") {
      let groups = freshGroupActorsByClaimKey.get(key);
      if (!groups) { groups = new Map(); freshGroupActorsByClaimKey.set(key, groups); }
      let gset = groups.get(o.group_key);
      if (!gset) { gset = new Set(); groups.set(o.group_key, gset); }
      gset.add(o.actor_id);
    }
  }

  // 2. Claims by status.
  const claimTally = newEnumTally(CLAIM_STATUSES);
  const knownStatus = new Set<string>(CLAIM_STATUSES);
  const liveEligibleStatuses = new Set<string>(LIVE_ELIGIBLE_CLAIM_STATUSES);
  let liveEligible = 0;
  for (const c of rows.claims) {
    countInto(claimTally, c.status, knownStatus);
    if (typeof c.status === "string" && liveEligibleStatuses.has(c.status)) liveEligible += 1;
  }

  // 3. Snapshots.
  const bandTally = newEnumTally([...CONFIDENCE_BANDS, "(null)"]);
  const knownBand = new Set<string>([...CONFIDENCE_BANDS, "(null)"]);
  let sEligible = 0, sSuppressed = 0, sServable = 0, sExpired = 0;
  for (const s of rows.snapshots) {
    countInto(bandTally, s.confidence_band ?? "(null)", knownBand);
    const eligible = s.privacy_eligible === true;
    if (eligible) sEligible += 1; else sSuppressed += 1;
    const expired = s.expires_at != null && !isFresh(s.expires_at, nowMs);
    if (expired) sExpired += 1;
    if (eligible && !expired && bandMeetsLive(s.confidence_band)) sServable += 1;
  }

  // 4. Confirmations by stance.
  const confTally = newEnumTally(["agree", "disagree", "unsure"]);
  const knownStance = new Set<string>(["agree", "disagree", "unsure"]);
  for (const cf of rows.confirmations) countInto(confTally, cf.stance, knownStance);

  // 5. Contributor concentration (actor level — safe; the k-anon input is people).
  let topActorObservations = 0;
  for (const n of actorObsCount.values()) if (n > topActorObservations) topActorObservations = n;
  const totalObs = rows.observations.length;
  const contributor = {
    distinctActors: actorObsCount.size,
    topActorObservations,
    topActorShare: totalObs > 0 ? topActorObservations / totalObs : 0,
  };

  // 6. Suppression reasons — RE-DERIVED read-only over live-eligible claims, by
  //    calling the real gate with the same shape the projection builds. See the
  //    header note: this preserves the gate's check order, so the reason
  //    distinguishes "still below k" from "at k but missing the group signal".
  const byReason = Object.fromEntries(ALL_SUPPRESSION_REASONS.map((r) => [r, 0])) as Record<SuppressionReason, number>;
  let evaluatedClaims = 0, publishable = 0;
  let insufficientGroups = 0, groupIdentityUnavailable = 0;
  const minGroups = PRIVACY_THRESHOLD_V1.minIndependentGroups;
  for (const c of rows.claims) {
    if (typeof c.status !== "string" || !liveEligibleStatuses.has(c.status)) continue;
    if (!c.subject_id || !c.claim_type || !c.observed_at) continue;
    evaluatedClaims += 1;
    const key = JSON.stringify([c.subject_id, c.claim_type]);
    const distinctActors = freshActorsByClaimKey.get(key)?.size ?? 0;
    // Re-derive the SAME group inputs the aggregator now supplies: distinct groups
    // and actor-based max-group share over the fresh grouped observations. Always
    // finite, so the gate returns below_group_threshold (accurate) not invalid_input.
    const groups = freshGroupActorsByClaimKey.get(key);
    const distinctGroups = groups?.size ?? 0;
    let maxGroupActors = 0;
    const unionActors = new Set<string>();
    if (groups) for (const set of groups.values()) {
      for (const a of set) unionActors.add(a);
      if (set.size > maxGroupActors) maxGroupActors = set.size;
    }
    // Union denominator (distinct grouped actors), matching intelProjectionAggregator.
    const maxGroupShare = unionActors.size > 0 ? maxGroupActors / unionActors.size : 0;
    const decision = evaluatePrivacy({
      distinctActors,
      distinctGroups,
      maxGroupShare,
      observedAt: c.observed_at,
      now,
      sensitiveSubject: false,
    });
    if (decision.publishable) { publishable += 1; continue; }
    if (decision.reason) byReason[decision.reason] += 1;
    // The owner's refinement: split "not enough groups" into HAS-identity-but-thin
    // vs NO-identity. Only meaningful once the actor floor is cleared (that is when
    // below_group_threshold can fire); distinctGroups===0 means no group_key at all.
    if (decision.reason === "below_group_threshold") {
      if (distinctGroups === 0) groupIdentityUnavailable += 1;
      else if (distinctGroups < minGroups) insufficientGroups += 1;
    }
  }

  return {
    observations: { tally: obsTally, eligibleForClaim },
    claims: { tally: claimTally, liveEligible },
    snapshots: {
      total: rows.snapshots.length,
      eligible: sEligible,
      suppressed: sSuppressed,
      servableLive: sServable,
      expired: sExpired,
      bandTally,
    },
    confirmations: {
      tally: confTally,
      agree: confTally.byKey["agree"] ?? 0,
      disagree: confTally.byKey["disagree"] ?? 0,
      unsure: confTally.byKey["unsure"] ?? 0,
    },
    contributor,
    suppression: { evaluatedClaims, publishable, byReason },
    groupSignal: {
      partyTally,
      groupEligibleObservations,
      nullGroupObservations,
      insufficientGroups,
      groupIdentityUnavailable,
    },
  };
}

// ── Density gate assessment (conservative, fail-closed) ───────────────────────

/**
 * Which density-gate inputs this instrument can measure from the intel tables,
 * and which it cannot yet. An input it cannot measure is NEVER presented as
 * cleared — that is the fail-closed rule, and it is why the report refuses to
 * certify the gate even if evaluateDensityGate happened to return met.
 *
 *   MEASURED     — derived truthfully from rows.
 *   UPPER_BOUND  — derived, but larger than the true value (so it could FALSELY
 *                  clear its threshold); flagged, never trusted to clear.
 *   UNINSTRUMENTED — no data source yet; forced to its fail-closed value.
 */
export const DENSITY_INPUT_STATUS = {
  activeReliableContributorsCitywide: "UPPER_BOUND", // reliability is not modelled; distinct actors over-counts it
  qualifyingWeeklyObservations: "MEASURED",
  criticalPrivacyIncidents: "MEASURED",              // none are recorded anywhere; 0 is truthful
  minContributorsPerCluster: "UNINSTRUMENTED",       // key clusters are not defined
  minIndependentSourcesPerKeyVenueNight: "UNINSTRUMENTED",
  outcomeConfirmations: "UNINSTRUMENTED",            // outcome telemetry does not exist yet
  crowdCalibrationAccuracy: "UNINSTRUMENTED",        // no after-proof pairs collected
  expiryCorrectness: "UNINSTRUMENTED",               // serve-time expiry is not sampled
} as const;

export interface DensityGateAssessment {
  metrics: PilotDensityMetrics;
  gate: DensityGateResult;
  /** Gate inputs not yet measurable — the gate cannot be certified while any remain. */
  uninstrumented: string[];
  /** Gate inputs derived as an upper bound — a "cleared" one of these is not proven. */
  upperBound: string[];
  /**
   * The honest verdict. `met` is true ONLY if evaluateDensityGate passed AND no
   * input was uninstrumented or an unproven upper bound. Given the current data
   * sources this is always false — which is correct, not a bug.
   */
  certifiable: boolean;
}

/**
 * Assemble the density-gate inputs conservatively from the funnel and evaluate
 * the gate. `qualifyingWeeklyObservations` is passed in because the caller scopes
 * the observation window (the gate's "250 across pilot zones" is a weekly count);
 * the funnel's own observation total may cover a different window.
 */
export function assessDensityGate(
  funnel: IntelFunnel,
  opts: { qualifyingWeeklyObservations: number; criticalPrivacyIncidents?: number },
): DensityGateAssessment {
  const raw: RawPilotCounts = {
    // Upper bound: every distinct actor, not only the "reliable" ones (unmodelled).
    activeReliableContributorsCitywide: funnel.contributor.distinctActors,
    contributorsPerCluster: [],                 // uninstrumented → min 0 → fails
    qualifyingWeeklyObservations: opts.qualifyingWeeklyObservations,
    independentSourcesPerKeyVenueNight: [],     // uninstrumented → min 0 → fails
    outcomeConfirmations: 0,                    // uninstrumented → fails (< 100)
    calibrationPairs: [],                       // uninstrumented (empty → accuracy 1.0, but unproven)
    expirySamples: [],                          // uninstrumented (empty → 1.0, but unproven)
    criticalPrivacyIncidents: opts.criticalPrivacyIncidents ?? 0,
  };
  const metrics = assemblePilotMetrics(raw);
  const gate = evaluateDensityGate(metrics);

  const uninstrumented = Object.entries(DENSITY_INPUT_STATUS)
    .filter(([, s]) => s === "UNINSTRUMENTED")
    .map(([k]) => k);
  const upperBound = Object.entries(DENSITY_INPUT_STATUS)
    .filter(([, s]) => s === "UPPER_BOUND")
    .map(([k]) => k);

  // Fail-closed certification: even if the arithmetic gate passed, an
  // uninstrumented or unproven-upper-bound input means it is not certifiable.
  const certifiable = gate.met && uninstrumented.length === 0 && upperBound.length === 0;

  return { metrics, gate, uninstrumented, upperBound, certifiable };
}
