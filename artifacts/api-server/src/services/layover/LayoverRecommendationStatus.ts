/**
 * LayoverRecommendationStatus — the spec's RecommendationStatus, risk band and contract on every card, the
 * visible-but-unavailable BLOCKED card, and VERSIONED SUPERSESSION instead of a cleared citation.
 *
 * Spec §4 `layover_recommendations (... status, plan_json, utility_score, risk_band, confidence, expires_at)`
 * (census-layover L26); §4.1 `RecommendationStatus = ELIGIBLE | TIGHT | BLOCKED | STALE | EXPIRED` (L38); §6.1
 * `if risk_band == UNSAFE: recommendation.status = BLOCKED` (L50); §5 `* → DISRUPTED ... Invalidate stale
 * recommendations; replan; preserve audit trail` (L44); §11.1 step 6 "Invalidate recommendations whose snapshot is
 * stale or no longer feasible" (L97). Storage: migration 3871 (columns + layover_recommendation_supersessions), behind
 * `layover_recommendation_status_enabled` (seeded FALSE there).
 *
 * Owner decisions (2026-10-18), verbatim: "A blocked recommendation should remain visible as unavailable with a clear
 * explanation, where doing so does not disclose restricted information. A recommendation must never bypass a safety
 * restriction through an alternative API route. Unknown critical safety inputs fail closed. Stale recommendations must
 * be invalidated by marking them superseded, preserving their history and reason."
 *
 * ── ONE DERIVATION, NO NEW THRESHOLD ─────────────────────────────────────────────────────────────────────────────
 * `classifyCard` reads only what the engine already certified for the card — `assess`'s rating and its stated terms
 * (LayoverSafetyEngine), the §8 map band `bandCandidates` cut from the certified envelope, the session record's
 * verdict / landside gate / temporal conflict, and `riskBandFor` (the session band LayoverDecisionStore persists on
 * layover_return_plans). Every branch returns a constant chosen by one of those values:
 *   landside:  no usable window ⇒ UNSAFE (no_usable_window); landside closed (verdict no / stay_airside / a closed
 *              gate) ⇒ UNSAFE (landside_closed); outside the certified envelope (band BLOCKED) ⇒ UNSAFE
 *              (outside_certified_envelope); rating not_recommended ⇒ UNSAFE (journey_not_measured /
 *              duration_not_stated when a term is unstated — "unknown critical inputs fail closed" — else
 *              unsafe_return_risk); rating airport_only ⇒ UNSAFE (landside_closed); possible_but_risky or band TIGHT
 *              ⇒ at least MODERATE; safe ⇒ LOW; and never better than the SESSION's band (an entry_unverified or
 *              tight session cannot hold a LOW landside card).
 *   airside:   not_recommended ⇒ UNSAFE (duration_not_stated / unsafe_return_risk); possible_but_risky ⇒ MODERATE;
 *              safe ⇒ LOW. The session's landside gate does not touch an airside card.
 *   status:    LOW ⇒ ELIGIBLE; MODERATE / HIGH ⇒ TIGHT (tight_return); UNSAFE ⇒ BLOCKED — the §8 map bands (SAFE = LOW,
 *              TIGHT = MODERATE/HIGH, BLOCKED) and §6.1's invariant, which 3871's CHECK also enforces in the table.
 * HIGH is in the vocabulary and no branch produces it: nothing this engine certifies distinguishes "high" from
 * "moderate", and inventing the split would be a threshold nobody measured.
 *
 * ── A REASON IS A CODE, AND ITS SENTENCE DISCLOSES NOTHING RESTRICTED ──────────────────────────────────────────────
 * `status_reason` is a code from STATUS_REASONS; the sentence served beside it is the fixed text there. None names
 * another traveller, a moderation decision, a restricted area or a place's private detail — only what the
 * traveller's own certified window says about the card.
 *
 * ── SUPERSESSION (L44, L97) ───────────────────────────────────────────────────────────────────────────────────────
 * `supersedeCards` replaces the citation CLEAR lane B1-P built: for every card of the session made stale by a newer
 * stored snapshot (it cites another one) or made infeasible (the plan stop it became no longer fits), it appends ONE
 * immutable row to layover_recommendation_supersessions (the card's decision evidence as it stood, the snapshot it
 * cited, the superseding snapshot and its 3623 version, the reasons, the cause) and THEN marks the card SUPERSEDED
 * (status, reason code, superseded_by_snapshot_id, superseded_at) — its citation, risk band, plan and deadline are
 * left exactly as they were. The mark is a compare-and-set on `superseded_at IS NULL` and on the citation it read, so
 * a card re-certified or superseded meanwhile is left alone. Nothing is deleted.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { isMissingSchemaError } from "../../lib/capability/schemaCapability.js";
import type { LayoverFeasibilityRecord } from "../airport/LayoverFeasibility.js";
import type { SafetyAssessment } from "../airport/LayoverSafetyEngine.js";
import { landsideStatusOf } from "../airport/LayoverConstraints.js";
import { cardObjective, LAYOVER_OBJECTIVE_VERSION, type ObjectiveCard, type ObjectiveLiveReading } from "../airport/layoverObjective.js";
import { riskBandFor, recommendationSnapshotStamp, type RiskBand, type RecommendationSnapshotStamp } from "./LayoverDecisionStore.js";

const logger = rootLogger.child({ service: "LayoverRecommendationStatus" });

/** Seeded FALSE by migration 3871. Read as a literal at `recommendationStatusEnabled` for check:flag-polarity. */
export const RECOMMENDATION_STATUS_FLAG = "layover_recommendation_status_enabled";

