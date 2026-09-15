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
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no randomness
 * (`sessionId` is supplied by the caller).
 */
import type { CanonicalEventInput } from "./canonicalEvents.js";
import { INTEL_OUTCOMES, EXPERIENCE_RATING_MAX, EXPERIENCE_RATING_MIN, OUTCOME_VERB, type IntelOutcome } from "./intelOutcomes.js";
import { OPPORTUNITY_KINDS, type OpportunityKind } from "./opportunityEngine.js";

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
  /** The opportunity kind that was acted on — lib/opportunityEngine's vocabulary. */
  opportunity_kind: OpportunityKind;
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

/** Type guard for readers. Fail-closed on any drift. */
export function isExperienceSessionEnvelope(x: unknown): x is ExperienceSessionEnvelope {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  if (typeof p.session_id !== "string" || p.session_id.length === 0) return false;
  if (typeof p.subject_id !== "string" || p.subject_id.length === 0) return false;
  if (typeof p.opportunity_kind !== "string" || !KIND_SET.has(p.opportunity_kind)) return false;
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
  | "trail_shaped_payload";

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
}

export type OpenResult =
  | { ok: true; envelope: ExperienceSessionEnvelope; event: CanonicalEventInput }
  | { ok: false; refusal: SessionOpenRefusal };

/**
 * Build the OPENING event. Refuses rather than opening a session that would be
 * unbridgeable (no opportunity), unbounded (too long), or trail-shaped.
 */
export function openExperienceSession(actorId: string, input: OpenSessionInput, nowMs: number): OpenResult {
  if (!input.subjectId) return { ok: false, refusal: "invalid_subject" };
  if (!KIND_SET.has(input.opportunityKind)) return { ok: false, refusal: "no_opportunity_reference" };
  const hours = input.hours ?? DEFAULT_SESSION_HOURS;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SESSION_HOURS) {
    return { ok: false, refusal: "lifetime_exceeds_maximum" };
  }
  const openedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + hours * 3_600_000).toISOString();
  const envelope: ExperienceSessionEnvelope = {
    session_id: input.sessionId,
    subject_id: input.subjectId,
    opportunity_kind: input.opportunityKind,
    claim_refs: [...input.claimRefs],
    opened_at: openedAt,
    expires_at: expiresAt,
    phase: "opened",
  };
  if (sessionForbiddenKeys(envelope).length > 0) return { ok: false, refusal: "trail_shaped_payload" };

  const payload: Record<string, unknown> = { [EXPERIENCE_SESSION_PAYLOAD_KEY]: envelope };
  if (input.surface) payload.surface = input.surface;
  return {
    ok: true,
    envelope,
    event: {
      verb: SESSION_OPEN_VERB,
      actorId,
      subjectKind: "place",
      subjectId: input.subjectId,
      occurredAt: openedAt,
      expiresAt,
      payload,
    },
  };
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
