/**
 * creatorTypeAttribution — `07` §7/§8/§9's attribution model, for all SIX of
 * §2's creator value types. PURE. It reaches no database and moves no money.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 * `07` §7: *"The attribution engine should record contributions before deciding
 * payout weights."* `07` §8 lists exactly what to store — gross revenue,
 * attribution candidates, confidence, rule version, provisional share — and
 * forbids hard-coding the percentages that produce them. This module builds
 * those records, refuses the ones that could not be audited, and computes NO
 * percentage of its own: every figure it writes was handed to it, and the rule
 * version says which configuration produced it (2920's
 * `creator_rule_versions.params` is where the numbers live).
 *
 * ── WHY IT IS TYPE-INDEXED RATHER THAN SUBSYSTEM-INDEXED ───────────────────
 * The tree's two attribution paths are `intel_attributions` (2277, pinned to a
 * claim and an observation) and `rent_buddy_earnings_entries` (2901, pinned to
 * a booking). Neither can express a Trail Builder, an Itinerary Creator or an
 * Experience Host, and the intel one cannot even separate a Discovery Creator
 * from a Local Expert. So the dimension here is the CREATOR TYPE, and the
 * subject kind is DERIVED from it (`lib/creatorTypes.ts`) rather than supplied —
 * a caller cannot file a Trail Builder against a booking, because it is not an
 * input.
 *
 * ── THE HONESTY RULE, AND WHY IT IS A REFUSAL ──────────────────────────────
 * Four of the six types have no code that records their value event. For those,
 * an attribution is a SEAM: it names a real (or, for `itinerary_creator`, a
 * not-yet-real) subject, carries NO weight, NO gross and NO share, and is not
 * earnable. Asking for anything more is REFUSED rather than quietly zeroed —
 * `seam_cannot_carry_value` and `no_value_event_producer` — because a silent
 * zero is how a seam becomes indistinguishable from coverage. 2921's trigger
 * enforces the same rule at the database, so it holds for writers that never
 * pass through this module.
 *
 * ── THE PRE-MONEY BOUNDARY ─────────────────────────────────────────────────
 * `09` §1: *"Portava moves no money."* There is no balance, no wallet and no
 * disbursement here. `settledMinor` exists on the INPUT only so a caller that
 * believes money arrived is REFUSED (`settlement_not_recordable`) instead of
 * ignored; the built record's `settledMinor` is the literal 0. This is the
 * code-side twin of 2920's `CHECK (settled_minor = 0)`.
 *
 * RUNTIME EFFECT: NONE on its own. Its persisting caller is
 * `services/creators/CreatorAttributionService.ts`, gated fail-closed on the
 * `creator_attribution_enabled` flag.
 */
import {
  creatorTypeFacts,
  isCreatorType,
  type CreatorSubjectKind,
  type CreatorType,
  type TravelerImpactOutcome,
} from "./creatorTypes.js";

/** 2920's `attribution_basis`. A seam is not an attribution and may not look like one. */
export type AttributionBasis = "recorded_value_event" | "seam_no_producer";

export interface CreatorAttribution {
  /** Deterministic, derived from the event — never from the attempt (`09` §7.1). */
  id: string;
  creatorType: CreatorType;
  /** DERIVED from the type. Not an input, so it cannot be mis-filed. */
  subjectKind: CreatorSubjectKind;
  subjectId: string;
  /** DERIVED from the type: the `07` §3 outcome this type earns from. */
  valueEvent: TravelerImpactOutcome;
  /** The row that recorded the outcome. Null exactly on a seam. */
  valueEventId: string | null;
  basis: AttributionBasis;
  beneficiaryUserId: string;
  /** `07` §7's payout weight CANDIDATE — recorded before weights are decided. */
  weight: number;
  confidence: number;
  /** `07` §8's storables. A record of a computation, never of a receipt. */
  grossRevenueMinor: number;
  provisionalShareMinor: number;
  currency: string;
  /** Always 0. Present so a reader can assert the boundary rather than assume it. */
  settledMinor: 0;
  ruleVersion: string;
  fraudHold: boolean;
  fraudHoldReason: string | null;
  /** Set on a recomputation; names the exact attribution it replaces. */
  supersedesId: string | null;
  /**
   * Whether an earning may be booked against this. FALSE on a seam and FALSE
   * under a fraud hold — the two independent reasons `07` §10 gives for an
   * attribution to exist and produce nothing.
   */
  earnable: boolean;
  idempotencyKey: string;
}