/** §4.1, verbatim. */
export const SPEC_RECOMMENDATION_STATUSES = ["ELIGIBLE", "TIGHT", "BLOCKED", "STALE", "EXPIRED"] as const;
/** §4.1 plus the owner's SUPERSEDED (2026-10-18) — exactly 3871's CHECK. */
export const RECOMMENDATION_STATUSES = [...SPEC_RECOMMENDATION_STATUSES, "SUPERSEDED"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** The only statuses a card may be ADDED, OFFERED or COUNTED as reachable under. */
export const AVAILABLE_RECOMMENDATION_STATUSES: ReadonlySet<string> = new Set<RecommendationStatus>(["ELIGIBLE", "TIGHT"]);

/** Every reason code a card can carry, and the one sentence served for it. Nothing restricted is in any of them. */
export const STATUS_REASONS = {
  no_usable_window: "There is no usable time left before you need to be back at the airport.",
  landside_closed: "Leaving the airport is not available on this layover right now.",
  outside_certified_envelope: "This is farther than you can safely reach and get back from in your layover.",
  journey_not_measured: "The journey to this place has not been measured, so it cannot be checked against your return time.",
  duration_not_stated: "How long this takes has not been stated, so it cannot be checked against your return time.",
  unsafe_return_risk: "This does not fit your safe return to the airport.",
  tight_return: "This fits, but your return margin is tight.",
  stale_certification: "Your layover changed after this idea was checked, so it was replaced.",
  no_longer_feasible: "After the latest change to your layover, this no longer fits.",
  card_window_closed: "The time to start this has passed.",
  snapshot_not_active: "This idea was checked against an earlier version of your layover.",
} as const;
export type StatusReason = keyof typeof STATUS_REASONS;

const RANK: Record<RiskBand, number> = { LOW: 0, MODERATE: 1, HIGH: 2, UNSAFE: 3 };
const worse = (a: RiskBand, b: RiskBand | null): RiskBand => (b !== null && RANK[b] > RANK[a] ? b : a);

/** The map band `bandCandidates` gave the card's position, or null (no position / airside). */
export type CardMapBand = "SAFE" | "TIGHT" | "BLOCKED" | "UNCERTIFIED" | null;

export interface CardClassificationInput {
  insideAirport: boolean;
  assessment: Pick<SafetyAssessment, "rating" | "statedTravelMin" | "statedActivityMin">;
  mapBand: CardMapBand;
  /** The ONE certified record every card of the generation was rated against. */
  record: LayoverFeasibilityRecord;
}

export interface CardClassification {
  riskBand: RiskBand;
  status: "ELIGIBLE" | "TIGHT" | "BLOCKED";
  reason: StatusReason | null;
}

const blocked = (reason: StatusReason): CardClassification => ({ riskBand: "UNSAFE", status: "BLOCKED", reason });

/** PURE. See the header for every branch. */
export function classifyCard(input: CardClassificationInput): CardClassification {
  const { assessment: a, record } = input;
  let band: RiskBand;
  if (input.insideAirport) {
    if (a.rating === "not_recommended") return blocked(a.statedActivityMin === null ? "duration_not_stated" : "unsafe_return_risk");
    band = a.rating === "possible_but_risky" ? "MODERATE" : "LOW";
  } else {
    if (record.envelope.temporalConflict !== null) return blocked("no_usable_window");
    if (record.verdict === "no" || record.verdict === "stay_airside" || landsideStatusOf(record) === "closed") return blocked("landside_closed");
    if (input.mapBand === "BLOCKED") return blocked("outside_certified_envelope");
    if (a.rating === "airport_only") return blocked("landside_closed");
    if (a.rating === "not_recommended") {
      if (a.statedTravelMin === null) return blocked("journey_not_measured");
      if (a.statedActivityMin === null) return blocked("duration_not_stated");
      return blocked("unsafe_return_risk");
    }
    band = a.rating === "possible_but_risky" || input.mapBand === "TIGHT" ? "MODERATE" : "LOW";
    band = worse(band, riskBandFor(record));
    if (band === "UNSAFE") return blocked("unsafe_return_risk");
  }
  return band === "LOW" ? { riskBand: band, status: "ELIGIBLE", reason: null } : { riskBand: band, status: "TIGHT", reason: "tight_return" };
}

/**
 * The last instant the card can still be started and completed: landside, its own hard return minus the stated round
 * trip and dwell (the assessment's `requiredMinutes` less the buffer); airside, the cutoff minus the stated dwell.
 * When a term is unstated the card is BLOCKED anyway and this is the hard return (landside) / the cutoff (airside):
 * an upper bound, never a later one.
 */
export function cardExpiresAt(
  insideAirport: boolean,
  a: Pick<SafetyAssessment, "hardReturnTime" | "requiredMinutes" | "returnBufferMin" | "requiredMinutesIsLowerBound" | "statedActivityMin">,
  record: LayoverFeasibilityRecord,
): Date {
  if (insideAirport) return new Date(record.deadline.cutoffMs - (a.statedActivityMin ?? 0) * 60_000);
  if (a.requiredMinutesIsLowerBound) return a.hardReturnTime;
  return new Date(a.hardReturnTime.getTime() - Math.max(0, a.requiredMinutes - a.returnBufferMin) * 60_000);
}

/** The version of the contract shape stored in plan_json. */
export const RECOMMENDATION_CONTRACT_VERSION = "2026.10.19-1";

export interface SpecColumnsInput {
  card: ObjectiveCard & { recType?: string; placeId?: string | null };
  assessment: SafetyAssessment;
  key: string;
  mapBand: CardMapBand;
  record: LayoverFeasibilityRecord;
  /** The stored snapshot every card of this generation cites, or null when none was stored. */
  snapshotId: string | null;
  live?: ReadonlyMap<string, ObjectiveLiveReading>;
  /** lane B1-R1's routed card contract, when the card was routed. Carried, not recomputed. */
  routing?: RoutedCardContract | null; liveBlocked?: boolean; preferences?: readonly string[]; objectiveEvidence?: import("../airport/layoverObjectiveEvidence.js").ObjectiveEvidence;
}

/**
 * The 3871 columns for ONE generated card. Every value is read off the certification; `plan_json` is the §9
 * RecommendationContract AS THIS TREE STATES IT, with the members it cannot state yet named in `unstated` (census L76
 * is that contract's own row) rather than filled with plausible values.
 */
export function recommendationSpecColumns(input: SpecColumnsInput): Record<string, unknown> {
  const { card, assessment: a, record } = input;
  const c = classifyCard({ insideAirport: card.insideAirport, assessment: a, mapBand: input.mapBand, record }); const executable = certifyRecommendation(record.inputs.session.id, input); if (executable.state === "UNAVAILABLE" && c.status !== "BLOCKED") { c.status = "BLOCKED"; c.riskBand = "UNSAFE"; c.reason = executable.failureModes.includes("duration_unstated") ? "duration_not_stated" : executable.failureModes.includes("return_route_unmeasured") ? "journey_not_measured" : "unsafe_return_risk"; }
  const expires = cardExpiresAt(card.insideAirport, a, record);
  const objective = cardObjective(card, { keyOf: () => input.key, live: input.live, preferences: input.preferences, routing: new Map([[input.key, input.routing ?? null]]), evidence: input.objectiveEvidence ? new Map([[input.key, input.objectiveEvidence]]) : undefined });
  // Executable timing is projected once by certifyRecommendation, including asymmetric routed return terms.
  const plan: Record<string, unknown> = {
    // Contract version, snapshot and candidate identity come from executable below.
    // Every required §9 field is present, including explicitly unknown values.
    // No category-default experience minutes enter the contract.
    candidateType: card.recType ?? null,
    // departBy and arrival use the certified outgoing leg.
    // The chosen activity duration is also the planned ideal duration.
    // hardReturnBy is the shared commitment envelope boundary.
    // The return buffer remains protected once, outside the experience.
    // Unsafe or incomplete executable contracts are BLOCKED above.
    // Confidence is the same record confidence, never upgraded here.
    // Failure and reason codes are deterministic and coordinate-free.
    statedTravelMinutes: a.statedTravelMin,
    requiredMinutesIsLowerBound: a.requiredMinutesIsLowerBound,
    objective: { version: LAYOVER_OBJECTIVE_VERSION, unknownTerms: objective.unknownTerms, terms: objective.terms },
    ...(input.routing ? { routing: withoutProviderMapContent(input.routing) } : {}),
    ...executable,
  };
  return {
    plan_json: plan,
    utility_score: Number.isFinite(objective.score) ? objective.score : null,
    risk_band: c.riskBand,
    confidence: record.confidence,
    expires_at: executable.expiresAt ?? expires.toISOString(),
    recommendation_status: c.status,
    status_reason: c.reason,
    // A re-certified card is the session's CURRENT card again: its earlier supersession lives on in the history table,
    // and 3871's CHECK (`layover_recs_superseded_complete`) requires the mark to go with the SUPERSEDED status.
    superseded_by_snapshot_id: null,
    superseded_at: null,
  };
}

// ── what a reader is served ─────────────────────────────────────────────────────────────────────────────────────

export interface ServedRecommendationStatus {
  status: RecommendationStatus; contract?: LayoverRecommendationContract | null;
  /** TRUE only for ELIGIBLE / TIGHT. A client renders "Add to plan" for nothing else. */
  available: boolean;
  statusReason: StatusReason | null;
  /** The fixed sentence for `statusReason`; null when there is none. */
  statusExplanation: string | null;
  riskBand: RiskBand | null;
  confidence: string | null;
  expiresAt: string | null;
  /** SUPERSEDED only: the snapshot that superseded the card. */
  supersededBySnapshotId?: string;
}

const isStatus = (v: unknown): v is RecommendationStatus => typeof v === "string" && (RECOMMENDATION_STATUSES as readonly string[]).includes(v);
const isReason = (v: unknown): v is StatusReason => typeof v === "string" && Object.prototype.hasOwnProperty.call(STATUS_REASONS, v);
const isBand = (v: unknown): v is RiskBand => v === "LOW" || v === "MODERATE" || v === "HIGH" || v === "UNSAFE";

/**
 * The status a STORED card is served under, at `nowMs`, given the session's active snapshot.
 *
 * `null` for a card that carries no status (written before 3871 or with the flag OFF): the reader serves it exactly as
 * before. It is NEVER read as ELIGIBLE.
 *
 * Precedence, each only over a card that would otherwise be AVAILABLE: SUPERSEDED (stored) > EXPIRED (its expires_at
 * has passed — `card_window_closed`) > STALE (it cites a snapshot that is not the session's active one —
 * `snapshot_not_active`; only when the active snapshot is KNOWN) > the stored ELIGIBLE / TIGHT. A BLOCKED card stays
 * BLOCKED with its own reason: it is already unavailable, and its reason is the more useful sentence.
 */
export function servedStatusOf(
  row: Record<string, unknown>,
  ctx: { nowMs: number; activeSnapshotId?: string | null },
): ServedRecommendationStatus | null {
  const stored = row["recommendation_status"];
  if (!isStatus(stored)) return null;
  const base = { contract: servedRecommendationContract(row["plan_json"]),
    riskBand: isBand(row["risk_band"]) ? row["risk_band"] : null,
    confidence: typeof row["confidence"] === "string" ? row["confidence"] : null,
    expiresAt: typeof row["expires_at"] === "string" ? new Date(Date.parse(row["expires_at"])).toISOString() : null,
  };
  const out = (status: RecommendationStatus, reason: StatusReason | null, extra: Partial<ServedRecommendationStatus> = {}): ServedRecommendationStatus => ({
    status, available: AVAILABLE_RECOMMENDATION_STATUSES.has(status), statusReason: reason, statusExplanation: reason ? STATUS_REASONS[reason] : null, ...base, ...extra,
  });
  const storedReason = isReason(row["status_reason"]) ? row["status_reason"] : null;
  if (stored === "SUPERSEDED") {
    return out("SUPERSEDED", storedReason ?? "stale_certification", typeof row["superseded_by_snapshot_id"] === "string" ? { supersededBySnapshotId: row["superseded_by_snapshot_id"] } : {});
  }
  if (!AVAILABLE_RECOMMENDATION_STATUSES.has(stored)) return out(stored, storedReason);
  const expires = typeof row["expires_at"] === "string" ? Date.parse(row["expires_at"]) : NaN;
  if (Number.isFinite(expires) && ctx.nowMs >= expires) return out("EXPIRED", "card_window_closed");
  if (ctx.activeSnapshotId !== undefined && typeof row["snapshot_id"] === "string" && row["snapshot_id"] !== ctx.activeSnapshotId) {
    return out("STALE", "snapshot_not_active");
  }
  return out(stored, storedReason);
}

/** Fail-closed (`isFlagEnabled`): unreadable or absent is OFF. */
export async function recommendationStatusEnabled(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, "layover_recommendation_status_enabled");
}

