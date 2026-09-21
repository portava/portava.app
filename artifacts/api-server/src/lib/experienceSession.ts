/**
 * experienceSession — Sensing §5.4's bridge, and §19's `ExperienceSession`:
 *
 *   WORLD STATE → OPPORTUNITY → ACTION → EXPERIENCE SESSION → OUTCOME →
 *   MEMORY / CALIBRATION (when permitted)
 *
 * with the spec's one-line constraint carried in the design rather than in a
 * comment: *"It is not a raw tracking history."*
 *
 * ── §19 SAYS INSPECT BEFORE MATERIALISING, AND THIS IS WHAT THAT FOUND ───────
 * §19 heads its table *"Do Not Blindly Materialize"* and requires that existing
 * tables, types and services be mapped onto canonical owners first. Mapped:
 *
 *   the OUTCOME already has a canonical owner. Migration 2130 declined the
 *   Intelligence Gathering spec's `intel_outcomes` table "in favour of
 *   canonical_events", and lib/intelOutcomes.ts is that ruling in code — an
 *   outcome IS a canonical_events row with an exact `payload.intel` envelope,
 *   and lib/intelCalibrationScheduler reads those rows back.
 *
 *   the ACTION spine already exists. `canonical_events` (2100/2120) records
 *   the nine interaction verbs with a sanitised payload that strips raw GPS at
 *   every depth (lib/canonicalEvents.FORBIDDEN_PAYLOAD_KEYS).
 *
 * So this module adds NO table and NO verb. A session is TWO rows on the
 * existing spine — an opening `direction` event and a closing outcome event —
 * and its state is the FOLD over them, exactly as the trip kernel folds its
 * own events. The only platform change is one new allow-listed payload key,
 * `experience_session`, beside the `intel` envelope it links to.
 *
 * ── WHY THAT IS NOT A TRACKING HISTORY, STRUCTURALLY ─────────────────────────
 *   1. ONE SUBJECT. The envelope has a single `subject_id` and no previous,
 *      next, path, route, trail, waypoint or visit field — and
 *      `sessionForbiddenKeys` refuses any of them at build time, so a
 *      sequence cannot be smuggled in beside the subject.
 *   2. ONE OPEN SESSION. A viewer has at most one open session; opening a
 *      second while one is open is refused (`already_open`), so sessions
 *      cannot accumulate into a parallel trail.
 *   3. NO HISTORY READ. lib/experienceSessionStore exposes the viewer's OPEN
 *      session and nothing else: there is no list, no history and no
 *      by-subject query, and the suite asserts the module exports none.
 *   4. A BOUNDED LIFE. `expires_at` is mandatory and at most
 *      MAX_SESSION_HOURS from opening; an expired session can never be closed
 *      with an outcome, because an outcome reported after the window is not
 *      evidence about that window.
 *   5. NO COORDINATE, EVER. The envelope carries none, and the spine's
 *      sanitiser strips lat/lng/coords/accuracy at every depth even if one
 *      were added (§4.3).
 *   6. NEVER LONGER THAN THE OPPORTUNITY. A session opened from a world
 *      opportunity ends at the earlier of its own window and the
 *      OPPORTUNITY's §18.2 window, and an opportunity whose window has
 *      already passed opens nothing. A bridge cannot be parked on a place.
 *
 * ── CX-15: WHERE THE BRIDGE MAY START ────────────────────────────────────────
 * census-compass CX-15 (`docs/architecture/census-compass.md:122`) found the
 * only bridge in the tree started at a Compass SERVED RECOMMENDATION —
 * *"It bridges a recommendation to an outcome, not a world opportunity;
 * nothing outside Compass can start one."* Both halves are answered here:
 *
 *   SCOPE — `openSessionForOpportunity` bridges from the PLATFORM's world
 *   opportunity, `lib/opportunityEngine.OpportunityProjection` (§5/§6's stage,
 *   served by routes/opportunities), deriving the subject, the kind and the
 *   claim refs FROM the projection. `SESSION_ORIGINS` records which origin a
 *   session had, and `world_opportunity` cannot be self-asserted: the declared
 *   path refuses it (`origin_not_earned`).
 *
 *   REACH — routes/experienceSessions exposes that as a public seam on a
 *   router that is not Compass, authorized fail-closed.
 *
 * ── AND WHAT IS *NOT* CLOSED HERE, HONESTLY ──────────────────────────────────
 * `canonical_events` is append-only by construction (migration 2120 blocks
 * UPDATE, DELETE and TRUNCATE by trigger), so the rows a session writes are
 * never deleted. Non-accumulation is therefore a property of the READ SEAM —
 * no query in lib/experienceSessionStore or in the route reaches further back
 * than one session lifetime, none is by-subject, and there is no list — rather
 * than of the storage layer. A privileged reader of the spine itself could
 * still assemble a sequence; that is the spine's own retention question, not
 * this bridge's, and it is stated rather than implied.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no randomness
 * (`sessionId` is supplied by the caller).
 */
