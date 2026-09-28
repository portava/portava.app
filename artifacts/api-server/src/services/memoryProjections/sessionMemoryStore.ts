/**
 * sessionMemoryStore — the MEMORY stage of S112's lineage, persisted.
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * census-sensing §24.4 / §26.1: the S92 bridge (`./experienceSessionBridge`)
 * carries a closed session's `claim_refs` — the intel_state_snapshots ids its
 * world opportunity rested on — into `provenance_json.claim_refs`, and then
 * NOTHING PERSISTS IT. `memoryProjectionScheduler.runSessionMemoryBridge`
 * returns verdicts; `project_all_memory` (SQL) writes memory_projections from
 * graph edges and reads no claim refs. So "which memories rest on the evidence
 * this person just erased?" had no store to ask.
 *
 * This module is that store's writer. When a session closes, the close route
 * hands the closed envelope here; the EXISTING section-6 gate decides whether
 * it is a Memory (this module adds no gate), and an eligible one is written to
 * memory_projections WITH `claim_refs` (3314's column). The account-deletion
 * reach then finds it by overlap, and the erasure path removes every
 * reference to a snapshot the erasure withdrew.
 *
 * ── THE ROW ──────────────────────────────────────────────────────────────────
 *   memory_type   'episodic'            — it happened (the gate admitted OCCURRED)
 *   subject_type  'experience_session'  — one memory per session; keeps it out
 *                                          of the SQL projector's city/place
 *                                          lanes and, by 3314's predicate, out of
 *                                          that projector's support watermark
 *   subject_id    the session id        — the natural key; a replay is an upsert
 *   claim_refs    the envelope's refs   — the lineage (3314)
 *   provenance    derivation, bridge version, session, place, outcome, the
 *                 gate's policy version — never an actor id or a contributor
 *   visibility    'private'             — an inference about the owner is never
 *                                          more public than the owner (2193's rule)
 *   retention     'durable_fact'        — the same class the projector gives a visit
 *
 * ── FAIL CLOSED, AND NEVER WITHOUT ITS LINEAGE ───────────────────────────────
 * `memory_projection` OFF (absent, false, unreadable) → nothing written. A
 * claim ref that is not a uuid → nothing written (3314's column is uuid[] and a
 * partial write would drop the ref). A database WITHOUT 3314 → nothing written
 * (`claim_refs_unavailable`) — deliberately NOT a retry without the column, as
 * 3311's snapshot writer does. A snapshot written without provenance can still
 * be reached at subject granularity; a memory written without its refs can be
 * reached by nothing, ever. The only safe degradation is not to write it.
 *
 * Every refusal is returned by name; the caller reports it and does not fail
 * the close — the session's outcome is recorded either way.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import type { ExperienceSessionEnvelope } from "../../lib/experienceSession.js";
import type { IntelOutcome } from "../../lib/intelOutcomes.js";
import {
  SESSION_BRIDGE_VERSION,
  sessionMemoryEligibility,
  type SessionBridgeRefusal,
} from "./experienceSessionBridge.js";

/** The memory_projections table, as a literal so check:write-path-columns can read the upsert. */
export const SESSION_MEMORY_TABLE = "memory_projections";
/** One memory per closed session. Also 3314's watermark exemption — the two must agree. */
export const SESSION_MEMORY_SUBJECT_TYPE = "experience_session";
export const SESSION_MEMORY_TYPE = "episodic";

/** What each OCCURRED outcome reads as, to its owner. Only these four can reach the writer. */
export const SESSION_MEMORY_OUTCOME_PHRASE: Readonly<Partial<Record<IntelOutcome, string>>> = Object.freeze({
  better: "better than expected",
  slightly_better: "a little better than expected",
  same: "about as expected",
  worse: "worse than expected",
});

export type SessionMemoryRefusal =
  | SessionBridgeRefusal
  | "no_client"
  | "memory_projection_off"
  | "not_eligible"
  | "claim_ref_not_uuid"
  | "claim_refs_unavailable"
  | "write_failed";

