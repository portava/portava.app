/**
 * Evidence normalization and eligibility.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 6 "Evidence Normalization and Eligibility"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:227)
 *       Section 4 "Enums and Truth Semantics" - TruthLevel + truth precedence (:178)
 *       Section 3.3 MemoryEvidence contract (:96)
 *       Section 28.2 "Never infer 'visited' from saved/planned/nearby alone."
 *       Section 28.13 "Always store provenance and engine/reason-code versions."
 *
 * CENSUS: H54 (normalization pipeline), H55 (eligibility gate),
 *         H56 (rejection-reason registry), H57 (evidence-source strength model)
 *         - all four NOT-BUILT at census time
 *         (docs/architecture/census-highlights-memories.md, section 6).
 *
 * WHAT THIS IS. The spec's pipeline is
 *
 *     RAW SIGNAL -> normalize source and time -> resolve entity candidates
 *       -> privacy/sensitivity pre-check -> deduplicate evidence
 *       -> eligibility gate -> episode candidate -> significance -> candidate Memory
 *
 * This module owns the first five arrows. It is PURE: no database, no clock
 * beyond an injected `now`, no LLM. Section 7 requires the grouping stage to be
 * replayable; that is only true if the stage feeding it is deterministic too.
 *
 * WHAT THIS IS NOT. It does not decide that a Memory exists. It produces
 * normalized evidence and an eligibility verdict; the verdict carries a reason
 * code from a closed, versioned registry so a rejection can be explained to the
 * owner and re-derived later from the same inputs.
 */

/** Bumped whenever a normalization rule changes. Stored on every record (28.13). */
export const EVIDENCE_NORMALIZER_VERSION = "memory-evidence-normalizer@1";
/** Bumped whenever an eligibility rule changes. Stored on every verdict (28.13). */
export const ELIGIBILITY_POLICY_VERSION = "memory-eligibility@1";

/** Section 6 "Evidence-source examples" table - the closed source vocabulary. */
export type EvidenceSourceType =
  | "EXPLICIT_REMEMBER"
  | "TRIP_OUTCOME"
  | "GPS_PROXIMITY"
  | "CAMERA_CAPTURE"
  | "CREW_OVERLAP"
  | "EVENT_TICKET_CHECKIN"
  | "TELEGRAPH_MESSAGE"
  | "STAMP_ISSUANCE"
  | "USER_CORRECTION";

/** Section 4 TruthLevel. */
export type TruthLevel =
  | "USER_ASSERTED"
  | "SYSTEM_OBSERVED"
  | "MUTUALLY_CONFIRMED"
  | "INFERRED"
  | "UNKNOWN";

/** Section 4 ConfidenceBand. */
export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

/**
 * Section 6 assertion vocabulary. The distinction that matters most is
 * OCCURRED vs PLANNED/SAVED/NEARBY: 28.2 forbids the second becoming the first.
 */
export type MemoryAssertionType =
  | "OCCURRED"
  | "PLANNED"
  | "SAVED"
  | "NEARBY"
  | "CO_PRESENT"
  | "CAPTURED_MEDIA"
  | "CORRECTION";

/**
 * Section 4 truth precedence:
 *   explicit user correction > explicit user assertion > mutually confirmed
 *   > strong system observation > inference > unknown
 * Higher rank wins. `mergeByPrecedence` below is the only place this ordering
 * is applied, so there is one implementation of the rule, not five.
 */
export function precedenceRank(e: Pick<NormalizedEvidence, "truth_level" | "is_correction">): number {
  if (e.is_correction) return 6;
  switch (e.truth_level) {
    case "USER_ASSERTED": return 5;
    case "MUTUALLY_CONFIRMED": return 4;
    case "SYSTEM_OBSERVED": return 3;
    case "INFERRED": return 2;
    case "UNKNOWN": return 1;
    default: return 0;
  }
}

/**
 * Section 6 "Evidence-source examples" - the strength/caveat column, made
 * executable. `proves_occurrence_alone` is the load-bearing field: it is what
 * 28.2 turns on.
 */
export interface EvidenceSourceStrength {
  truth_level: TruthLevel;
  /** Ceiling on the confidence a single record of this source may carry. */
  max_confidence: number;
  /** May this source, alone, support "this happened"? */
  proves_occurrence_alone: boolean;
  /** Section 6 caveats, carried so a caller can explain a verdict. */
  caveat: string;
  /** Social context only - supports who, never that every episode was co-attended. */
  social_context_only?: boolean;
  /** Entity links must be validated independently even when intent is strong. */
  entity_links_need_validation?: boolean;
  /** Must be corroborated by another source before becoming historical fact. */
  requires_corroboration?: boolean;
}