import type { CanonicalEventInput } from "./canonicalEvents.js";
import { INTEL_OUTCOMES, EXPERIENCE_RATING_MAX, EXPERIENCE_RATING_MIN, OUTCOME_VERB, type IntelOutcome } from "./intelOutcomes.js";
import {
  OPPORTUNITY_KINDS,
  opportunityWorldValueKeys,
  type OpportunityKind,
  type OpportunityProjection,
} from "./opportunityEngine.js";
import type { CompassDecision } from "./compassDecision.js";

/** The payload key this envelope rides under. Allow-listed in lib/canonicalEvents. */
export const EXPERIENCE_SESSION_PAYLOAD_KEY = "experience_session";

/** The verb that OPENS a session: the traveller acted on an opportunity. */
export const SESSION_OPEN_VERB = "direction" as const;

/** Longest a session may stay open. A bridge, not a diary. */
export const MAX_SESSION_HOURS = 12;
/** Default life when the caller names none. */
export const DEFAULT_SESSION_HOURS = 3;

/** How a session ended. `expired` is not an outcome and carries none. */
export const SESSION_CLOSE_REASONS = ["outcome_reported", "expired", "abandoned"] as const;
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

export const SESSION_PHASES = ["opened", "closed"] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

/**
 * WHERE THE BRIDGE STARTED — census-compass CX-15.
 *
 * CX-15 read: *"It bridges a recommendation to an outcome, not a world
 * opportunity; nothing outside Compass can start one."* The bridge is therefore
 * ORIGIN-PLURAL, and the origin is recorded rather than assumed:
 *
 *   world_opportunity     — the PLATFORM's opportunity: an
 *                           `opportunityEngine.OpportunityProjection`, the §5/§6
 *                           stage's own output, reachable to every surface
 *                           through routes/opportunities. Earned ONLY through
 *                           `openSessionForOpportunity`, which derives the
 *                           subject, the kind and the claims from the projection
 *                           itself — never from what a caller asserts.
 *   compass_recommendation — a Compass served recommendation. ONE origin among
 *                           others now, which is exactly what CX-15 asked for.
 *   declared              — a caller naming a kind it was not asked to prove.
 *                           The weakest origin, and spelled as itself so no
 *                           reader mistakes it for a world opportunity.
 */
