/**
 * sessionRevocationReach — S112's last two stages, made reachable.
 *
 * ── WHAT THE CENSUS SAID WAS MISSING ─────────────────────────────────────────
 * S112: five stages are defined and executable, and *"the session and memory
 * stages are prevented only because nothing bridges to them. RED WHEN a session
 * exists (S30) and a memory bridge exists (S54/S92) for a revocation to
 * reach."* Both now exist — `lib/experienceSession` and
 * `./experienceSessionBridge` — so this is the reach.
 *
 * ── THE ONE FIELD THAT MAKES IT POSSIBLE ─────────────────────────────────────
 * An `ExperienceSession` carries `claim_refs`: the `intel_state_snapshots` ids
 * the world opportunity rested on. They are opaque and name no contributor,
 * which is why the session may be RETAINED after a revocation — and they are
 * also the only thread connecting a session, and any Memory derived from it,
 * back to the evidence behind it. The S92 bridge carries them into
 * `provenance_json.claim_refs` for exactly this reason.
 *
 * Before that bridge existed there was no field to follow, so the question
 * "which memories rest on the evidence this person just revoked?" could not be
 * ASKED, let alone answered. That is what "the stages do not exist" meant.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not delete, recompute or retract anything. Migration 2130:449-452
 * ruled that derived claims and snapshots SURVIVE a revocation, because
 * *"Deleting them here would destroy other people's contributions"*, and
 * 2130:452 defers recomputation-after-erasure to *"IG-04's responsibility"*.
 * This module does not take that decision and does not pre-empt it. It answers
 * the enumeration question the lineage needs — WHICH sessions and WHICH memory
 * records a revocation reaches — and returns it as data for whoever owns the
 * recomputation.
 *
 * It also refuses to guess. A session that rests on NO claims is not "reached
 * by everything"; it is unreachable through this thread, and it is reported as
 * such rather than swept into the affected set. An empty revocation set reaches
 * nothing, not everything.
 *
 * PURE. No I/O, no clock. Reads no store and no identity.
 */
import type { ExperienceSessionEnvelope } from "../../lib/experienceSession.js";
import type { NormalizedEvidence } from "./evidence.js";

/**
 * §18.4's five stages, RESTATED rather than imported, and the reason is a
 * tripwire rather than a preference.
 *
 * `sensingCensusRederivation` §9.1 asserts that the sensing contribution stack
 * — `lib/sensingRevocationLineage` among the ten — is imported by its own
 * siblings and by NOTHING else, because a new importer is how an ingest path
 * would first appear, and thirteen census rows are graded on that absence. This
 * module sits outside that stack, so importing even the stage TYPE from it
 * would trip a tripwire built to catch something else entirely, and silencing
 * it by allowlisting this file is what that test's own comment forbids.
 *
 * Restating a five-string vocabulary is the smaller cost, and the drift it
 * risks is closed in the test: `sensingConsumersRevocationReach` asserts this
 * list equals `SENSING_LINEAGE_STAGES` value for value, and a test file is not
 * subject to §9.1's walk.
 */
export const REACHABLE_LINEAGE_STAGES = ["raw", "aggregate", "inference", "session", "memory"] as const;
export type SensingLineageStage = (typeof REACHABLE_LINEAGE_STAGES)[number];

/** Why a session or memory record is, or is not, reached by a revocation. */
export type ReachVerdict =
  /** At least one claim the record rested on was revoked. */
  | "reached"
  /** The record rests on claims, none of them revoked. */
  | "unaffected"
  /** The record rests on NO claim refs — this thread cannot reach it either way. */
  | "no_claim_thread";

export interface SessionReach {
  sessionId: string;
  subjectId: string;
  verdict: ReachVerdict;
  /** The revoked claim ids this record actually rested on, sorted. */
  revokedClaimRefs: string[];
  /** Everything it rested on, sorted — so a verdict can be re-derived by hand. */
  claimRefs: string[];
}

export interface MemoryReach {
  /** `NormalizedEvidence.source_id` — the session id, for a bridged record. */
  sourceId: string;
  sourceType: string;
  verdict: ReachVerdict;
  revokedClaimRefs: string[];
  claimRefs: string[];
}

function normalizeRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value) if (typeof v === "string" && v.length > 0) out.add(v);
  return [...out].sort();
}

function judge(claimRefs: readonly string[], revoked: ReadonlySet<string>): {
  verdict: ReachVerdict;
  revokedClaimRefs: string[];
} {
  if (claimRefs.length === 0) return { verdict: "no_claim_thread", revokedClaimRefs: [] };
  const hit = claimRefs.filter((r) => revoked.has(r)).sort();
  return { verdict: hit.length > 0 ? "reached" : "unaffected", revokedClaimRefs: hit };
}