// ── supersession ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SupersessionReason = "stale_certification" | "no_longer_feasible";
export type SupersessionCause = "window_edit" | "external_event" | "reported_disruption" | "regeneration";

export type SupersessionOutcome =
  | {
      applied: true;
      /** The STORED snapshot that superseded the cards. */
      currentSnapshotId: string;
      /** Its 3623 version, or null when it could not be read (the supersession still happened). */
      currentSnapshotVersion: number | null;
      /** Each card superseded, the snapshot it had cited (null: it cited none), and why. */
      superseded: Array<{ recommendationId: string; citedSnapshotId: string | null; why: SupersessionReason[] }>;
    }
  | {
      applied: false;
      reason: "supersession_disabled" | "snapshot_not_stored" | "flag_unreadable" | "storage_unavailable" | "read_failed" | "write_failed";
      /** On `write_failed` after the history was written: the cards whose history row exists but whose mark failed. */
      historyRecordedButUnmarked?: string[];
    };

/** The card's decision evidence copied into the history row: the certified columns, as written. */
const EVIDENCE_SELECT = // one literal list, so check:write-path-columns and check:schema-references read the select
  "id, rec_key, snapshot_id, rec_type, title, place_id, inside_airport, safety_rating, travel_time_min, " +
  "activity_time_min, return_buffer_min, hard_return_time, warning_reason, sort_order, recommendation_status, " +
  "status_reason, risk_band, confidence, utility_score, expires_at, plan_json, superseded_at";