export const SESSION_ORIGINS = ["world_opportunity", "compass_recommendation", "declared"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/** Origins a caller may name for itself. `world_opportunity` is not among them. */
export const DECLARABLE_ORIGINS: readonly SessionOrigin[] = Object.freeze(["declared", "compass_recommendation"]);

/** open → the window is live · expired → the window passed unclosed · closed → terminal. */
export const SESSION_STATES = ["open", "expired", "closed"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * The EXACT shape of `payload.experience_session`. Keep it exact: readers
 * (this module's fold, and any future calibration reader) type-guard on it, and
 * a drifting shape is how a silent half-session appears.
 */
export interface ExperienceSessionEnvelope {
  session_id: string;
  subject_id: string;
  /** CX-15: WHERE this bridge started. See SESSION_ORIGINS. */
  origin: SessionOrigin;
  /** The opportunity kind that was acted on — lib/opportunityEngine's vocabulary. */
  opportunity_kind: OpportunityKind;
  /**
   * `world_opportunity` only — the decision lib/compassDecision reached that
   * lib/opportunityEngine translated into this opportunity. It is what makes
   * the origin VERIFIABLE rather than a label: a declared session has none.
   */
  opportunity_decision?: CompassDecision;
  /**
   * `world_opportunity` only — the end of the opportunity's OWN §18.2 window.
   * The session's `expires_at` is bounded by it, so a bridge cannot outlive the
   * opportunity it bridges and become a long-lived marker on a place (S54).
   */
  opportunity_valid_until?: string;
  /** Snapshot ids the opportunity rested on. Opaque; never a contributor. */
  claim_refs: string[];
  opened_at: string;
  expires_at: string;
  phase: SessionPhase;
  /** Close only. */
  closed_at?: string;
  close_reason?: SessionCloseReason;
  outcome?: IntelOutcome;
  /** Close only, optional feedback (Table 21's 1..5). */
  experience_rating?: number;
}

/**
 * Keys that would turn a session into a trail. Refused at build; the check is
 * exported so the route can run it on what it is about to write.
 */
export const SESSION_FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  "path",
  "route",
  "trail",
  "waypoints",
  "visits",
  "history",
  "sessions",
  "previous_subject_id",
  "next_subject_id",
  "dwell_series",
  "points",
  "track",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "coords",
  "accuracy",
]) as readonly string[];

/** Trail-shaped keys found on an envelope (recursively). Empty, always. */
export function sessionForbiddenKeys(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => sessionForbiddenKeys(v, [...path, String(i)]));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SESSION_FORBIDDEN_KEYS.includes(k)) out.push([...path, k].join("."));
    out.push(...sessionForbiddenKeys(v, [...path, k]));
  }
  return out;
}

const OUTCOME_SET = new Set<string>(INTEL_OUTCOMES);
const KIND_SET = new Set<string>(OPPORTUNITY_KINDS);
const ORIGIN_SET = new Set<string>(SESSION_ORIGINS);

/** Type guard for readers. Fail-closed on any drift. */
export function isExperienceSessionEnvelope(x: unknown): x is ExperienceSessionEnvelope {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.session_id !== "string" || p.session_id.length === 0) return false;
  if (typeof p.subject_id !== "string" || p.subject_id.length === 0) return false;
  if (typeof p.origin !== "string" || !ORIGIN_SET.has(p.origin)) return false;
  if (typeof p.opportunity_kind !== "string" || !KIND_SET.has(p.opportunity_kind)) return false;
  // CX-15: only a session built FROM a projection carries the opportunity's own
  // decision and window, so a `declared` envelope cannot wear a world
  // opportunity's evidence and a `world_opportunity` one cannot be without it.
  if (p.origin === "world_opportunity") {
    if (typeof p.opportunity_decision !== "string" || p.opportunity_decision.length === 0) return false;
  } else if (p.opportunity_decision !== undefined || p.opportunity_valid_until !== undefined) {
    return false;
  }
  if (p.opportunity_valid_until !== undefined) {
    if (typeof p.opportunity_valid_until !== "string" || Number.isNaN(Date.parse(p.opportunity_valid_until))) return false;
  }
  if (!Array.isArray(p.claim_refs) || p.claim_refs.some((r) => typeof r !== "string")) return false;
  for (const k of ["opened_at", "expires_at"]) {
    const v = p[k];
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return false;
  }
  if (p.phase !== "opened" && p.phase !== "closed") return false;
  if (p.outcome !== undefined && (typeof p.outcome !== "string" || !OUTCOME_SET.has(p.outcome))) return false;
  if (p.experience_rating !== undefined) {
    const r = p.experience_rating;
    if (typeof r !== "number" || !Number.isInteger(r) || r < EXPERIENCE_RATING_MIN || r > EXPERIENCE_RATING_MAX) return false;
  }
  if (sessionForbiddenKeys(p).length > 0) return false;
  return true;
}