export interface AttributionInput {
  creatorType: CreatorType;
  subjectId: string;
  valueEventId: string | null;
  beneficiaryUserId: string;
  ruleVersion: string;
  weight: number;
  confidence: number;
  grossRevenueMinor: number;
  provisionalShareMinor: number;
  fraudHold: boolean;
  fraudHoldReason: string | null;
  currency?: string;
  supersedesId?: string | null;
  /**
   * How much money actually settled. The ONLY accepted value is 0 (or absent).
   * A caller that believes money moved is describing something this platform
   * cannot do (`09` §1) and is refused rather than recorded.
   */
  settledMinor?: number;
}

export type AttributionRefusal =
  | "unknown_creator_type"
  | "missing_attribution"
  | "missing_rule_version"
  | "rule_version_type_mismatch"
  | "missing_value_event"
  | "no_value_event_producer"
  | "seam_cannot_carry_value"
  | "unexplained_fraud_hold"
  | "share_exceeds_gross"
  | "settlement_not_recordable"
  | "negative_input"
  | "out_of_range"
  | "weights_exceed_whole"
  | "same_rule_version"
  | "already_held";

export type AttributionResult =
  | { status: "built"; attribution: CreatorAttribution }
  | { status: "refused"; reason: AttributionRefusal; detail: string };

export const DEFAULT_CURRENCY = "USD";

const refuse = (reason: AttributionRefusal, detail: string): AttributionResult =>
  ({ status: "refused", reason, detail });

/**
 * A type's basis is not a choice — it follows from whether a producer exists.
 * Deriving it here rather than accepting it is what stops "we have coverage"
 * being a parameter.
 */
export function attributionBasisFor(creatorType: CreatorType): AttributionBasis {
  return creatorTypeFacts(creatorType).valueEventProducer === null
    ? "seam_no_producer"
    : "recorded_value_event";
}

/**
 * The rule version must belong to THIS type's lineage. Without the check, a
 * Trail re-pricing could be booked under the intel schedule and the per-type
 * versioning `07` §8 asks for would be decorative.
 *
 * The lineage is the type's default version with its trailing generation
 * stripped, so `creator-rules/travel-partner/v7` is accepted and
 * `creator-rules/local-expert/v1` is not.
 */
function ruleLineageOf(version: string): string {
  return version.replace(/\/v\d+$/, "");
}