export type SessionMemoryWrite =
  | { recorded: true; claimRefs: number }
  | { recorded: false; refusal: SessionMemoryRefusal; detail?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST's answers for a column it does not know (pre-3314). */
function isMissingClaimRefsColumn(error: any): boolean {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return /claim_refs/.test(message) && (code === "42703" || code === "PGRST204" || /column|schema cache/i.test(message));
}

/** The refs a memory will carry: deduplicated, sorted, and every one a uuid — or null if any is not. */
export function sessionMemoryClaimRefs(envelope: ExperienceSessionEnvelope): string[] | null {
  const out = new Set<string>();
  for (const r of envelope?.claim_refs ?? []) {
    if (typeof r !== "string" || !UUID.test(r)) return null;
    out.add(r.toLowerCase());
  }
  return [...out].sort();
}

/**
 * Write the memory ONE closed session justifies, with its lineage.
 * Never throws; every non-write is a named refusal.
 */
export async function persistSessionMemory(
  sc: any,
  ownerId: string,
  envelope: ExperienceSessionEnvelope,
  nowMs: number,
): Promise<SessionMemoryWrite> {
  if (!sc) return { recorded: false, refusal: "no_client" };
  if (!(await isFlagEnabled(sc, "memory_projection"))) return { recorded: false, refusal: "memory_projection_off" };

  const judged = sessionMemoryEligibility(ownerId, envelope, nowMs);
  if (judged.refusal !== null) return { recorded: false, refusal: judged.refusal };
  if (!judged.eligible || !judged.evidence) {
    return { recorded: false, refusal: "not_eligible", detail: judged.verdict?.reason ?? undefined };
  }

  const refs = sessionMemoryClaimRefs(envelope);
  if (refs === null) return { recorded: false, refusal: "claim_ref_not_uuid" };

  const outcome = envelope.outcome as IntelOutcome;
  const phrase = SESSION_MEMORY_OUTCOME_PHRASE[outcome] ?? "as it turned out";
  const evidence = judged.evidence;
  const nowIso = new Date(nowMs).toISOString();

  try {
    const { error } = await sc.from("memory_projections").upsert(
      {
        user_id: ownerId,
        memory_type: "episodic",
        subject_type: "experience_session",
        subject_id: envelope.session_id,
        content: `Went out on a live suggestion; it was ${phrase}`,
        confidence: evidence.confidence,
        provenance: {
          derivation: "experience_session",
          bridge_version: SESSION_BRIDGE_VERSION,
          session_id: envelope.session_id,
          place_id: envelope.subject_id,
          opportunity_kind: envelope.opportunity_kind,
          origin: envelope.origin,
          outcome,
          close_reason: envelope.close_reason ?? null,
          eligibility_policy_version: judged.verdict?.policy_version ?? null,
          normalizer_version: evidence.normalizer_version,
        },
        sensitivity: "normal",
        visibility: "private",
        state: "active",
        retention_class: "durable_fact",
        valid_from: evidence.observed_at,
        last_supported_at: evidence.observed_at,
        last_projected_at: nowIso,
        updated_at: nowIso,
        claim_refs: refs,
      },
      { onConflict: "user_id,memory_type,subject_type,subject_id" },
    );
    if (error) {
      if (isMissingClaimRefsColumn(error)) return { recorded: false, refusal: "claim_refs_unavailable" };
      return { recorded: false, refusal: "write_failed", detail: String(error?.message ?? error) };
    }
  } catch (e) {
    return { recorded: false, refusal: "write_failed", detail: e instanceof Error ? e.message : String(e) };
  }
  return { recorded: true, claimRefs: refs.length };
}

/**
 * Compile-time tie: the literal `.from("memory_projections")` above must be the
 * exported table name. A rename that is not mirrored stops compiling here.
 */
const _sessionMemoryTableTie: typeof SESSION_MEMORY_TABLE = "memory_projections";
const _sessionMemorySubjectTie: typeof SESSION_MEMORY_SUBJECT_TYPE = "experience_session";
const _sessionMemoryTypeTie: typeof SESSION_MEMORY_TYPE = "episodic";
void _sessionMemoryTableTie;
void _sessionMemorySubjectTie;
void _sessionMemoryTypeTie;