export type SessionOpenRefusal =
  | "no_opportunity_reference"
  | "invalid_subject"
  | "lifetime_exceeds_maximum"
  | "trail_shaped_payload"
  /** CX-15: `world_opportunity` was asserted on a path that proves no opportunity. */
  | "origin_not_earned"
  /** CX-15: what was handed over is not an OpportunityProjection. */
  | "not_an_opportunity"
  /** CX-15: the opportunity's own §18.2 window has already ended. */
  | "opportunity_window_passed"
  /** §5: a projection carrying a world value is never made durable. */
  | "opportunity_claims_world_truth";

export type SessionCloseRefusal = "already_closed" | "expired" | "unknown_outcome" | "invalid_rating";

export interface OpenSessionInput {
  sessionId: string;
  subjectId: string;
  /** The opportunity acted on. A session with no opportunity is not a bridge. */
  opportunityKind: OpportunityKind;
  claimRefs: readonly string[];
  hours?: number;
  /** Optional surface label, for the spine's own allow-listed key. */
  surface?: string;
  /**
   * CX-15: what the caller is. `declared` (the default) or
   * `compass_recommendation`. `world_opportunity` is NOT declarable here — it
   * is earned in `openSessionForOpportunity` by handing over the projection.
   */
  origin?: SessionOrigin;
}

export type OpenResult =
  | { ok: true; envelope: ExperienceSessionEnvelope; event: CanonicalEventInput }
  | { ok: false; refusal: SessionOpenRefusal };

/** The shared builder both origins go through: one subject, one bound, no trail. */
function buildOpenEvent(
  actorId: string,
  spec: {
    sessionId: string;
    subjectId: string;
    origin: SessionOrigin;
    opportunityKind: OpportunityKind;
    claimRefs: readonly string[];
    hours: number;
    /** Hard ceiling in ms for the window, when the origin supplies one. */
    validUntilMs?: number | null;
    opportunityDecision?: CompassDecision;
    surface?: string;
  },
  nowMs: number,
): OpenResult {
  if (!spec.subjectId) return { ok: false, refusal: "invalid_subject" };
  if (!KIND_SET.has(spec.opportunityKind)) return { ok: false, refusal: "no_opportunity_reference" };
  const hours = spec.hours;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SESSION_HOURS) {
    return { ok: false, refusal: "lifetime_exceeds_maximum" };
  }
  const openedAt = new Date(nowMs).toISOString();
  // S54 — A BOUNDED LIFE, and never longer than the thing it bridges: the
  // session ends at the earlier of its own window and the opportunity's.
  let endMs = nowMs + hours * 3_600_000;
  if (typeof spec.validUntilMs === "number" && Number.isFinite(spec.validUntilMs)) {
    if (spec.validUntilMs <= nowMs) return { ok: false, refusal: "opportunity_window_passed" };
    endMs = Math.min(endMs, spec.validUntilMs);
  }
  const expiresAt = new Date(endMs).toISOString();
  const envelope: ExperienceSessionEnvelope = {
    session_id: spec.sessionId,
    subject_id: spec.subjectId,
    origin: spec.origin,
    opportunity_kind: spec.opportunityKind,
    claim_refs: [...spec.claimRefs],
    opened_at: openedAt,
    expires_at: expiresAt,
    phase: "opened",
  };
  if (spec.origin === "world_opportunity") {
    if (spec.opportunityDecision) envelope.opportunity_decision = spec.opportunityDecision;
    if (typeof spec.validUntilMs === "number" && Number.isFinite(spec.validUntilMs)) {
      envelope.opportunity_valid_until = new Date(spec.validUntilMs).toISOString();
    }
  }
  if (sessionForbiddenKeys(envelope).length > 0) return { ok: false, refusal: "trail_shaped_payload" };

  const payload: Record<string, unknown> = { [EXPERIENCE_SESSION_PAYLOAD_KEY]: envelope };
  if (spec.surface) payload.surface = spec.surface;
  return {
    ok: true,
    envelope,
    event: {
      verb: SESSION_OPEN_VERB,
      actorId,
      subjectKind: "place",
      subjectId: spec.subjectId,
      occurredAt: openedAt,
      expiresAt,
      payload,
    },
  };
}