export function buildAttribution(input: AttributionInput): AttributionResult {
  if (!isCreatorType(input.creatorType)) {
    return refuse("unknown_creator_type", String(input.creatorType));
  }
  // `09` §1, checked FIRST: a caller asserting a settlement is wrong about the
  // platform, and nothing else it says should be interpreted.
  if (typeof input.settledMinor === "number" && input.settledMinor !== 0) {
    return refuse(
      "settlement_not_recordable",
      `settledMinor=${input.settledMinor}: Portava moves no money (09 §1); no payout, wallet or ` +
        "disbursement path exists for any of 07 §2's six creator types",
    );
  }
  if (!input.subjectId || !input.beneficiaryUserId) {
    return refuse("missing_attribution", "an attribution with no subject or no party cannot be audited");
  }
  if (!input.ruleVersion) {
    return refuse("missing_rule_version", "an unversioned attribution cannot be recomputed (07 §10)");
  }

  const facts = creatorTypeFacts(input.creatorType);
  if (ruleLineageOf(input.ruleVersion) !== ruleLineageOf(facts.defaultRuleVersion)) {
    return refuse(
      "rule_version_type_mismatch",
      `${input.creatorType} booked under ${input.ruleVersion}; its lineage is ${ruleLineageOf(facts.defaultRuleVersion)}`,
    );
  }

  if (input.fraudHold !== (input.fraudHoldReason !== null && input.fraudHoldReason !== "")) {
    return refuse(
      "unexplained_fraud_hold",
      "a hold with no reason is indistinguishable from a bug; a reason with no hold is a claim nobody acted on",
    );
  }

  for (const [name, v] of Object.entries({
    grossRevenueMinor: input.grossRevenueMinor,
    provisionalShareMinor: input.provisionalShareMinor,
  })) {
    if (!Number.isFinite(v) || v < 0) return refuse("negative_input", `${name}=${v}`);
  }
  for (const [name, v] of Object.entries({ weight: input.weight, confidence: input.confidence })) {
    if (!Number.isFinite(v) || v < 0 || v > 1) return refuse("out_of_range", `${name}=${v}`);
  }
  if (input.provisionalShareMinor > input.grossRevenueMinor) {
    return refuse(
      "share_exceeds_gross",
      `${input.provisionalShareMinor} > ${input.grossRevenueMinor}: a share cannot exceed what it is a share of`,
    );
  }

  const basis = attributionBasisFor(input.creatorType);
  if (basis === "seam_no_producer") {
    if (input.valueEventId !== null) {
      return refuse(
        "no_value_event_producer",
        `${input.creatorType} has no producer for ${facts.valueEvent}: ${facts.noProducerReason}`,
      );
    }
    if (input.weight !== 0 || input.grossRevenueMinor !== 0 || input.provisionalShareMinor !== 0) {
      return refuse(
        "seam_cannot_carry_value",
        `${input.creatorType} has no recorded value event, so it can carry no weight and no share`,
      );
    }
  } else if (!input.valueEventId) {
    return refuse(
      "missing_value_event",
      `${input.creatorType} claims a recorded value event and named none; ` +
        `its producer is ${facts.valueEventProducer}`,
    );
  }

  // `09` §7.1 — identity from the EVENT. The key is (type, subject, event or
  // seam marker, beneficiary): multi-party attribution means several rows share
  // the first three and differ in the fourth, so the beneficiary is part of it.
  const eventPart = input.valueEventId ?? `seam:${facts.valueEvent}`;
  const idempotencyKey =
    `creator-attr:${input.creatorType}:${input.subjectId}:${eventPart}:${input.beneficiaryUserId}`;

  return {
    status: "built",
    attribution: {
      id: idempotencyKey,
      creatorType: input.creatorType,
      subjectKind: facts.subjectKind,
      subjectId: input.subjectId,
      valueEvent: facts.valueEvent,
      valueEventId: input.valueEventId,
      basis,
      beneficiaryUserId: input.beneficiaryUserId,
      weight: input.weight,
      confidence: input.confidence,
      grossRevenueMinor: input.grossRevenueMinor,
      provisionalShareMinor: input.provisionalShareMinor,
      currency: input.currency ?? DEFAULT_CURRENCY,
      settledMinor: 0,
      ruleVersion: input.ruleVersion,
      fraudHold: input.fraudHold,
      fraudHoldReason: input.fraudHoldReason,
      supersedesId: input.supersedesId ?? null,
      // BOTH gates, and they are independent: a seam has nothing to earn from,
      // and a held attribution has something and must not.
      earnable: basis === "recorded_value_event" && !input.fraudHold,
      idempotencyKey,
    },
  };
}

// ── `07` §7 multi-party ─────────────────────────────────────────────────────

export type SplitResult =
  | { status: "built"; attributions: CreatorAttribution[] }
  | { status: "refused"; reason: AttributionRefusal; detail: string };

export function totalWeight(attributions: readonly CreatorAttribution[]): number {
  // Sum in hundredths so 0.1 + 0.2 does not read as 0.30000000000000004 and
  // trip a "> 1" comparison that the arithmetic, not the data, caused.
  const hundredths = attributions.reduce((s, a) => s + Math.round(a.weight * 100), 0);
  return hundredths / 100;
}

/**
 * `07` §7: *"A conversion may involve: Trail builder, original content creator,
 * place page, later recommender, Portava ranking."* Several parties, one
 * conversion. Weights summing BELOW 1.0 are fine — §7's whole point is that
 * contributions are recorded before payout weights are decided — but summing
 * ABOVE 1.0 would distribute more than the conversion produced, so it is
 * refused.
 */
export function splitCandidates(inputs: readonly AttributionInput[]): SplitResult {
  const out: CreatorAttribution[] = [];
  for (const input of inputs) {
    const r = buildAttribution(input);
    if (r.status !== "built") return { status: "refused", reason: r.reason, detail: r.detail };
    out.push(r.attribution);
  }
  const total = totalWeight(out);
  if (total > 1) {
    return {
      status: "refused",
      reason: "weights_exceed_whole",
      detail: `Σweight=${total}: more than the conversion produced would be distributed`,
    };
  }
  return { status: "built", attributions: out };
}

// ── `07` §10 historical recalculation ───────────────────────────────────────

export interface SupersedeInput {
  ruleVersion: string;
  grossRevenueMinor?: number;
  provisionalShareMinor?: number;
  weight?: number;
  confidence?: number;
  fraudHold?: boolean;
  fraudHoldReason?: string | null;
}