export const EVIDENCE_SOURCE_STRENGTH: Readonly<Record<EvidenceSourceType, EvidenceSourceStrength>> = Object.freeze({
  EXPLICIT_REMEMBER: {
    truth_level: "USER_ASSERTED", max_confidence: 0.95, proves_occurrence_alone: true,
    caveat: "Strong user intent; still validate entity links independently.",
    entity_links_need_validation: true,
  },
  USER_CORRECTION: {
    truth_level: "USER_ASSERTED", max_confidence: 1.0, proves_occurrence_alone: true,
    caveat: "Explicit correction. Outranks every inference and is durable (section 4).",
  },
  TRIP_OUTCOME: {
    truth_level: "SYSTEM_OBSERVED", max_confidence: 0.9, proves_occurrence_alone: true,
    caveat: "Strong occurrence evidence IF completion itself is reliable.",
  },
  GPS_PROXIMITY: {
    truth_level: "INFERRED", max_confidence: 0.35, proves_occurrence_alone: false,
    caveat: "Weak alone; typically candidate-level only.",
  },
  CAMERA_CAPTURE: {
    truth_level: "SYSTEM_OBSERVED", max_confidence: 0.7, proves_occurrence_alone: true,
    caveat: "Useful but metadata may be wrong, edited, or imported.",
  },
  CREW_OVERLAP: {
    truth_level: "INFERRED", max_confidence: 0.4, proves_occurrence_alone: false,
    caveat: "Supports social context; does not prove co-attendance at every episode.",
    social_context_only: true,
  },
  EVENT_TICKET_CHECKIN: {
    truth_level: "SYSTEM_OBSERVED", max_confidence: 0.9, proves_occurrence_alone: true,
    caveat: "Strong event attendance evidence.",
  },
  TELEGRAPH_MESSAGE: {
    truth_level: "INFERRED", max_confidence: 0.3, proves_occurrence_alone: false,
    caveat: "Context evidence; must not become historical fact without corroboration.",
    requires_corroboration: true,
  },
  STAMP_ISSUANCE: {
    truth_level: "SYSTEM_OBSERVED", max_confidence: 0.85, proves_occurrence_alone: true,
    caveat: "Strong IF stamp rules are deterministic and certified.",
  },
});

/** A raw signal as it arrives, before normalization. Every field is untrusted. */
export interface RawSignal {
  owner_id?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  assertion_type?: unknown;
  observed_at?: unknown;
  /** IANA zone of the observation, when the producer knows it. */
  observed_timezone?: unknown;
  assertion_json?: Record<string, unknown> | null;
  /** Producer-declared confidence; clamped to the source ceiling below. */
  confidence?: unknown;
  provenance_json?: Record<string, unknown> | null;
  expires_at?: unknown;
}

/** Section 3.3 MemoryEvidence, normalized. */
export interface NormalizedEvidence {
  owner_id: string;
  source_type: EvidenceSourceType;
  source_id: string;
  assertion_type: MemoryAssertionType;
  assertion_json: Record<string, unknown>;
  truth_level: TruthLevel;
  confidence: number;
  /** Always UTC ISO-8601 with milliseconds. Time normalization lives here. */
  observed_at: string;
  observed_timezone: string | null;
  expires_at: string | null;
  provenance_json: Record<string, unknown>;
  is_correction: boolean;
  /** Stable identity of the underlying claim; drives deduplication. */
  fingerprint: string;
  normalizer_version: string;
}

export type NormalizationRejectionReason =
  | "UNKNOWN_SOURCE_TYPE"
  | "UNKNOWN_ASSERTION_TYPE"
  | "MISSING_OWNER"
  | "MISSING_SOURCE_ID"
  | "UNPARSEABLE_OBSERVED_AT"
  | "OBSERVED_AT_IN_FUTURE";

export type NormalizeResult =
  | { ok: true; evidence: NormalizedEvidence }
  | { ok: false; reason: NormalizationRejectionReason; detail: string; normalizer_version: string };

const ASSERTION_TYPES: ReadonlySet<string> = new Set<MemoryAssertionType>([
  "OCCURRED", "PLANNED", "SAVED", "NEARBY", "CO_PRESENT", "CAPTURED_MEDIA", "CORRECTION",
]);

