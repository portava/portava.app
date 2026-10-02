/**
 * experienceSessionBridge — S92's arrow, built from the session's OUTCOME.
 *
 *   Sensing §5.4 / §19:  WORLD STATE → OPPORTUNITY → ACTION →
 *                        EXPERIENCE SESSION → OUTCOME → MEMORY / CALIBRATION
 *
 * ── WHAT WAS WRONG, IN THE CENSUS'S OWN WORDS ────────────────────────────────
 * S92: *"Eligibility and decay exist; the bridge is a graph-edge projection and
 * grep over lib/memoryProjectionScheduler.ts and services/memoryProjections/
 * finds no ExperienceSession of any spelling."* The row's RED WHEN is that S54
 * exists *"and memory eligibility is computed from a session's OUTCOME rather
 * than from a graph edge"*. S54 now exists (lib/experienceSession), so this is
 * that computation.
 *
 * ── WHY AN EDGE AND AN OUTCOME ARE NOT THE SAME FACT ─────────────────────────
 * This is the whole substance of the row, so it is stated as a case rather than
 * as a principle. A `compass_graph_edges` row exists as soon as a person
 * INTERACTED with a place — it is a relationship, and relationships are
 * symmetric about disappointment. It cannot distinguish:
 *
 *   • someone who went and loved it            (`better`)
 *   • someone who went and was let down        (`worse`)
 *   • someone who DECIDED NOT TO GO            (`did_not_go`)
 *   • someone who turned up and was refused    (`could_not_enter`)
 *   • someone who opened a session and never came back to close it
 *
 * All five produce the same edge, and projecting a Memory from that edge makes
 * a memory of an evening that did not happen. The outcome vocabulary
 * (lib/intelOutcomes.INTEL_OUTCOMES) separates them, so this module maps each
 * outcome to what it ACTUALLY ASSERTS and lets the existing gate judge it.
 *
 * ── IT ADDS NO GATE, AND THAT IS DELIBERATE ──────────────────────────────────
 * The eligibility rules are section 6's and already exist in `./evidence`
 * (`evaluateEligibility`). A second gate here would be a second opinion about
 * what counts as a Memory, and the two would drift. So this module only decides
 * WHAT THE SESSION SAYS — owner, place, time, assertion type, confidence — and
 * hands it to that gate as ordinary evidence. Every refusal below is a refusal
 * to SPEAK, never a refusal to admit:
 *
 *   `did_not_go`      → PLANNED  → the gate's PLANNED_OR_SAVED_ONLY refuses it.
 *   `could_not_enter` → NEARBY   → no occurrence-bearing record; the gate's
 *                                  INSUFFICIENT_OCCURRENCE_EVIDENCE refuses it.
 *   went              → OCCURRED → the gate admits it, subject to every other
 *                                  check (sensitive context, duplicates, …).
 *
 * ── AN UNCLOSED SESSION IS NOT A VISIT ───────────────────────────────────────
 * A session with no outcome is refused here, before the gate, because there is
 * no outcome to compute from. An OPEN session is someone's evening in progress;
 * an EXPIRED one is a session whose window closed without a report, and
 * lib/experienceSession already refuses to close it with an outcome after the
 * fact *"because an outcome reported after the window is not evidence about
 * that window"*. Treating either as a visit is the edge's mistake in a new
 * place, so neither produces a signal.
 *
 * ── THE LINEAGE HOOK (S112) ──────────────────────────────────────────────────
 * `claim_refs` travels into `provenance_json` verbatim. Those are the snapshot
 * ids the opportunity rested on, and they are the ONLY thing connecting a
 * Memory back to the world evidence behind it — which is what makes a
 * revocation able to REACH the session and memory stages
 * (lib/sensingRevocationLineage). Dropping them here would silently sever the
 * lineage while leaving every test green, so the bridge test pins their
 * presence.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected). Writes nothing.
 */
import {
  SESSION_FORBIDDEN_KEYS,
  sessionForbiddenKeys,
  sessionState,
  type ExperienceSessionEnvelope,
} from "../../lib/experienceSession.js";
import type { IntelOutcome } from "../../lib/intelOutcomes.js";
import {
  EVIDENCE_SOURCE_STRENGTH,
  evaluateEligibility,
  normalizeEvidence,
  type EligibilityContext,
  type EligibilityVerdict,
  type MemoryAssertionType,
  type NormalizedEvidence,
  type RawSignal,
} from "./evidence.js";

/** Bumped whenever the outcome→assertion mapping or a confidence below changes. */
export const SESSION_BRIDGE_VERSION = "memory-session-bridge@1";

/**
 * THE ROW, as data a test can walk: what each outcome asserts about whether the
 * experience happened. Total over `INTEL_OUTCOMES` — a new outcome will fail to
 * compile here rather than silently default to OCCURRED, which is the direction
 * that would invent memories.
 */
export const OUTCOME_ASSERTION: Readonly<Record<IntelOutcome, MemoryAssertionType>> = Object.freeze({
  better: "OCCURRED",
  slightly_better: "OCCURRED",
  same: "OCCURRED",
  worse: "OCCURRED",
  /** They decided not to go. The intent existed; the experience did not. */
  did_not_go: "PLANNED",
  /** They arrived and were refused entry. Presence, not experience. */
  could_not_enter: "NEARBY",
});

/**
 * How sure the OCCURRENCE is — never how good the evening was. `worse` is
 * exactly as strong an occurrence claim as `better`: a disappointing experience
 * still happened. Clamped to the source ceiling by `normalizeEvidence`.
 */