/**
 * `07` §10 "historical recalculation is possible". A recomputation is a NEW
 * attribution that NAMES the one it replaces and carries the NEW rule version.
 * The original is never touched — it stays readable under its own version,
 * which is the whole point and is exactly the principle 2277:36-40 already
 * states for derived attribution data.
 *
 * A SEAM cannot be superseded: there was no computation, so there is nothing to
 * redo, and producing a "recomputed" seam would imply one had happened.
 */
export function supersedeAttribution(
  original: CreatorAttribution,
  next: SupersedeInput,
): AttributionResult {
  if (original.basis === "seam_no_producer") {
    return refuse(
      "seam_cannot_carry_value",
      `${original.creatorType}: no value event was ever recorded, so there is no computation to redo`,
    );
  }
  if (next.ruleVersion === original.ruleVersion) {
    return refuse("same_rule_version", `already at ${original.ruleVersion}; nothing was recomputed`);
  }

  const rebuilt = buildAttribution({
    creatorType: original.creatorType,
    subjectId: original.subjectId,
    valueEventId: original.valueEventId,
    beneficiaryUserId: original.beneficiaryUserId,
    ruleVersion: next.ruleVersion,
    weight: next.weight ?? original.weight,
    confidence: next.confidence ?? original.confidence,
    grossRevenueMinor: next.grossRevenueMinor ?? original.grossRevenueMinor,
    provisionalShareMinor: next.provisionalShareMinor ?? original.provisionalShareMinor,
    fraudHold: next.fraudHold ?? original.fraudHold,
    fraudHoldReason: next.fraudHoldReason !== undefined ? next.fraudHoldReason : original.fraudHoldReason,
    currency: original.currency,
    supersedesId: original.id,
  });
  if (rebuilt.status !== "built") return rebuilt;

  // The rebuilt row's natural key is the same event and party, so it would
  // collide with the original. The rule version disambiguates the GENERATION,
  // which is what a recomputation is.
  const idempotencyKey = `${rebuilt.attribution.idempotencyKey}@${next.ruleVersion}`;
  return {
    status: "built",
    attribution: { ...rebuilt.attribution, id: idempotencyKey, idempotencyKey },
  };
}

// ── `07` §9/§10 fraud holds ─────────────────────────────────────────────────

/**
 * Place a fraud hold, as a NEW attribution that names the one it holds.
 *
 * ── WHY THIS IS NOT `supersedeAttribution` ─────────────────────────────────
 * A hold is a fact about the SAME computation, not a recomputation of it, so it
 * must keep the original's rule version. `supersedeAttribution` refuses that
 * (`same_rule_version`), and the first version of the service worked around it
 * by minting a synthetic version `…/v1+hold` — which then failed the lineage
 * check in `buildAttribution`, because it is not a generation of anything. The
 * workaround was the defect: a hold that has to invent a rule version is a hold
 * recorded under rules nobody wrote, and `07` §10's "rules are versioned" would
 * be satisfied by a string rather than by a lineage.
 *
 * So the hold is its own operation. It keeps the rule version, sets the hold and
 * its reason, links `supersedesId`, and takes its own key suffix — mirroring
 * 2920's `ca_one_supersede_per_row`, which admits one linked row per attribution.
 *
 * The held row is NOT earnable, and the original's figures are carried forward
 * rather than zeroed: `07` §9's controls are detections, and deleting or blanking
 * the evidence a detection produced is the opposite of a control.
 */
export function holdAttribution(original: CreatorAttribution, reason: string): AttributionResult {
  if (!reason) {
    return refuse(
      "unexplained_fraud_hold",
      "a hold with no reason is indistinguishable from a bug; 07 §9 names seven detections, and one of them must be said",
    );
  }
  if (original.fraudHold) {
    return refuse("already_held", `${original.id} is already held for ${original.fraudHoldReason}`);
  }

  const rebuilt = buildAttribution({
    creatorType: original.creatorType,
    subjectId: original.subjectId,
    valueEventId: original.valueEventId,
    beneficiaryUserId: original.beneficiaryUserId,
    // The SAME version: the hold is about this computation, not a new one.
    ruleVersion: original.ruleVersion,
    weight: original.weight,
    confidence: original.confidence,
    grossRevenueMinor: original.grossRevenueMinor,
    provisionalShareMinor: original.provisionalShareMinor,
    fraudHold: true,
    fraudHoldReason: reason,
    currency: original.currency,
    supersedesId: original.id,
  });
  if (rebuilt.status !== "built") return rebuilt;

  const idempotencyKey = `${rebuilt.attribution.idempotencyKey}#hold`;
  return {
    status: "built",
    attribution: { ...rebuilt.attribution, id: idempotencyKey, idempotencyKey },
  };
}