/** Clock skew a producer is allowed. Beyond it, a future observation is rejected. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Deterministic, dependency-free digest. Same input, same text, every run. */
function digest(parts: readonly string[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  const s = parts.join("\u0000");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c + i), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 + (c * (i + 1)), 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

export { digest as evidenceDigest };

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Section 6 arrow 1: normalize source and time.
 *
 * Returns a REJECTION rather than a best-effort record: a signal whose time
 * cannot be parsed must not enter the pipeline carrying `now` as its timestamp,
 * because every downstream stage (episode boundaries, anniversaries, "first
 * night in Da Nang") would then be asserting a time nobody observed.
 */
export function normalizeEvidence(raw: RawSignal, now: Date): NormalizeResult {
  const reject = (reason: NormalizationRejectionReason, detail: string): NormalizeResult =>
    ({ ok: false, reason, detail, normalizer_version: EVIDENCE_NORMALIZER_VERSION });

  if (!isNonEmptyString(raw.owner_id)) return reject("MISSING_OWNER", "owner_id absent or not a string");
  const sourceType = raw.source_type;
  if (typeof sourceType !== "string" || !Object.prototype.hasOwnProperty.call(EVIDENCE_SOURCE_STRENGTH, sourceType)) {
    return reject("UNKNOWN_SOURCE_TYPE", `source_type=${String(sourceType)}`);
  }
  const st = sourceType as EvidenceSourceType;
  if (!isNonEmptyString(raw.source_id)) return reject("MISSING_SOURCE_ID", `source_type=${st}`);

  const assertion = raw.assertion_type;
  if (typeof assertion !== "string" || !ASSERTION_TYPES.has(assertion)) {
    return reject("UNKNOWN_ASSERTION_TYPE", `assertion_type=${String(assertion)}`);
  }
  const at = assertion as MemoryAssertionType;

  const observedRaw = raw.observed_at;
  const observed =
    typeof observedRaw === "string" ? new Date(observedRaw)
    : observedRaw instanceof Date ? new Date(observedRaw.getTime())
    : typeof observedRaw === "number" ? new Date(observedRaw)
    : new Date(NaN);
  if (Number.isNaN(observed.getTime())) {
    return reject("UNPARSEABLE_OBSERVED_AT", `observed_at=${String(observedRaw)}`);
  }
  if (observed.getTime() > now.getTime() + FUTURE_SKEW_MS) {
    return reject("OBSERVED_AT_IN_FUTURE", `observed_at=${observed.toISOString()} now=${now.toISOString()}`);
  }

  const strength = EVIDENCE_SOURCE_STRENGTH[st];
  const declared = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? raw.confidence
    : strength.max_confidence;
  // Clamp, never trust: a producer may not raise its own source above the
  // section 6 ceiling for that source class.
  const confidence = Math.max(0, Math.min(strength.max_confidence, declared));

  const expires = typeof raw.expires_at === "string" ? new Date(raw.expires_at) : null;
  const assertionJson = raw.assertion_json && typeof raw.assertion_json === "object" ? { ...raw.assertion_json } : {};

  const isCorrection = st === "USER_CORRECTION" || at === "CORRECTION";

  const fingerprint = digest([
    raw.owner_id, st, raw.source_id, at,
    // Time is bucketed to the minute: the same claim re-delivered with a
    // slightly different capture timestamp is one claim, not two.
    String(Math.floor(observed.getTime() / 60000)),
    stableStringify(assertionJson.subject_ref ?? null),
  ]);

  return {
    ok: true,
    evidence: {
      owner_id: raw.owner_id,
      source_type: st,
      source_id: raw.source_id,
      assertion_type: at,
      assertion_json: assertionJson,
      truth_level: strength.truth_level,
      confidence,
      observed_at: observed.toISOString(),
      observed_timezone: typeof raw.observed_timezone === "string" ? raw.observed_timezone : null,
      expires_at: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : null,
      provenance_json: {
        ...(raw.provenance_json && typeof raw.provenance_json === "object" ? raw.provenance_json : {}),
        normalizer_version: EVIDENCE_NORMALIZER_VERSION,
        source_caveat: strength.caveat,
        declared_confidence: declared,
        confidence_ceiling: strength.max_confidence,
      },
      is_correction: isCorrection,
      fingerprint,
      normalizer_version: EVIDENCE_NORMALIZER_VERSION,
    },
  };
}

/**
 * Section 6 arrow 4: deduplicate evidence.
 *
 * Keeps the highest-precedence record per fingerprint (section 4 truth
 * precedence), breaking ties on confidence and then on source_id so the result
 * is stable under input reordering - a replay requirement (section 7, 25).
 */
export function dedupeEvidence(
  records: readonly NormalizedEvidence[],
): { kept: NormalizedEvidence[]; dropped: Array<{ fingerprint: string; source_id: string; superseded_by: string }> } {
  const best = new Map<string, NormalizedEvidence>();
  const dropped: Array<{ fingerprint: string; source_id: string; superseded_by: string }> = [];
  const ordered = [...records].sort(
    (a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.source_id.localeCompare(b.source_id),
  );
  for (const rec of ordered) {
    const current = best.get(rec.fingerprint);
    if (!current) { best.set(rec.fingerprint, rec); continue; }
    const better =
      precedenceRank(rec) > precedenceRank(current) ||
      (precedenceRank(rec) === precedenceRank(current) && rec.confidence > current.confidence);
    if (better) {
      best.set(rec.fingerprint, rec);
      dropped.push({ fingerprint: current.fingerprint, source_id: current.source_id, superseded_by: rec.source_id });
    } else {
      dropped.push({ fingerprint: rec.fingerprint, source_id: rec.source_id, superseded_by: current.source_id });
    }
  }
  const kept = [...best.values()].sort(
    (a, b) => a.observed_at.localeCompare(b.observed_at) || a.source_id.localeCompare(b.source_id),
  );
  return { kept, dropped };
}

/**
 * Section 4: "A lower-confidence inference may never overwrite a
 * higher-precedence user correction." Applied field-wise, not row-wise, so a
 * correction to the place does not freeze the timestamp.
 */
export function mergeByPrecedence(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  basis: { base: NormalizedEvidence; incoming: NormalizedEvidence },
): { merged: Record<string, unknown>; refused: string[] } {
  const merged: Record<string, unknown> = { ...base };
  const refused: string[] = [];
  const incomingWins = precedenceRank(basis.incoming) > precedenceRank(basis.base);
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in merged) || merged[k] === null || merged[k] === undefined) { merged[k] = v; continue; }
    if (incomingWins) { merged[k] = v; continue; }
    if (merged[k] !== v) refused.push(k);
  }
  return { merged, refused };
}