/** Does a revocation of these snapshot ids reach this session? */
export function sessionReach(
  envelope: ExperienceSessionEnvelope,
  revokedClaimRefs: ReadonlySet<string>,
): SessionReach {
  const claimRefs = normalizeRefs(envelope?.claim_refs);
  return {
    sessionId: String(envelope?.session_id ?? ""),
    subjectId: String(envelope?.subject_id ?? ""),
    claimRefs,
    ...judge(claimRefs, revokedClaimRefs),
  };
}

/**
 * The same question of a memory record the S92 bridge produced. The refs are
 * read from `provenance_json.claim_refs`, which is where and only where the
 * bridge puts them.
 */
export function memoryReach(
  evidence: NormalizedEvidence,
  revokedClaimRefs: ReadonlySet<string>,
): MemoryReach {
  const claimRefs = normalizeRefs(
    (evidence?.provenance_json as Record<string, unknown> | undefined)?.claim_refs,
  );
  return {
    sourceId: String(evidence?.source_id ?? ""),
    sourceType: String(evidence?.source_type ?? ""),
    claimRefs,
    ...judge(claimRefs, revokedClaimRefs),
  };
}

/**
 * A memory as it is STORED (3314): its row id and the `claim_refs` column the
 * session memory store wrote. Kept as a separate shape rather than folded into
 * `NormalizedEvidence`, because a stored row is not evidence — it is what the
 * gate admitted — and the reach must not pretend otherwise to reuse a type.
 */
export interface StoredMemoryRef {
  id: string;
  claimRefs: readonly string[];
}

/** Does a revocation of these snapshot ids reach this STORED memory? */
export function storedMemoryReach(
  memory: StoredMemoryRef,
  revokedClaimRefs: ReadonlySet<string>,
): MemoryReach {
  const claimRefs = normalizeRefs(memory?.claimRefs as unknown);
  return {
    sourceId: String(memory?.id ?? ""),
    sourceType: "memory_projection",
    claimRefs,
    ...judge(claimRefs, revokedClaimRefs),
  };
}

export interface LineageReachReport {
  /** The stages this revocation actually touched, in §18.4 order. */
  stagesReached: SensingLineageStage[];
  sessions: SessionReach[];
  memories: MemoryReach[];
}

/**
 * The whole reach in one call: which sessions and which memory records a
 * revocation of these snapshot ids touches, and therefore which of §18.4's
 * stages it got to.
 *
 * `stagesReached` reports only what was FOUND, never what the table permits: a
 * revocation that reaches no session reports no session stage, even though the
 * canonical path allows one. A lineage that claimed a stage it did not touch
 * would be exactly the "implementation accident decides retention" §18.4
 * forbids.
 */
export function revocationReach(
  sessions: readonly ExperienceSessionEnvelope[],
  memories: readonly NormalizedEvidence[],
  revokedClaimRefs: Iterable<string>,
  storedMemories: readonly StoredMemoryRef[] = [],
): LineageReachReport {
  const revoked = new Set<string>();
  for (const r of revokedClaimRefs) if (typeof r === "string" && r.length > 0) revoked.add(r);

  const sessionReports = sessions.map((s) => sessionReach(s, revoked));
  const memoryReports = [
    ...memories.map((m) => memoryReach(m, revoked)),
    ...storedMemories.map((m) => storedMemoryReach(m, revoked)),
  ];

  const stages: SensingLineageStage[] = [];
  // `raw` and `aggregate` are reached by definition: a revocation is a deletion
  // of raw rows, and the aggregate is what it was computed into. They are named
  // here only when there was something to revoke at all.
  if (revoked.size > 0) stages.push("raw", "aggregate", "inference");
  if (sessionReports.some((s) => s.verdict === "reached")) stages.push("session");
  if (memoryReports.some((m) => m.verdict === "reached")) stages.push("memory");

  return { stagesReached: stages, sessions: sessionReports, memories: memoryReports };
}

/**
 * The property that makes "RETAINED, de-identified" honest at the session and
 * memory stages, rather than a euphemism: neither carries anything that
 * identifies the revoking contributor. Returns the offending field, or null.
 *
 * Mirrors `lib/sensingRevocationLineage.aggregateCarriesIdentity` deliberately
 * — same question, same shape, asked of the two stages that did not exist when
 * that function was written.
 */
export function reachedStageCarriesIdentity(
  value: unknown,
  identifiers: readonly string[],
): string | null {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    // An unserialisable record cannot be shown to be clean, so it is not.
    return "unserialisable";
  }
  for (const id of identifiers) {
    if (typeof id === "string" && id.length > 0 && json.includes(id)) return id;
  }
  return null;
}