/**
 * Build the OPENING event from a kind the CALLER names. Refuses rather than
 * opening a session that would be unbridgeable (no opportunity), unbounded (too
 * long), or trail-shaped.
 *
 * CX-15: this is the WEAK origin. It proves nothing about the world — the
 * caller asserted a kind — so the envelope is stamped `declared` (or
 * `compass_recommendation` when Compass says so) and can never wear
 * `world_opportunity`. For that, hand over the projection:
 * `openSessionForOpportunity`.
 */
export function openExperienceSession(actorId: string, input: OpenSessionInput, nowMs: number): OpenResult {
  const origin: SessionOrigin = input.origin ?? "declared";
  if (!DECLARABLE_ORIGINS.includes(origin)) return { ok: false, refusal: "origin_not_earned" };
  return buildOpenEvent(
    actorId,
    {
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      origin,
      opportunityKind: input.opportunityKind,
      claimRefs: input.claimRefs,
      hours: input.hours ?? DEFAULT_SESSION_HOURS,
      surface: input.surface,
    },
    nowMs,
  );
}

export interface OpenFromOpportunityInput {
  sessionId: string;
  /**
   * The PLATFORM's world opportunity — lib/opportunityEngine's own projection,
   * the object `routes/opportunities.ts` serves to every surface. Not a Compass
   * recommendation, and not a kind somebody typed.
   */
  opportunity: OpportunityProjection;
  /** A shorter life than the opportunity's window, if the caller wants one. */
  hours?: number;
  surface?: string;
}

/** Is this really an OpportunityProjection? Fail-closed: no coercion, no defaults. */
function isOpportunityProjection(x: unknown): x is OpportunityProjection {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.subjectId !== "string" || p.subjectId.length === 0) return false;
  if (typeof p.kind !== "string" || !KIND_SET.has(p.kind)) return false;
  if (typeof p.decision !== "string" || p.decision.length === 0) return false;
  if (!Array.isArray(p.claimRefs) || p.claimRefs.some((r) => typeof r !== "string")) return false;
  if (!p.window || typeof p.window !== "object") return false;
  return true;
}

/**
 * CX-15 — THE BRIDGE FROM A WORLD OPPORTUNITY.
 *
 * The census found the only bridge in the tree began at a Compass SERVED
 * RECOMMENDATION: *"It bridges a recommendation to an outcome, not a world
 * opportunity."* This is the other origin, and the point of it is what it does
 * NOT read: the subject, the kind and the claim refs come from the PROJECTION,
 * never from the caller beside it, so a caller cannot open a session over a
 * subject the opportunity engine did not offer or under a kind it did not
 * reach. The decision the engine took is recorded with it, which is what makes
 * the origin verifiable rather than a label.
 *
 * S54 — the session is additionally bounded by the OPPORTUNITY's own §18.2
 * window: it ends when the evidence it rests on stops being servable. An
 * opportunity whose window has already passed is refused outright, because a
 * bridge to a moment that is over is not a bridge, it is a marker.
 *
 * §5 — a projection that carries a world value (a density, a trajectory, a
 * vibe) is refused rather than copied into a durable envelope: an
 * ExperienceSession must not become the place canonical world truth is stored.
 *
 * PURE. No I/O, no clock of its own, no randomness.
 */