/** Section 6 "Eligibility rejection reasons" - the closed registry, in spec order. */
export type EligibilityRejectionReason =
  | "INSUFFICIENT_OCCURRENCE_EVIDENCE"
  | "PLANNED_OR_SAVED_ONLY"
  | "PASS_BY_NOT_VISIT"
  | "DUPLICATE_OF_EXISTING"
  | "SENSITIVE_CONTEXT"
  | "MEDIA_NOT_CAPTURED"
  | "BELOW_TRIVIALITY_THRESHOLD"
  | "INFERENCE_SUPPRESSED_BY_POLICY";

export const ELIGIBILITY_REJECTION_REASONS: readonly EligibilityRejectionReason[] = Object.freeze([
  "INSUFFICIENT_OCCURRENCE_EVIDENCE",
  "PLANNED_OR_SAVED_ONLY",
  "PASS_BY_NOT_VISIT",
  "DUPLICATE_OF_EXISTING",
  "SENSITIVE_CONTEXT",
  "MEDIA_NOT_CAPTURED",
  "BELOW_TRIVIALITY_THRESHOLD",
  "INFERENCE_SUPPRESSED_BY_POLICY",
] as const);

export interface EligibilityContext {
  /** Fingerprints already backing a Memory/Episode the owner has. */
  existing_fingerprints?: ReadonlySet<string>;
  /** Places the owner (or policy) marked sensitive (section 11). */
  sensitive_place_ids?: ReadonlySet<string>;
  /** Inference classes the owner or policy suppressed (section 6, last reason). */
  suppressed_classes?: ReadonlySet<string>;
  /** Minimum dwell for a proximity-only signal to be a visit rather than a pass-by. */
  min_dwell_seconds?: number;
  /** Set when the candidate is assembled at the owner's explicit request. */
  mode?: "AUTOMATIC" | "USER_INITIATED";
  /** Supplied by section 8 once scored; only used for the triviality reason. */
  significance_tier?: "AUTO_PRIVATE" | "SUGGESTED" | "NO_CANDIDATE";
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: EligibilityRejectionReason | null;
  detail: string;
  /** Every check that ran and what it saw - a verdict must be explainable. */
  checks: Array<{ reason: EligibilityRejectionReason; tripped: boolean; detail: string }>;
  policy_version: string;
}