export const OUTCOME_CONFIDENCE: Readonly<Record<IntelOutcome, number>> = Object.freeze({
  better: 0.8,
  slightly_better: 0.8,
  same: 0.8,
  worse: 0.8,
  did_not_go: 0.2,
  could_not_enter: 0.5,
});

export type SessionBridgeRefusal =
  /** The session is still open — an evening in progress is not a memory. */
  | "session_open"
  /** The window closed with no outcome reported. Nothing to compute from. */
  | "session_expired_without_outcome"
  /** Closed for a non-outcome reason (`expired` / `abandoned`) and carries none. */
  | "closed_without_outcome"
  /** An outcome outside `INTEL_OUTCOMES`. Refused rather than guessed. */
  | "unknown_outcome"
  /** A trail-shaped key reached the envelope. Refused, loudly. */
  | "forbidden_key"
  /** No owner to attribute the memory to. */
  | "owner_required";

export type SessionSignalResult =
  | { ok: true; signal: RawSignal; assertion: MemoryAssertionType }
  | { ok: false; reason: SessionBridgeRefusal; field?: string };

/**
 * Turn ONE closed session into the raw memory signal it justifies.
 *
 * The session's own state is recomputed with `sessionState` rather than trusted
 * from `phase`, so a closed-looking envelope past its expiry cannot slip an
 * outcome in behind the window rule.
 */
export function sessionMemorySignal(
  ownerId: string,
  envelope: ExperienceSessionEnvelope,
  nowMs: number,
): SessionSignalResult {
  if (typeof ownerId !== "string" || ownerId.length === 0) return { ok: false, reason: "owner_required" };

  // A trail cannot be smuggled in through the bridge either. The same check the
  // session's own writer runs, run again on the way out: this module is the
  // first thing that turns a session into something DURABLE.
  const forbidden = sessionForbiddenKeys(envelope);
  if (forbidden.length > 0) return { ok: false, reason: "forbidden_key", field: forbidden[0] };

  if (envelope.phase !== "closed") {
    // `sessionState` distinguishes an evening in progress from one whose window
    // ran out, and the two are different facts about the person.
    return {
      ok: false,
      reason: sessionState(envelope, nowMs) === "expired" ? "session_expired_without_outcome" : "session_open",
    };
  }

  const outcome = envelope.outcome;
  if (outcome === undefined || outcome === null) return { ok: false, reason: "closed_without_outcome" };
  const assertion = OUTCOME_ASSERTION[outcome as IntelOutcome];
  if (assertion === undefined) return { ok: false, reason: "unknown_outcome" };

  const signal: RawSignal = {
    owner_id: ownerId,
    source_type: "EXPERIENCE_SESSION",
    // One session, one record. The session id is already unique per bridge, so
    // the gate's DUPLICATE_OF_EXISTING works without a second identity scheme.
    source_id: envelope.session_id,
    assertion_type: assertion,
    observed_at: envelope.closed_at ?? envelope.opened_at,
    assertion_json: {
      place_id: envelope.subject_id,
      opportunity_kind: envelope.opportunity_kind,
      origin: envelope.origin,
      outcome,
      // Present only when the owner gave one; never defaulted to a middle
      // rating, which would invent feedback nobody left.
      ...(typeof envelope.experience_rating === "number"
        ? { experience_rating: envelope.experience_rating }
        : {}),
    },
    confidence: OUTCOME_CONFIDENCE[outcome as IntelOutcome],
    provenance_json: {
      bridge_version: SESSION_BRIDGE_VERSION,
      session_id: envelope.session_id,
      close_reason: envelope.close_reason ?? null,
      // S112's reach: the snapshot ids the world opportunity rested on.
      claim_refs: [...(envelope.claim_refs ?? [])],
    },
  };

  return { ok: true, signal, assertion };
}

export interface SessionEligibility {
  /** The normalized record, when the session produced one. */
  evidence: NormalizedEvidence | null;
  /** The existing section-6 gate's verdict over it. Null when nothing was said. */
  verdict: EligibilityVerdict | null;
  /** Why the bridge said nothing, when it said nothing. */
  refusal: SessionBridgeRefusal | null;
  /** Convenience: the gate said yes AND the bridge spoke. */
  eligible: boolean;
}

/**
 * The row, end to end: a session's outcome decides what it asserts, and the
 * EXISTING gate decides whether that is a Memory. Extra evidence about the same
 * episode (media, a stamp, the owner's own note) is passed through untouched so
 * corroboration still works — the session joins the evidence set, it does not
 * replace it.
 */
export function sessionMemoryEligibility(
  ownerId: string,
  envelope: ExperienceSessionEnvelope,
  nowMs: number,
  opts: { alsoConsider?: readonly NormalizedEvidence[]; ctx?: EligibilityContext } = {},
): SessionEligibility {
  const built = sessionMemorySignal(ownerId, envelope, nowMs);
  if (!built.ok) {
    return { evidence: null, verdict: null, refusal: built.reason, eligible: false };
  }

  const normalized = normalizeEvidence(built.signal, new Date(nowMs));
  if (!normalized.ok) {
    // A malformed signal is this module's bug, not a verdict about the owner.
    return { evidence: null, verdict: null, refusal: "unknown_outcome", eligible: false };
  }

  const all = [normalized.evidence, ...(opts.alsoConsider ?? [])];
  const verdict = evaluateEligibility(all, opts.ctx ?? {});
  return { evidence: normalized.evidence, verdict, refusal: null, eligible: verdict.eligible };
}

/** Re-exported so a reader of this module can see what a trail looks like. */
export { SESSION_FORBIDDEN_KEYS, EVIDENCE_SOURCE_STRENGTH };