export function openSessionForOpportunity(actorId: string, input: OpenFromOpportunityInput, nowMs: number): OpenResult {
  const opp = input.opportunity;
  if (!isOpportunityProjection(opp)) return { ok: false, refusal: "not_an_opportunity" };
  if (opportunityWorldValueKeys(opp).length > 0) return { ok: false, refusal: "opportunity_claims_world_truth" };

  const validUntilRaw = opp.window?.expiresAt ?? null;
  const validUntilMs = validUntilRaw === null ? null : Date.parse(validUntilRaw);
  if (validUntilMs !== null && Number.isNaN(validUntilMs)) return { ok: false, refusal: "not_an_opportunity" };

  return buildOpenEvent(
    actorId,
    {
      sessionId: input.sessionId,
      subjectId: opp.subjectId,
      origin: "world_opportunity",
      opportunityKind: opp.kind,
      claimRefs: opp.claimRefs,
      hours: input.hours ?? DEFAULT_SESSION_HOURS,
      validUntilMs,
      opportunityDecision: opp.decision,
      surface: input.surface,
    },
    nowMs,
  );
}

/** open · expired · closed — the fold's answer, never a stored status. */
export function sessionState(envelope: ExperienceSessionEnvelope, nowMs: number): SessionState {
  if (envelope.phase === "closed") return "closed";
  const expires = Date.parse(envelope.expires_at);
  if (Number.isFinite(expires) && nowMs > expires) return "expired";
  return "open";
}

export interface CloseSessionInput {
  outcome: IntelOutcome;
  experienceRating?: number;
  surface?: string;
}

export type CloseResult =
  | { ok: true; envelope: ExperienceSessionEnvelope; event: CanonicalEventInput }
  | { ok: false; refusal: SessionCloseRefusal };

/**
 * Build the CLOSING event. Closing is terminal: a closed session cannot be
 * closed again, and an EXPIRED one cannot be closed with an outcome at all —
 * an outcome reported after the window is not evidence about that window, and
 * pretending otherwise would feed the calibration report a lie. The verb is
 * the outcome's own existing verb (lib/intelOutcomes.OUTCOME_VERB), so a
 * closed session is indistinguishable, to every existing reader, from the
 * outcome events that already exist.
 */
export function closeExperienceSession(
  open: ExperienceSessionEnvelope,
  actorId: string,
  input: CloseSessionInput,
  nowMs: number,
): CloseResult {
  const state = sessionState(open, nowMs);
  if (state === "closed") return { ok: false, refusal: "already_closed" };
  if (state === "expired") return { ok: false, refusal: "expired" };
  if (!OUTCOME_SET.has(input.outcome)) return { ok: false, refusal: "unknown_outcome" };
  if (input.experienceRating !== undefined) {
    const r = input.experienceRating;
    if (!Number.isInteger(r) || r < EXPERIENCE_RATING_MIN || r > EXPERIENCE_RATING_MAX) {
      return { ok: false, refusal: "invalid_rating" };
    }
  }
  const closedAt = new Date(nowMs).toISOString();
  const envelope: ExperienceSessionEnvelope = {
    ...open,
    phase: "closed",
    closed_at: closedAt,
    close_reason: "outcome_reported",
    outcome: input.outcome,
  };
  if (input.experienceRating !== undefined) envelope.experience_rating = input.experienceRating;

  const payload: Record<string, unknown> = { [EXPERIENCE_SESSION_PAYLOAD_KEY]: envelope };
  if (input.surface) payload.surface = input.surface;
  return {
    ok: true,
    envelope,
    event: {
      verb: OUTCOME_VERB[input.outcome],
      actorId,
      subjectKind: "place",
      subjectId: open.subject_id,
      occurredAt: closedAt,
      payload,
    },
  };
}

/**
 * The fold: the state of ONE session from the events that carry its id, newest
 * last. An unknown id folds to null — never to a plausible open session.
 */
export function foldSession(
  envelopes: readonly ExperienceSessionEnvelope[],
  sessionId: string,
  nowMs: number,
): { envelope: ExperienceSessionEnvelope; state: SessionState } | null {
  let latest: ExperienceSessionEnvelope | null = null;
  for (const e of envelopes) {
    if (e.session_id !== sessionId) continue;
    if (latest === null) latest = e;
    else if (e.phase === "closed") latest = e; // a close always wins over an open
  }
  return latest === null ? null : { envelope: latest, state: sessionState(latest, nowMs) };
}