const DEFAULT_MIN_DWELL_SECONDS = 600;

/**
 * Section 6 arrow 5: the eligibility gate.
 *
 * Order is fixed and documented so two runs over the same inputs return the same
 * reason code, and so the reason a person is shown is the FIRST thing that was
 * wrong rather than whichever check happened to run last.
 */
export function evaluateEligibility(
  evidence: readonly NormalizedEvidence[],
  ctx: EligibilityContext = {},
): EligibilityVerdict {
  const checks: EligibilityVerdict["checks"] = [];
  const mode = ctx.mode ?? "AUTOMATIC";

  if (evidence.length === 0) {
    checks.push({ reason: "INSUFFICIENT_OCCURRENCE_EVIDENCE", tripped: true, detail: "no evidence at all" });
    return {
      eligible: false, reason: "INSUFFICIENT_OCCURRENCE_EVIDENCE", detail: "no evidence at all",
      checks, policy_version: ELIGIBILITY_POLICY_VERSION,
    };
  }

  const hasUserAssertion = evidence.some((e) => e.truth_level === "USER_ASSERTED");
  const occurrenceBearing = evidence.filter(
    (e) => e.assertion_type === "OCCURRED" || e.assertion_type === "CAPTURED_MEDIA" || e.assertion_type === "CORRECTION",
  );

  const ordered: Array<[EligibilityRejectionReason, () => { tripped: boolean; detail: string }]> = [
    // 28.2. A saved or planned activity is not an experience, whatever else is true.
    ["PLANNED_OR_SAVED_ONLY", () => {
      const onlyIntent = evidence.every((e) => e.assertion_type === "PLANNED" || e.assertion_type === "SAVED");
      return { tripped: onlyIntent, detail: onlyIntent ? "every record is PLANNED/SAVED" : "at least one non-intent record" };
    }],
    // Section 6: policy or the owner may suppress a class of inference. An explicit
    // user assertion is not an inference, so suppression cannot silence the owner.
    ["INFERENCE_SUPPRESSED_BY_POLICY", () => {
      const suppressed = ctx.suppressed_classes ?? new Set<string>();
      if (suppressed.size === 0) return { tripped: false, detail: "no suppressed classes" };
      if (hasUserAssertion) return { tripped: false, detail: "user assertion present; suppression applies to inference only" };
      const hit = evidence.find(
        (e) => suppressed.has(String(e.assertion_json.inference_class ?? "")) || suppressed.has(e.source_type),
      );
      return { tripped: Boolean(hit), detail: hit ? `suppressed class via ${hit.source_type}` : "no suppressed class matched" };
    }],
    // Section 6: media that was downloaded or screenshotted is not a captured experience.
    ["MEDIA_NOT_CAPTURED", () => {
      const media = evidence.filter((e) => e.assertion_type === "CAPTURED_MEDIA");
      if (media.length === 0) return { tripped: false, detail: "no media evidence" };
      const notCaptured = media.every((e) => {
        const prov = String(e.assertion_json.capture_provenance ?? "");
        return prov === "screenshot" || prov === "downloaded" || prov === "imported_without_capture";
      });
      const otherOccurrence = occurrenceBearing.some((e) => e.assertion_type !== "CAPTURED_MEDIA");
      return {
        tripped: notCaptured && !otherOccurrence,
        detail: notCaptured
          ? "all media is screenshot/downloaded/imported and nothing else attests occurrence"
          : "at least one captured item",
      };
    }],
    // Section 11: sensitive context is not eligible for AUTOMATIC candidacy. The
    // owner may still create the Memory deliberately (mode USER_INITIATED).
    ["SENSITIVE_CONTEXT", () => {
      const sensitive = ctx.sensitive_place_ids ?? new Set<string>();
      const hit =
        evidence.find((e) => {
          const pid = e.assertion_json.place_id;
          return typeof pid === "string" && sensitive.has(pid);
        }) ?? evidence.find((e) => e.assertion_json.sensitive === true);
      if (!hit) return { tripped: false, detail: "no sensitive marker" };
      if (mode === "USER_INITIATED") return { tripped: false, detail: "sensitive, but owner-initiated" };
      return { tripped: true, detail: "sensitive context under automatic candidacy" };
    }],
    // Section 6: proximity without dwell is a pass-by.
    ["PASS_BY_NOT_VISIT", () => {
      const minDwell = ctx.min_dwell_seconds ?? DEFAULT_MIN_DWELL_SECONDS;
      const strongest = evidence.filter((e) => EVIDENCE_SOURCE_STRENGTH[e.source_type].proves_occurrence_alone);
      if (strongest.length > 0) return { tripped: false, detail: "an occurrence-bearing source is present" };
      const proximity = evidence.filter((e) => e.source_type === "GPS_PROXIMITY" || e.assertion_type === "NEARBY");
      if (proximity.length === 0) return { tripped: false, detail: "no proximity-only signal" };
      const maxDwell = Math.max(...proximity.map((e) => Number(e.assertion_json.dwell_seconds ?? 0)));
      return { tripped: maxDwell < minDwell, detail: `max dwell ${maxDwell}s vs floor ${minDwell}s` };
    }],
    // Section 6: a candidate that restates a Memory the owner already has is noise.
    ["DUPLICATE_OF_EXISTING", () => {
      const existing = ctx.existing_fingerprints ?? new Set<string>();
      if (existing.size === 0) return { tripped: false, detail: "no existing fingerprints supplied" };
      const dupes = evidence.filter((e) => existing.has(e.fingerprint));
      return {
        tripped: dupes.length === evidence.length,
        detail: `${dupes.length}/${evidence.length} records already backed a Memory`,
      };
    }],
    // Section 6/8: nothing here attests that anything happened.
    ["INSUFFICIENT_OCCURRENCE_EVIDENCE", () => {
      const proving = evidence.filter(
        (e) => EVIDENCE_SOURCE_STRENGTH[e.source_type].proves_occurrence_alone &&
          (e.assertion_type === "OCCURRED" || e.assertion_type === "CAPTURED_MEDIA" || e.assertion_type === "CORRECTION"),
      );
      if (proving.length > 0) return { tripped: false, detail: `${proving.length} occurrence-bearing record(s)` };
      // Corroboration: two independent weak sources may together clear the floor.
      const distinctWeak = new Set(
        evidence.filter((e) => e.assertion_type !== "PLANNED" && e.assertion_type !== "SAVED").map((e) => e.source_type),
      );
      const combined = 1 - evidence.reduce((acc, e) => acc * (1 - e.confidence), 1);
      const cleared = distinctWeak.size >= 2 && combined >= 0.6;
      return {
        tripped: !cleared,
        detail: `no occurrence-bearing source; ${distinctWeak.size} distinct weak sources, combined ${combined.toFixed(2)}`,
      };
    }],
    // Section 8 supplies this; the gate only reports it.
    ["BELOW_TRIVIALITY_THRESHOLD", () => {
      if (ctx.significance_tier === undefined) return { tripped: false, detail: "not scored yet" };
      return { tripped: ctx.significance_tier === "NO_CANDIDATE", detail: `tier ${ctx.significance_tier}` };
    }],
  ];

  let firstFailure: { reason: EligibilityRejectionReason; detail: string } | null = null;
  for (const [reason, run] of ordered) {
    const { tripped, detail } = run();
    checks.push({ reason, tripped, detail });
    if (tripped && firstFailure === null) firstFailure = { reason, detail };
  }

  return firstFailure
    ? { eligible: false, reason: firstFailure.reason, detail: firstFailure.detail, checks, policy_version: ELIGIBILITY_POLICY_VERSION }
    : { eligible: true, reason: null, detail: "all eligibility checks passed", checks, policy_version: ELIGIBILITY_POLICY_VERSION };
}

/**
 * Section 4 ConfidenceBand from combined evidence confidence. Bands, not a raw
 * number, are what cross a service boundary.
 */
export function confidenceBandOf(
  evidence: readonly Pick<NormalizedEvidence, "confidence" | "source_type">[],
): ConfidenceBand {
  if (evidence.length === 0) return "INSUFFICIENT";
  const combined = 1 - evidence.reduce((acc, e) => acc * (1 - Math.max(0, Math.min(1, e.confidence))), 1);
  const hasProof = evidence.some((e) => EVIDENCE_SOURCE_STRENGTH[e.source_type].proves_occurrence_alone);
  // Weak inference does not accumulate into certainty. Five proximity pings are
  // five weak readings of the same weak kind: with no occurrence-bearing source
  // present the band is capped at LOW however many records arrive.
  if (!hasProof) return combined < 0.5 ? "INSUFFICIENT" : "LOW";
  if (combined >= 0.85) return "HIGH";
  if (combined >= 0.6) return "MEDIUM";
  if (combined >= 0.3) return "LOW";
  return "INSUFFICIENT";
}