const EVIDENCE_COLUMNS = EVIDENCE_SELECT.split(", ");

export interface SupersedeArgs {
  sessionId: string;
  /** The stored snapshot that supersedes. Cards citing any OTHER snapshot are stale. */
  currentSnapshotId: string;
  cause: SupersessionCause;
  /** Cards whose plan stop no longer fits (§11.1 step 6's "no longer feasible"), by recommendation id. */
  infeasibleCardIds?: ReadonlySet<string>;
  nowIso?: string;
}

/**
 * §11.1 step 6 / §5 `* → DISRUPTED`, as VERSIONED SUPERSESSION (see the header). The caller has already established
 * that the status flag is ON and that `currentSnapshotId` is STORED. Never throws.
 */
export async function supersedeCards(db: SupabaseClient, args: SupersedeArgs): Promise<SupersessionOutcome> {
  const { sessionId, currentSnapshotId } = args;
  const nowIso = args.nowIso ?? new Date().toISOString();
  try {
    const held = await db.from("layover_recommendations").select(EVIDENCE_SELECT).eq("session_id", sessionId);
    if (held.error) {
      logger.warn({ err: held.error.message, sessionId }, "supersession: held cards unreadable — nothing superseded");
      return { applied: false, reason: isMissingSchemaError(held.error) ? "storage_unavailable" : "read_failed" };
    }
    const infeasible = args.infeasibleCardIds ?? new Set<string>();
    const targets: Array<{ row: Record<string, unknown>; id: string; cited: string | null; why: SupersessionReason[] }> = [];
    for (const row of (held.data ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = row["id"];
      if (typeof id !== "string" || row["superseded_at"] != null) continue;
      const cited = typeof row["snapshot_id"] === "string" && row["snapshot_id"] !== "" ? (row["snapshot_id"] as string) : null;
      const why: SupersessionReason[] = [];
      if (cited !== null && cited !== currentSnapshotId) why.push("stale_certification");
      if (infeasible.has(id)) why.push("no_longer_feasible");
      if (why.length > 0) targets.push({ row, id, cited, why });
    }
    if (targets.length === 0) return { applied: true, currentSnapshotId, currentSnapshotVersion: null, superseded: [] };

    const versionRead = await db.from("layover_certified_computations").select("snapshot_version").eq("snapshot_id", currentSnapshotId).maybeSingle();
    const version = !versionRead.error && Number.isInteger(Number((versionRead.data as { snapshot_version?: unknown } | null)?.snapshot_version))
      ? Number((versionRead.data as { snapshot_version: unknown }).snapshot_version) : null;

    // 1. The history, FIRST: if it cannot be written, nothing is marked.
    const history = targets.map((t) => ({
      session_id: sessionId,
      recommendation_id: t.id,
      rec_key: typeof t.row["rec_key"] === "string" ? t.row["rec_key"] : null,
      superseded_snapshot_id: t.cited,
      superseding_snapshot_id: currentSnapshotId,
      superseding_snapshot_version: version,
      prior_status: (SPEC_RECOMMENDATION_STATUSES as readonly string[]).includes(String(t.row["recommendation_status"])) ? t.row["recommendation_status"] : null,
      reasons: t.why,
      cause: args.cause,
      card: Object.fromEntries(EVIDENCE_COLUMNS.filter((c) => c !== "superseded_at").map((c) => [c, t.row[c] ?? null])),
      superseded_at: nowIso,
    }));
    const wrote = await db.from("layover_recommendation_supersessions").insert(history);
    if (wrote.error) {
      if (wrote.error.code !== "23505") {
        logger.warn({ err: wrote.error.message, sessionId }, "supersession: history unwritable — nothing superseded");
        return { applied: false, reason: isMissingSchemaError(wrote.error) ? "storage_unavailable" : "write_failed" };
      }
      // A retried supersession: write each row, keeping the ones already recorded (the unique key is the arbiter).
      for (const h of history) {
        const one = await db.from("layover_recommendation_supersessions").insert({ session_id: h.session_id, recommendation_id: h.recommendation_id, rec_key: h.rec_key, superseded_snapshot_id: h.superseded_snapshot_id, superseding_snapshot_id: h.superseding_snapshot_id, superseding_snapshot_version: h.superseding_snapshot_version, prior_status: h.prior_status, reasons: h.reasons, cause: h.cause, card: h.card, superseded_at: h.superseded_at });
        if (one.error && one.error.code !== "23505") return { applied: false, reason: "write_failed" };
      }
    }

    // 2. The mark: compare-and-set on the citation read and on "not yet superseded".
    const groups = new Map<string, typeof targets>();
    for (const t of targets) {
      const reason: SupersessionReason = t.why.includes("no_longer_feasible") ? "no_longer_feasible" : "stale_certification";
      const k = `${t.cited ?? "\u0000"}|${reason}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const marked: string[] = [];
    for (const [k, ts] of groups) {
      const [cited, reason] = [ts[0]!.cited, k.slice(k.lastIndexOf("|") + 1) as SupersessionReason];
      let q = db
        .from("layover_recommendations")
        .update({ recommendation_status: "SUPERSEDED", status_reason: reason, superseded_by_snapshot_id: currentSnapshotId, superseded_at: nowIso })
        .eq("session_id", sessionId)
        .in("id", ts.map((t) => t.id))
        .is("superseded_at", null);
      q = cited === null ? q.is("snapshot_id", null) : q.eq("snapshot_id", cited);
      const { error } = await q;
      if (error) {
        logger.warn({ err: error.message, sessionId }, "supersession: mark refused after the history was written");
        return { applied: false, reason: "write_failed", historyRecordedButUnmarked: targets.map((t) => t.id).filter((id) => !marked.includes(id)) };
      }
      marked.push(...ts.map((t) => t.id));
    }
    return { applied: true, currentSnapshotId, currentSnapshotVersion: version, superseded: targets.map((t) => ({ recommendationId: t.id, citedSnapshotId: t.cited, why: t.why })) };
  } catch (err) {
    logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, "supersession threw — nothing reported as superseded");
    return { applied: false, reason: "write_failed" };
  }
}

// ── the generation's stamp: citation + status + regeneration supersession ──────────────────────────────────────────

export type RecommendationStamp = RecommendationSnapshotStamp & {
  /** `layover_recommendation_status_enabled` as read for THIS generation. */
  statusEnabled: boolean;
  /** The 3871 columns for one card, or `{}` with the flag OFF (the row is then byte-identical to before). */
  spec(input: Omit<SpecColumnsInput, "record" | "snapshotId">): Record<string, unknown>;
  /** The served status keys for one written row, or `{}` with the flag OFF. */
  served(row: Record<string, unknown>): Partial<ServedRecommendationStatus>;
  /** What the regeneration superseded before it wrote (flag ON and a stored snapshot only). */
  supersession?: SupersessionOutcome;
};

/**
 * census L64's stamp (`recommendationSnapshotStamp`: store the record, cite it) plus this lane's three steps, for ONE
 * generation, called where the generator called the stamp:
 *   1. read `layover_recommendation_status_enabled` once;
 *   2. ON and a STORED snapshot: SUPERSEDE every card of the session that cites another snapshot (cause
 *      `regeneration`) BEFORE the generation rewrites the session's cards — the history row keeps the old version's
 *      evidence, which the rewrite (delete+insert, or upsert in place) would otherwise destroy;
 *   3. hand back `spec` / `served` for the rows. OFF: both answer `{}` and nothing else is read or written.
 */
export async function recommendationStamp(
  db: SupabaseClient,
  session: { id: string; userId: string },
  record: LayoverFeasibilityRecord,
): Promise<RecommendationStamp> {
  const base = await recommendationSnapshotStamp(db, session.userId, session.id, record);
  const statusOn = await recommendationStatusEnabled(db);
  const supersession = statusOn && base.snapshotId !== null
    ? await supersedeCards(db, { sessionId: session.id, currentSnapshotId: base.snapshotId, cause: "regeneration" })
    : undefined;
  if (statusOn && (!supersession || !supersession.applied)) throw new Error(`recommendation_supersession_unavailable: ${supersession && !supersession.applied ? supersession.reason : "snapshot_not_stored"}`);
  return {
    ...base,
    statusEnabled: statusOn,
    ...(supersession ? { supersession } : {}),
    spec: (input) => (statusOn ? recommendationSpecColumns({ ...input, record, snapshotId: base.snapshotId }) : {}),
    served: (row) => (statusOn ? servedStatusOf(row, { nowMs: Date.now(), activeSnapshotId: base.snapshotId ?? undefined }) ?? {} : {}),
  };
}

/**
 * The served-status projector for STORED rows (`getRecommendations`, the plan-add read). Reads nothing when no row
 * carries a status (every production row today: 3871 is unapplied, so the key is not even selected); otherwise reads
 * the flag (OFF: nothing is served, so a status left on a row from an earlier ON period is never published as current)
 * and the session's active snapshot pointer (3828; unreadable or absent makes a cited available card STALE).
 */
export async function storedStatusProjector(
  db: SupabaseClient,
  sessionId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<(row: Record<string, unknown>) => Partial<ServedRecommendationStatus>> {
  const none = () => ({});
  if (!rows.some((r) => r["recommendation_status"] != null)) return none;
  if (!(await recommendationStatusEnabled(db))) return none;
  let activeSnapshotId: string | null | undefined;
  try {
    const { data, error } = await db.from("layover_sessions").select("active_snapshot_id").eq("id", sessionId).maybeSingle();
    activeSnapshotId = error ? undefined : ((data as { active_snapshot_id?: string | null } | null)?.active_snapshot_id ?? null); if (error) logger.warn({ err: error, sessionId }, "recommendation active snapshot unavailable");
  } catch (err) { logger.warn({ err, sessionId }, "recommendation active snapshot read threw");
    activeSnapshotId = undefined;
  }
  // A classified available card must prove its citation is active. Missing/unreadable active state never grants availability.
  const known = activeSnapshotId === undefined ? null : activeSnapshotId;
  return (row) => servedStatusOf(row, { nowMs: Date.now(), activeSnapshotId: known }) ?? {};
}

/** TRUE when a stored row may be offered / added / counted as reachable: no status (legacy) or an available one. */
export function storedRowIsAvailable(served: Partial<ServedRecommendationStatus>): boolean {
  return served.available !== false;
}

import { compileRecommendationContract, servedRecommendationContract, type LayoverRecommendationContract } from "../airport/LayoverRecommendationContract.js";
import type { RoutedCardContract } from "../airport/LayoverRoutedFeasibility.js";

/** §18's named certification entry point, used by the actual recommendation writer. */
export function certifyRecommendation(sessionId: string, candidatePlan: SpecColumnsInput): LayoverRecommendationContract {
  const { record, card, assessment, mapBand, snapshotId, key, routing, liveBlocked } = candidatePlan;
  const classification = classifyCard({ insideAirport: card.insideAirport, record, assessment, mapBand });
  return compileRecommendationContract({ sessionId, snapshotId, key, insideAirport: card.insideAirport, record, assessment, routing, liveBlocked, riskBand: classification.riskBand });
}

import { withoutProviderMapContent } from '../../lib/providers/providerMapGeometry.js';
