/**
 * LayoverCompassAssistant — §12 Compass as orchestrator and explainer on the
 * layover door, with the model and its twelve deterministic tools.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §12   "Compass is an orchestrator and explainer. It can ask the minimum
 *          useful clarifying question, compare certified plans, personalize
 *          wording and invoke deterministic tools. It cannot invent or widen
 *          the certified safe envelope, return deadline, visa/entry status,
 *          operational state, or risk band."          (census L100, L101)
 *          The twelve named tools.                    (census L102–L113)
 *   §12.1 "Before asking the user a question, determine whether the answer
 *          could materially change eligibility, safety, risk band, or the top
 *          plan. Ask the smallest number of questions required."  (census L114)
 *   §25   "Compass — tool access to certified context; proactive
 *          OpportunityEvents; explanation/clarification"           (census L268)
 *
 * ── OWNER DECISION 2026-10-18 (supersedes lead rulings L-CL02a/c/d here) ─────
 * The assistant rows are in scope, with the model and approved tool execution.
 * The invariant those rulings protected still binds, verbatim from census-compass
 * CL-02: "hard safety cannot be overridden by Compass prose". This module holds
 * it by construction, in four layers, each of which fails CLOSED:
 *
 *   1. THE CERTIFIED TEXT LEADS EVERY ANSWER. `answerLayoverQuestion` (the
 *      certified core in LayoverCompassService.ts, unchanged) writes the safety
 *      facts: whether leaving is allowed, the return deadline, the usable time,
 *      the airport facts. The model never writes them; it adds after them.
 *   2. THE TOOLS ARE READS OF THE CERTIFIED RECORD. Every value a tool returns
 *      is read off `ctx.record` (the answer's own certification) or an
 *      owner-scoped, privacy-scrubbed read the route made. No tool computes a
 *      deadline, a buffer, an envelope or a rating, and none writes. `replan`
 *      runs the server's own §11.1 pipeline as a PREVIEW labelled hypothetical;
 *      `requestConstraintClarification` asks, it never writes a constraint.
 *   3. THE DETECTOR (`enforceCompassEnvelope`, restored from 6239b11f2 and
 *      hardened against the §54.2 widenings that passed it): any widening of
 *      the deadline, the window, entry, the risk band or operational state
 *      anywhere in the model's output DROPS ALL OF THE MODEL'S PROSE for that
 *      answer and is reported in `boundaryViolations`.
 *   4. THE ADMISSION GATE (`admitModelSentence`): a model sentence reaches the
 *      traveller ONLY if every word in it is in `ASSISTANT_VOCABULARY` — a
 *      closed, reviewed list with no number, time, duration, place, movement,
 *      transport, entry, operational, permission or reassurance word — after
 *      the names of certified plans and the airport are masked; it contains no
 *      digit, no character outside plain Latin text, and no question. This is
 *      an ALLOWLIST: a widening the detector has never seen fails it because it
 *      needs a word the list does not have. Over-withholding is the designed
 *      failure: the traveller then reads the certified text alone.
 *
 * The model also cannot add a question (§12.1 is a computation, below) and
 * cannot name a plan that is not certified (comparisons are rendered by the
 * server from the certified fit; the model only chooses and orders them).
 *
 * Fail closed on every model failure: an outage, a timeout, an empty or
 * unparseable reply, the rate limit, or a certification that does not match the
 * answer's all return the certified-only answer with the reason named.
 *
 * Flag: `layover_compass_assistant_enabled`, seeded FALSE (migration 3846).
 * The route reads it; OFF / absent / unreadable never reaches this module.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpenAI } from "../../lib/openai.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { logger } from "../../lib/logger.js";
import type { AirportProfile } from "./AirportProfileService.js";
import { layoverSessionIsLiveAt, type LayoverSession } from "./LayoverSessionService.js";
import type { EntryEligibility } from "./layoverEntryGate.js";
import type { LayoverSnapshot } from "./LayoverSnapshot.js";
import { certifySessionFeasibility, certificationHeader, type FeasibilitySession, type LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import { certifiedPlanFit, landsideStatusOf, type CertifiedPlanFit } from "./LayoverConstraints.js";
import type { PlanFitStop } from "./LayoverPlanFit.js";
import { formatLocalTime } from "./AirportTime.js";
import { sanitizeCompassAnswer } from "./LayoverPrivacyGuard.js";
import {
  answerLayoverQuestion,
  layoverModelMayAnswer,
  valueOfInformation,
  CLARIFIABLE_FIELDS,
  UNREPRESENTABLE_CLARIFICATIONS,
  type ClarifyingQuestion,
  type CompassLayoverAnswer,
} from "./LayoverCompassService.js";
import { handleEvent, isLayoverEventType, normalizeEvent, LAYOVER_EVENT_TYPES } from "./LayoverEventReplanner.js";
import { candidatesFromStops } from "./LayoverReplanService.js";
import { snapshotIdFor } from "./layoverLedger.js";
import { explainSnapshot } from "../layover/LayoverDecisionService.js";
import type { CompassCrewCandidates } from "../layover/LayoverCrewVisibility.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — the general chat's model, with tighter bounds
// ─────────────────────────────────────────────────────────────────────────────

/** Seeded FALSE by migration 3846. Read by the route with the literal (check:flag-polarity). */
export const LAYOVER_COMPASS_ASSISTANT_FLAG = "layover_compass_assistant_enabled";

/** The general chat's model (`routes/compass.ts` runToolCallingLoop), through the same client (`getOpenAI`). */
export const ASSISTANT_MODEL = "gpt-5-mini";

export interface AssistantLimits {
  /** Tool rounds after the first completion; one more completion is forced tool-less. */
  maxToolRounds: number;
  /** Tool calls executed per round; the rest are refused by name. */
  maxToolCallsPerRound: number;
  /** Per completion. The general chat uses 1200; this door writes three sentences. */
  maxCompletionTokens: number;
  /** Per completion request (SDK timeout + our own race). */
  perCallTimeoutMs: number;
  /** Whole-answer budget across every round. */
  totalDeadlineMs: number;
  /** Assisted answers per traveller per minute; over it, the certified answer alone (no call). */
  ratePerMinute: number;
  maxReplySentences: number;
  maxCompareItems: number;
}

export const ASSISTANT_LIMITS: Readonly<AssistantLimits> = Object.freeze({
  maxToolRounds: 4,
  maxToolCallsPerRound: 6,
  maxCompletionTokens: 700,
  perCallTimeoutMs: 12_000,
  totalDeadlineMs: 25_000,
  ratePerMinute: 10,
  maxReplySentences: 3,
  maxCompareItems: 3,
});

export const ASSISTANT_RATE_LIMITER = "layover_compass_assistant";

// ─────────────────────────────────────────────────────────────────────────────
// §12 — the twelve tools
// ─────────────────────────────────────────────────────────────────────────────

export type LayoverToolName =
  | "getLayoverContext"
  | "getConnectionState"
  | "getTimeWallet"
  | "getSafeEnvelope"
  | "getReachableExperiences"
  | "simulatePlan"
  | "getReturnContract"
  | "getAirportState"
  | "getCrewCandidates"
  | "requestConstraintClarification"
  | "replan"
  | "explainDecision";

/** The §12 tool list, in the spec's order. */
export const LAYOVER_TOOL_NAMES: readonly LayoverToolName[] = [
  "getLayoverContext",
  "getConnectionState",
  "getTimeWallet",
  "getSafeEnvelope",
  "getReachableExperiences",
  "simulatePlan",
  "getReturnContract",
  "getAirportState",
  "getCrewCandidates",
  "requestConstraintClarification",
  "replan",
  "explainDecision",
] as const;

/** A read the route made, with its OUTCOME: a failed read is a reason, never `[]`. */
export type ToolRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A persisted recommendation card, as the tool may see it: no coordinates, no place id. */
export interface ToolRecommendation {
  id: string;
  title: string;
  recType: string | null;
  insideAirport: boolean;
  /** Minutes at the place; null = nobody stated it. */
  activityTimeMin: number | null;
  /** One-way minutes; null = nobody measured it. */
  travelTimeMin: number | null;
  safetyLabel: string | null;
  warningReason: string | null;
}

/** A stored plan stop, as the tool may see it: no coordinates, no place id, no address. */
export interface ToolStop {
  id: string;
  title: string;
  durationMin: number | null;
  travelMin: number | null;
  insideAirport: boolean;
}

/** A proactive OpportunityEvent that reached the traveller (§25 / L98), as the notifier stored it. */
export interface ToolOpportunity {
  title: string;
  why: string;
  priority: string;
  at: string;
}

/**
 * The route's reads, LAZY: each runs only when a tool (or the comparison, or
 * §12.1's top-plan test) needs it, and at most once per answer. Absent = the
 * route did not offer it; the tool then says so by name.
 */
export interface LayoverToolSources {
  recommendations?: () => Promise<ToolRead<ToolRecommendation[]>>;
  stops?: () => Promise<ToolRead<ToolStop[]>>;
  crew?: () => Promise<CompassCrewCandidates>;
  disruption?: () => Promise<ToolRead<Record<string, unknown>>>;
  opportunities?: () => Promise<ToolRead<ToolOpportunity[]>>;
}

/** Everything a tool may read. Assembled by the route for the session the caller already proved they own. */
export interface LayoverToolContext {
  /** Only for `explainDecision`'s stored-snapshot read, which is scoped to `session.id`. */
  db: SupabaseClient | null;
  session: LayoverSession;
  airport: AirportProfile;
  /** THE certified record of this answer — the same one the certified text was read off. */
  record: LayoverFeasibilityRecord;
  /** The answer's usable minutes (the snapshot's when the route read one). */
  usableMinutes: number;
  entry: EntryEligibility | null;
  /** The certification instant. No tool reads a second clock. */
  nowMs: number;
  sources: Required<{ [K in keyof LayoverToolSources]: NonNullable<LayoverToolSources[K]> }>;
}

export type LayoverToolResult =
  | { ok: true; tool: LayoverToolName; data: Record<string, unknown> }
  | { ok: false; tool: string; unavailable: true; reason: string };

// ── tool declarations (OpenAI function-calling, strict) ──────────────────────

const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_NUMBER = { type: ["number", "null"] } as const;

const REPLAN_PAYLOAD_KEYS = ["delayMinutes", "newDepartureTime", "waitMinutes", "extraMinutes", "gate", "condition", "checkpoint"] as const;

const TOOL_DESCRIPTIONS: Record<LayoverToolName, string> = {
  getLayoverContext: "The traveller's layover: airport, flight type, the window's instants, their stated preferences, and the certification header.",
  getConnectionState: "Session status, return state, tier, the disruption state the traveller reported, and the latest OpportunityEvents (options that changed).",
  getTimeWallet: "The certified time budget (minutes, not money): total, exit delay, return buffer and usable minutes, with confidence.",
  getSafeEnvelope: "The certified safe envelope: hard return time, earliest out time, usable minutes, the buffer breakdown and the landside gate.",
  getReachableExperiences: "The persisted experience cards, each with its CERTIFIED fit against this layover (blocked ones stay listed with the reason).",
  simulatePlan: "Certified plan fit for a candidate set (refs to experiences/stops, or stated minutes), or the stored plan when candidateSet is null.",
  getReturnContract: "The certified return contract: hard return time (airport-local too), return state, buffer, reminder.",
  getAirportState: "The airport profile: curation, maturity, terminal info and buffer terms. There is no certified live operational feed.",
  getCrewCandidates: "Crews the traveller may be offered here, block-cleared and behind the §14.1 safety gate; or their own crew.",
  requestConstraintClarification: "Whether asking the traveller about a field would change eligibility, safety, risk band or the top plan. Asks; never writes.",
  replan: "Preview the server's §11.1 replan for a §11 event the traveller mentioned. Hypothetical: nothing is recorded or changed.",
  explainDecision: "Explain the current certified decision, a stored snapshot (snapshotId), or one experience's certified fit (recommendationId).",
};

function toolParameters(name: LayoverToolName): Record<string, unknown> {
  const properties: Record<string, unknown> = { sessionId: { type: "string" } };
  if (name === "simulatePlan") {
    properties.candidateSet = {
      type: ["array", "null"],
      maxItems: 12,
      items: {
        type: "object",
        properties: { ref: NULLABLE_STRING, durationMin: NULLABLE_NUMBER, travelMin: NULLABLE_NUMBER, insideAirport: { type: ["boolean", "null"] } },
        required: ["ref", "durationMin", "travelMin", "insideAirport"],
        additionalProperties: false,
      },
    };
  }
  if (name === "requestConstraintClarification") {
    properties.field = { type: ["string", "null"], enum: [...CLARIFIABLE_FIELDS, ...UNREPRESENTABLE_CLARIFICATIONS.map((u) => u.field), null] };
  }
  if (name === "replan") {
    properties.trigger = { type: "string", enum: [...LAYOVER_EVENT_TYPES] };
    properties.payload = {
      type: ["object", "null"],
      properties: {
        delayMinutes: NULLABLE_NUMBER, newDepartureTime: NULLABLE_STRING, waitMinutes: NULLABLE_NUMBER,
        extraMinutes: NULLABLE_NUMBER, gate: NULLABLE_STRING, condition: NULLABLE_STRING, checkpoint: NULLABLE_STRING,
      },
      required: [...REPLAN_PAYLOAD_KEYS],
      additionalProperties: false,
    };
  }
  if (name === "explainDecision") {
    properties.snapshotId = NULLABLE_STRING;
    properties.recommendationId = NULLABLE_STRING;
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/** The twelve declarations, passed to the model on every assisted answer. */
export const LAYOVER_TOOL_SCHEMAS = LAYOVER_TOOL_NAMES.map((name) => ({
  type: "function" as const,
  function: { name, description: TOOL_DESCRIPTIONS[name], strict: true, parameters: toolParameters(name) },
}));

// ── argument validation: the server never trusts the model's arguments ──────

function typeMatches(spec: unknown, v: unknown): boolean {
  const types = Array.isArray((spec as { type?: unknown })?.type) ? (spec as { type: string[] }).type : [String((spec as { type?: unknown })?.type)];
  const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isFinite(v) ? "number" : "nan") : typeof v;
  if (!types.includes(actual)) return false;
  const e = (spec as { enum?: unknown[] }).enum;
  return !Array.isArray(e) || e.includes(v as never);
}

/**
 * The model's arguments against the tool's own schema, and the one rule the
 * schema cannot state: `sessionId` must be THIS session. A model cannot address
 * another traveller's layover by naming its id. Missing nullable keys are
 * filled with null (the strict schema requires them; a lenient model omits).
 */
export function validateToolArgs(name: LayoverToolName, args: Record<string, unknown>, sessionId: string):
  { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const params = toolParameters(name) as { properties: Record<string, unknown> };
  for (const k of Object.keys(args)) if (!(k in params.properties)) return { ok: false, reason: `unexpected_argument:${k}` };
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(params.properties)) {
    const v = k in args ? args[k] : k === "sessionId" ? undefined : null;
    if (v === undefined) return { ok: false, reason: `missing_argument:${k}` };
    if (!typeMatches(spec, v)) return { ok: false, reason: `invalid_argument:${k}` };
    out[k] = v;
  }
  if (out.sessionId !== sessionId) return { ok: false, reason: "session_not_in_scope" };
  return { ok: true, args: out };
}

/**
 * A model-chosen call: is it one of the twelve, are its arguments JSON, do they
 * match the schema? Each refusal is a NAMED result fed back to the model, never
 * a throw — a hallucinated function name costs a sentence, not the answer.
 */
export async function runNamedLayoverTool(name: unknown, ctx: LayoverToolContext, rawArgs: unknown): Promise<LayoverToolResult> {
  const candidate = String(name ?? "");
  if (!(LAYOVER_TOOL_NAMES as readonly string[]).includes(candidate)) {
    return { ok: false, tool: candidate, unavailable: true, reason: `unknown_tool:${candidate || "(unnamed)"}` };
  }
  const tool = candidate as LayoverToolName;
  let parsed: unknown = {};
  if (typeof rawArgs === "string") {
    if (rawArgs.trim() !== "") {
      try { parsed = JSON.parse(rawArgs); } catch { return { ok: false, tool, unavailable: true, reason: "malformed_tool_arguments" }; }
    }
  } else if (rawArgs !== undefined && rawArgs !== null) parsed = rawArgs;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, tool, unavailable: true, reason: "malformed_tool_arguments" };
  const v = validateToolArgs(tool, parsed as Record<string, unknown>, ctx.session.id);
  if (!v.ok) return { ok: false, tool, unavailable: true, reason: v.reason };
  try {
    return await runLayoverTool(tool, ctx, v.args);
  } catch {
    // A tool that throws is an unavailable tool, never a 500 and never a guess.
    return { ok: false, tool, unavailable: true, reason: "tool_failed" };
  }
}

// ── the privacy scrub (the same rule as the answer's coordinate scrub) ───────

/**
 * Keys that never reach the model: coordinates and geometry, and identities of
 * anybody (user, owner, member, crew, place). Applied to EVERY tool result,
 * after each tool already built its output without them — defence in depth.
 */
const SCRUBBED_KEYS = new Set([
  "lat", "lng", "lon", "latitude", "longitude", "coords", "coordinates", "centre", "center", "geometry", "polygon",
  "point", "points", "geojson", "radiusmetres", "radiusmeters",
  "userid", "user_id", "ownerid", "owner_id", "memberid", "member_id", "memberids", "member_ids", "members",
  "crewid", "crew_id", "placeid", "place_id", "actorid", "actor_id", "senderid", "sender_id", "username", "displayname",
  "display_name", "avatarurl", "avatar_url", "email", "phone",
]);

export function scrubForModel(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return sanitizeCompassAnswer(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => scrubForModel(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SCRUBBED_KEYS.has(k.toLowerCase())) continue;
      out[k] = scrubForModel(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ── the tools ────────────────────────────────────────────────────────────────

const SNAPSHOT_ID_RE = /^snap:[0-9a-f]{32}$/;

/** The source tag every preview envelope carries; never a real producer's. */
export const COMPASS_REPLAN_PREVIEW_SOURCE = "portava.layover.compass_preview";

function landsideOf(r: LayoverFeasibilityRecord) {
  return { status: landsideStatusOf(r), closedBy: [...r.landsideGate.closedBy], cautions: [...(r.landsideGate.cautions ?? [])] };
}

function stopOfRecommendation(rec: ToolRecommendation): PlanFitStop {
  return { durationMin: rec.activityTimeMin, travelMin: rec.travelTimeMin, insideAirport: rec.insideAirport };
}

/** Plain server words for a certified fit. No figure, no time: those are the certified text's. */
export function fitStatusText(fit: CertifiedPlanFit, insideAirport: boolean): string {
  switch (fit.fit) {
    case "fits": return insideAirport ? "inside the airport; fits your certified window" : "fits your certified window";
    case "over": return "does not fit your certified window";
    case "blocked": return "not available: the certified check does not allow leaving the airport on this layover";
    case "unconfirmed": return "not confirmed: leaving the airport has not been confirmed as possible on this layover";
    default: return "not certified: nobody has measured how long it takes";
  }
}

function fitSummary(fit: CertifiedPlanFit) {
  return {
    fit: fit.fit, clockFit: fit.clockFit, fitsWindow: fit.fitsWindow, neededMin: fit.neededMin, usableMinutes: fit.usableMinutes,
    neededMinIsLowerBound: fit.neededMinIsLowerBound, overflowMin: fit.overflowMin,
    landsideStatus: fit.landside.status, landsideClosedBy: fit.landside.closedBy, landsideCautions: fit.landside.cautions,
  };
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 24 * 60 ? v : null;
}

/**
 * Run one §12 tool against the certified context.
 *
 * THE PROPERTY THAT MAKES THIS A BOUNDARY: every value returned is read off
 * `ctx.record`, `ctx.session`, `ctx.airport` or a route read. No tool calls the
 * safety engine to make a new deadline, buffer, envelope or rating for THIS
 * session, so no argument a model can pass makes a tool return a wider envelope
 * than the certified one. The two that compute — `simulatePlan` (the shared
 * `certifiedPlanFit` over the SAME record) and `replan` (the §11.1 pipeline,
 * under `hypothetical`, `applied: false`) — say what they are.
 */
export async function runLayoverTool(
  tool: LayoverToolName,
  ctx: LayoverToolContext,
  args: Record<string, unknown> = {},
): Promise<LayoverToolResult> {
  const r = ctx.record;
  const ok = (data: Record<string, unknown>): LayoverToolResult => ({ ok: true, tool, data: scrubForModel(data) as Record<string, unknown> });
  const no = (reason: string): LayoverToolResult => ({ ok: false, tool, unavailable: true, reason });
  const tz = ctx.airport.timezone ?? "UTC";

  switch (tool) {
    case "getLayoverContext":
      return ok({
        sessionId: ctx.session.id,
        airport: { iataCode: ctx.airport.iataCode, name: ctx.airport.name, city: ctx.airport.city, country: ctx.airport.country, timezone: ctx.airport.timezone, verified: ctx.airport.verified },
        flightType: ctx.session.flightType,
        arrivalTime: ctx.session.arrivalTime,
        departureTime: ctx.session.departureTime,
        boardingTime: ctx.session.boardingTime,
        comfortLevel: ctx.session.comfortLevel,
        wantsToLeave: ctx.session.wantsToLeave,
        interests: [...(ctx.session.vibeChips ?? [])],
        certification: certificationHeader(r),
      });

    case "getConnectionState": {
      const disruption = await ctx.sources.disruption();
      const opportunities = await ctx.sources.opportunities();
      return ok({
        status: ctx.session.status,
        live: layoverSessionIsLiveAt(ctx.session, ctx.nowMs),
        returnState: r.envelope.returnState,
        tier: r.envelope.tier,
        tierLabel: r.envelope.tierLabel,
        disruption: disruption.ok ? disruption.value : null,
        disruptionUnavailableReason: disruption.ok ? null : disruption.reason,
        // §25 / L98: the OpportunityEvents the replanner pushed to this traveller for THIS session.
        latestOpportunities: opportunities.ok ? opportunities.value : null,
        opportunitiesUnavailableReason: opportunities.ok ? null : opportunities.reason,
      });
    }

    case "getTimeWallet":
      return ok({
        totalMinutes: r.envelope.totalMinutes,
        exitDelayMin: r.envelope.exitDelayMin,
        returnBufferMin: r.envelope.returnBufferMin,
        usableMinutes: ctx.usableMinutes,
        bufferMinutesAtPercentile: r.bufferMinutesAtPercentile,
        confidence: r.confidence,
      });

    case "getSafeEnvelope":
      return ok({
        hardReturnTime: r.deadline.hardReturnTime.toISOString(),
        hardReturnLocal: formatLocalTime(tz, r.deadline.hardReturnTime),
        earliestOutTime: r.envelope.earliestOutTime.toISOString(),
        usableMinutes: ctx.usableMinutes,
        breakdown: r.deadline.breakdown,
        landside: landsideOf(r),
        // §8 geometry is coordinates; it is not handed to the model (privacy scrub).
        geometryWithheldReason: "coordinates_are_not_shared_with_the_assistant",
        certification: certificationHeader(r),
      });

    case "getReachableExperiences": {
      const read = await ctx.sources.recommendations();
      // An unreadable shortlist is not an empty one (census L294).
      if (!read.ok) return no(read.reason);
      return ok({
        experiences: read.value.map((rec) => {
          const fit = certifiedPlanFit(r, [stopOfRecommendation(rec)]);
          return {
            ref: `rec:${rec.id}`, title: rec.title, recType: rec.recType, insideAirport: rec.insideAirport,
            available: fit.fitsWindow, status: fitStatusText(fit, rec.insideAirport), ...fitSummary(fit),
            safetyLabel: rec.safetyLabel, warningReason: rec.warningReason,
          };
        }),
        // Ranking is not Compass's (§12): the persisted order, unchanged.
        reranked: false,
      });
    }

    case "simulatePlan": {
      const set = args.candidateSet as Array<Record<string, unknown>> | null | undefined;
      let candidate: PlanFitStop[];
      let modelSuppliedFigures = false;
      if (set === null || set === undefined) {
        // Zero stops fit every window: a failed read is refused, never "fits" (census L47).
        const stops = await ctx.sources.stops();
        if (!stops.ok) return no(stops.reason);
        candidate = stops.value.map((s) => ({ durationMin: s.durationMin, travelMin: s.travelMin, insideAirport: s.insideAirport }));
      } else {
        if (set.length > 12) return no("too_many_candidates");
        if (set.some((c) => !c || typeof c !== "object" || Array.isArray(c))) return no("malformed_candidate");
        const recs = set.some((c) => typeof c.ref === "string" && c.ref.startsWith("rec:")) ? await ctx.sources.recommendations() : null;
        const stops = set.some((c) => typeof c.ref === "string" && c.ref.startsWith("stop:")) ? await ctx.sources.stops() : null;
        candidate = [];
        for (const c of set) {
          const ref = typeof c.ref === "string" ? c.ref : null;
          if (ref) {
            // A ref is resolved to the SERVER's stated figures; the model's numbers are ignored for it.
            if (ref.startsWith("rec:")) {
              if (!recs || !recs.ok) return no(recs && !recs.ok ? recs.reason : "layover_recommendations_not_read");
              const rec = recs.value.find((x) => `rec:${x.id}` === ref);
              if (!rec) return no(`unknown_plan_ref:${ref}`);
              candidate.push(stopOfRecommendation(rec));
            } else if (ref.startsWith("stop:")) {
              if (!stops || !stops.ok) return no(stops && !stops.ok ? stops.reason : "layover_plan_stops_not_read");
              const s = stops.value.find((x) => `stop:${x.id}` === ref);
              if (!s) return no(`unknown_plan_ref:${ref}`);
              candidate.push({ durationMin: s.durationMin, travelMin: s.travelMin, insideAirport: s.insideAirport });
            } else return no(`unknown_plan_ref:${ref}`);
          } else {
            modelSuppliedFigures = true;
            // An omitted `insideAirport` is landside: certifiedPlanFit never reads absence as airside.
            candidate.push({ durationMin: finiteOrNull(c.durationMin), travelMin: finiteOrNull(c.travelMin), insideAirport: c.insideAirport === true });
          }
        }
      }
      const f = certifiedPlanFit(r, candidate);
      return ok({ ...fitSummary(f), unstatedTravelStops: f.unstatedTravelStops, backByTime: r.deadline.hardReturnTime.toISOString(), modelSuppliedFigures });
    }

    case "getReturnContract":
      return ok({
        hardReturnTime: r.deadline.hardReturnTime.toISOString(),
        hardReturnLocal: formatLocalTime(tz, r.deadline.hardReturnTime),
        returnState: r.envelope.returnState,
        bufferMinutes: r.deadline.breakdown.totalBuffer,
        returnReminderAt: ctx.session.returnReminderAt,
        route: null,
        routeUnavailableReason: "no_routed_return_on_this_door",
        certification: certificationHeader(r),
      });

    case "getAirportState":
      return ok({
        iataCode: ctx.airport.iataCode,
        verified: ctx.airport.verified,
        maturity: ctx.airport.verified ? "curated" : "L0_generic_defaults",
        terminalInfo: ctx.airport.terminalInfo ?? null,
        buffers: {
          domesticBufferMin: ctx.airport.domesticBufferMin,
          internationalBufferMin: ctx.airport.internationalBufferMin,
          immigrationExtraMin: ctx.airport.immigrationExtraMin,
          checkedBagsExtraMin: ctx.airport.checkedBagsExtraMin,
          trafficExtraMin: ctx.airport.trafficExtraMin,
        },
        // Nothing certified measures queues, flights or transport here.
        liveOperationalState: null,
        liveUnavailableReason: "no_certified_operational_feed",
      });

    case "getCrewCandidates": {
      // §14 visibility: the crew card's own read (block-cleared, behind the §14.1
      // safety gate, refusing when unreadable). Crews are offered by title,
      // meeting point and size; no traveller's identity and no crew id.
      const crew = await ctx.sources.crew();
      if (!crew.ok) return no(crew.reason);
      const v = crew.value;
      if (v.inCrew) return ok({ inCrew: true, crew: { ...v.crew } });
      return ok({
        inCrew: false, city: v.city, reason: v.reason, meetWithheld: [...v.meetWithheld],
        candidates: v.candidates.map((c) => ({ title: c.title, meetingPointLabel: c.meetingPointLabel, maxMembers: c.maxMembers, expiresAt: c.expiresAt })),
      });
    }

    case "requestConstraintClarification": {
      // ASKS; NEVER WRITES. The traveller answers through their own session edit
      // (PATCH /airport/sessions/:id), which re-certifies server-side.
      const plans = await planCandidates(ctx);
      const all = planAwareClarifications(ctx.airport, ctx.session, ctx.nowMs, ctx.entry, plans);
      const field = typeof args.field === "string" ? args.field : "";
      if (!field) return ok({ questions: all, asked: all[0] ?? null, writes: false });
      const hit = all.find((q) => q.field === field) ?? null;
      return ok({
        field,
        // §12.1: a field whose answer would not move the outcome is NOT asked.
        worthAsking: Boolean(hit),
        isTheDecisiveQuestion: hit !== null && all[0]?.field === field,
        question: hit,
        unrepresentable: UNREPRESENTABLE_CLARIFICATIONS.find((u) => u.field === field) ?? null,
        writes: false,
      });
    }

    case "replan": {
      // The SERVER's §11.1 pipeline (normalizeEvent → handleEvent: steps 1–8),
      // run as a PREVIEW. A model-relayed event is not a verified source, so
      // nothing is recorded, notified or changed: applying it is the traveller's
      // own report (POST /airport/sessions/:id/disruption, PATCH .../:id), which
      // runs the persisted replan.
      const trigger = args.trigger;
      if (!isLayoverEventType(trigger)) return no("unknown_trigger");
      const payload: Record<string, unknown> = {};
      const rawPayload = (args.payload ?? {}) as Record<string, unknown>;
      for (const k of REPLAN_PAYLOAD_KEYS) if (rawPayload[k] !== null && rawPayload[k] !== undefined) payload[k] = rawPayload[k];
      const norm = normalizeEvent({
        eventId: `compass-preview:${ctx.session.id}:${ctx.nowMs}`,
        eventType: trigger,
        occurredAt: new Date(ctx.nowMs).toISOString(),
        source: COMPASS_REPLAN_PREVIEW_SOURCE,
        subjectRefs: [{ kind: "session", ref: ctx.session.id }],
        payload,
        confidence: "LOW",
      }, { receivedAtMs: ctx.nowMs });
      if (!norm.ok) return no(`event_rejected:${norm.reason}`);
      const stops = await ctx.sources.stops();
      if (!stops.ok) return no(stops.reason); // an unreadable plan would publish "0 options lost"
      const result = handleEvent(norm.event, {
        airport: ctx.airport,
        sessions: [{ session: ctx.session, airportRef: ctx.airport.iataCode, status: ctx.session.status }],
        candidates: { [ctx.session.id]: candidatesFromStops(stops.value as unknown as Array<Record<string, unknown>>) },
        entries: { [ctx.session.id]: ctx.entry },
        nowMs: ctx.nowMs,
      });
      const titleOf = (id: string) => stops.value.find((s) => s.id === id)?.title ?? id;
      const out = result.replanned[0];
      if (!out) {
        return ok({ preview: true, applied: false, trigger, impacted: 0, reason: result.skipped[0]?.reason ?? "only_active_sessions_replan" });
      }
      return ok({
        preview: true,
        applied: false,
        howToApply: "the traveller reports it on the layover screen (Flight delayed or cancelled?) or edits the flight times",
        trigger,
        affectedNodes: [...out.affectedNodes],
        current: { verdict: r.verdict, returnState: r.envelope.returnState, usableMinutes: ctx.usableMinutes, hardReturnTime: r.deadline.hardReturnTime.toISOString() },
        hypothetical: { verdict: out.after.verdict, returnState: out.after.envelope.returnState, usableMinutes: out.after.envelope.usableMinutes, hardReturnTime: out.after.deadline.hardReturnTime.toISOString() },
        hypotheticalDiff: {
          verdictChanged: out.diff.verdictChanged, returnStateChanged: out.diff.returnStateChanged,
          usableMinutesDelta: out.diff.usableMinutesDelta, deadlineDeltaMinutes: out.diff.deadlineDeltaMinutes,
          plansLost: out.diff.candidatesLost.map(titleOf), plansGained: out.diff.candidatesGained.map(titleOf), plansUnmeasured: out.diff.candidatesUnmeasured.map(titleOf),
        },
        hypotheticalOpportunity: out.opportunity ? { why: [...out.opportunity.why], reasonCodes: [...out.opportunity.reasonCodes] } : null,
        wouldNotify: out.notify.notify,
      });
    }

    case "explainDecision": {
      const currentSnapshotId = snapshotIdFor(ctx.session.id, r.inputHash);
      const recId = typeof args.recommendationId === "string" ? args.recommendationId.replace(/^rec:/, "") : "";
      if (recId) {
        const recs = await ctx.sources.recommendations();
        if (!recs.ok) return no(recs.reason);
        const rec = recs.value.find((x) => x.id === recId);
        if (!rec) return no("recommendation_not_in_certified_set");
        const fit = certifiedPlanFit(r, [stopOfRecommendation(rec)]);
        return ok({
          kind: "recommendation", ref: `rec:${rec.id}`, title: rec.title, insideAirport: rec.insideAirport,
          status: fitStatusText(fit, rec.insideAirport), ...fitSummary(fit), safetyLabel: rec.safetyLabel, warningReason: rec.warningReason,
          againstSnapshotId: currentSnapshotId,
        });
      }
      const snapshotId = typeof args.snapshotId === "string" ? args.snapshotId : "";
      if (snapshotId && snapshotId !== currentSnapshotId) {
        if (!SNAPSHOT_ID_RE.test(snapshotId)) return no("invalid_snapshot_id");
        if (!ctx.db) return no("decision_ledger_not_reachable");
        let out: Awaited<ReturnType<typeof explainSnapshot>>;
        try { out = await explainSnapshot(ctx.db, ctx.session.id, snapshotId); } catch { return no("read_failed"); }
        if (!out.ok) return no(out.reason);
        const e = out.explanation;
        return ok({
          kind: "stored_snapshot", snapshotId: e.snapshotId, reasons: [...e.reasons], unknowns: [...e.unknowns], disclaimer: e.disclaimer,
          breakdown: e.breakdown, bufferPercentile: e.bufferPercentile, result: e.decision.result, reasonCodes: [...e.decision.reasonCodes],
          rulesApplied: [...e.decision.rulesApplied], computedAt: e.decision.computedAt, verifiedBy: e.verifiedBy,
        });
      }
      return ok({
        kind: "current_record", snapshotId: currentSnapshotId, certification: certificationHeader(r),
        verdict: r.verdict, confidence: r.confidence, reasons: [...r.reasons], unknowns: [...r.unknowns],
        reasonCodes: [...r.reasonCodes], disclaimer: r.disclaimer, landside: landsideOf(r),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.1 — value of information, including "the top plan"
// ─────────────────────────────────────────────────────────────────────────────

/** A plan the top-plan test ranks: the stored plan first, then each experience as a one-stop plan, in persisted order. */
export interface PlanCandidate {
  ref: string;
  title: string;
  stops: PlanFitStop[];
}

export type PlanAwareClarifyingQuestion = ClarifyingQuestion & {
  impact: ClarifyingQuestion["impact"] & { topPlanChanges: boolean };
};

async function planCandidates(ctx: LayoverToolContext): Promise<PlanCandidate[]> {
  const out: PlanCandidate[] = [];
  const stops = await ctx.sources.stops();
  if (stops.ok && stops.value.length > 0) {
    out.push({ ref: "plan:stored", title: "Your saved plan", stops: stops.value.map((s) => ({ durationMin: s.durationMin, travelMin: s.travelMin, insideAirport: s.insideAirport })) });
  }
  const recs = await ctx.sources.recommendations();
  if (recs.ok) for (const rec of recs.value) out.push({ ref: `rec:${rec.id}`, title: rec.title, stops: [stopOfRecommendation(rec)] });
  return out;
}

/** The first plan, in order, whose certified fit is `fits` — or null. */
export function topPlanRef(record: LayoverFeasibilityRecord, plans: readonly PlanCandidate[]): string | null {
  for (const p of plans) if (certifiedPlanFit(record, p.stops).fitsWindow) return p.ref;
  return null;
}

/**
 * §12.1 with all four of its nouns. `valueOfInformation` (LayoverCompassService)
 * measures eligibility (verdict), safety (return state), risk band and the
 * window by RE-CERTIFYING with each field flipped; given the plans it also
 * measures "the top plan" on the SAME flipped records: whether the first plan
 * that fits is a different one, scored like a verdict change. A field whose
 * flip moves none of them is never asked. Sorted, highest value first; the
 * answer asks `[0]` and nothing else. The flips are certified there and only
 * there — the one named counterfactual site (layoverSnapshotConsumers C1).
 */
export function planAwareClarifications(
  airport: Parameters<typeof certifySessionFeasibility>[0],
  session: FeasibilitySession,
  nowMs: number,
  entry: EntryEligibility | null,
  plans: readonly PlanCandidate[],
): PlanAwareClarifyingQuestion[] {
  return valueOfInformation(airport, session, nowMs, entry, plans.map((p) => p.stops))
    .map((q) => ({ ...q, impact: { ...q.impact, topPlanChanges: q.impact.topPlanChanges === true } }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — the detector: enforceCompassEnvelope, restored and hardened
// ─────────────────────────────────────────────────────────────────────────────

export const COMPASS_BOUNDARY_KINDS = [
  "return_deadline_widened",
  "usable_time_widened",
  "entry_status_asserted",
  "risk_band_widened",
  "operational_state_asserted",
] as const;
export type CompassBoundaryViolationKind = (typeof COMPASS_BOUNDARY_KINDS)[number];

export interface CompassBoundaryViolation {
  kind: CompassBoundaryViolationKind;
  /** The text that violated the certified envelope. */
  stated: string;
  /** The certified value it exceeded or contradicted. */
  certified: string;
}

export interface EnvelopeContext {
  airport: Pick<AirportProfile, "timezone">;
  hardReturnTime: Date;
  usableMinutes: number;
  /** The certified verdict. Absent = treated as NOT an explicit yes (fail closed). */
  verdict?: LayoverFeasibilityRecord["verdict"];
  /** `layoverModelMayAnswer(record, usable)`: the only state in which the certified text says leaving is possible. */
  explicitYes?: boolean;
  /** The certified band is "safe" (explicit yes with 60+ usable minutes). */
  safeBand?: boolean;
  /** The certification instant (for the same-day test). Absent = clocks are not compared, they are refused. */
  nowMs?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  a: 1, an: 1, couple: 2, few: 3, several: 3, half: 0.5,
};

/** "twenty-five" / "twenty five" / "7" / "an" → a number, or null. */
function parseNumberPhrase(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "a" || s === "an") return 1;
  const parts = s.split(/[\s-]+/).filter((p) => p !== "" && p !== "and" && p !== "of" && p !== "a");
  if (parts.length === 0) return null;
  let total = 0;
  for (const p of parts) {
    if (!(p in NUMBER_WORDS)) return null;
    total = p === "hundred" ? Math.max(1, total) * 100 : total + NUMBER_WORDS[p]!;
  }
  return total;
}

const NUM_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)";
const NUM_PHRASE = `(?:\\d+(?:\\.\\d+)?|${NUM_WORD}(?:[\\s-]+${NUM_WORD})*|an?|a\\s+couple(?:\\s+of)?|a\\s+few|several)`;

/** Every stated duration, in minutes. */
export function statedDurationsMinutes(text: string): Array<{ stated: string; minutes: number }> {
  const out: Array<{ stated: string; minutes: number }> = [];
  const t = text.toLowerCase();
  // Up to two non-number words may sit between the figure and its unit: "9000 USABLE minutes", "ten MORE hours".
  const GAP = `(?:\\s+(?!${NUM_WORD}\\b|an?\\b|few\\b|couple\\b|several\\b|and\\b)[a-z'’]+){0,2}?`;
  const re = new RegExp(`\\b(${NUM_PHRASE})(\\s+and\\s+a\\s+half)?(${GAP})\\s*(hours?|hrs?|h|minutes?|mins?|m)\\b`, "g");
  for (const m of t.matchAll(re)) {
    let n = parseNumberPhrase(m[1]!);
    if (n === null) continue;
    if (m[2]) n += 0.5;
    const unit = m[4]!;
    if ((unit === "m" || unit === "h") && (m[3] || !/\d$/.test(m[1]!))) continue; // "a m…", "two big h…" are not durations
    if (/\bhalf\s+$/.test(t.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0))) continue; // "half an hour" is counted below, once
    out.push({ stated: m[0], minutes: /^h/.test(unit) ? n * 60 : n });
  }
  for (const m of t.matchAll(/\bhalf\s+an?\s+hour\b/g)) out.push({ stated: m[0], minutes: 30 });
  return out;
}

/** Phrases that state an open-ended window no certified figure supports. */
const UNBOUNDED_TIME = /\b(?:(?:the\s+)?(?:whole|entire|full)\s+(?:day|evening|afternoon|morning|night)|all\s+(?:day|evening|afternoon|morning|night)(?:\s+long)?|hours\s+(?:to\s+spare|and\s+hours)|(?:plenty|loads|lots|tons|heaps)\s+of\s+time|no\s+(?:rush|hurry)|no\s+need\s+to\s+(?:rush|hurry)|all\s+the\s+time\s+in\s+the\s+world|ample\s+(?:time|margin)|time\s+to\s+spare|in\s+no\s+hurry|take\s+your\s+time)\b/gi;

const HOUR_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const HOUR_WORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const MINUTE_OFFSET: Record<string, number> = { quarter: 15, half: 30, ten: 10, five: 5, twenty: 20, "twenty-five": 25, "twenty five": 25 };

/**
 * Every stated clock time, as minute-of-day READINGS. A 12-hour time with no
 * meridiem has two readings; a guard that refuses compares every reading.
 */
export function statedClockReadings(text: string): Array<{ stated: string; readings: number[] }> {
  const out: Array<{ stated: string; readings: number[] }> = [];
  const t = text.toLowerCase();
  const twelve = (h: number, min: number, mer: string | undefined): number[] => {
    if (mer) {
      const pm = mer.startsWith("p");
      const hh = (h % 12) + (pm ? 12 : 0);
      return [hh * 60 + min];
    }
    if (h >= 13 || h === 0) return [h * 60 + min];
    return h === 12 ? [12 * 60 + min, min] : [h * 60 + min, (h + 12) * 60 + min];
  };
  const MER = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)";
  // 19:45, 19.45, 19h45, 7:45pm
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s*[:.h]\\s*([0-5]\\d)\\b\\s*${MER}?`, "g"))) {
    const h = Number(m[1]); const min = Number(m[2]);
    if (h > 24) continue;
    out.push({ stated: m[0].trim(), readings: twelve(h, min, m[3]) });
  }
  // 7pm, 7 p.m.
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s*${MER}(?![a-z])`, "g"))) {
    const h = Number(m[1]); if (h < 1 || h > 12) continue;
    out.push({ stated: m[0].trim(), readings: twelve(h, 0, m[2]) });
  }
  // 1945 after a time cue, or followed by h/hrs/local
  for (const m of t.matchAll(/\b(?:by|until|till|til|before|at|around|about|after|past|from|latest)\s+(?:about\s+|around\s+)?([01]\d|2[0-3])([0-5]\d)\b|\b([01]\d|2[0-3])([0-5]\d)\s*(?:h|hrs|hours|local)\b/g)) {
    const h = Number(m[1] ?? m[3]); const min = Number(m[2] ?? m[4]);
    out.push({ stated: m[0].trim(), readings: [h * 60 + min] });
  }
  // quarter to eight, half past seven, ten past six
  for (const m of t.matchAll(new RegExp(`\\b(quarter|half|ten|five|twenty(?:[\\s-]five)?)\\s+(past|after|to|til|till|before)\\s+(${HOUR_WORD}|\\d{1,2})\\b`, "g"))) {
    const off = MINUTE_OFFSET[m[1]!.replace("-", " ")] ?? MINUTE_OFFSET[m[1]!] ?? 0;
    const hourRaw = m[3]!; const h = HOUR_WORDS[hourRaw] ?? Number(hourRaw);
    if (!Number.isFinite(h) || h < 0 || h > 24) continue;
    const before = /^(to|til|till|before)$/.test(m[2]!);
    // Every reading of the named hour, moved by the offset ("quarter to twelve" is 11:45 AND 23:45).
    out.push({ stated: m[0], readings: twelve(h, 0, undefined).map((x) => (before ? (x - off + 24 * 60) % (24 * 60) : x + off)) });
  }
  // eight o'clock, seven thirty, eight in the evening
  for (const m of t.matchAll(new RegExp(`\\b(${HOUR_WORD})\\s+(?:o'?clock|o’clock|(thirty|fifteen|forty[\\s-]five|oh[\\s-]five|twenty)|in\\s+the\\s+(evening|afternoon|morning)|at\\s+night|tonight)\\b`, "g"))) {
    const h = HOUR_WORDS[m[1]!]!;
    const minWord = m[2] ? m[2].replace(/[\s-]+/g, " ") : "";
    const min = minWord === "thirty" ? 30 : minWord === "fifteen" ? 15 : minWord === "forty five" ? 45 : minWord === "oh five" ? 5 : minWord === "twenty" ? 20 : 0;
    const part = m[3] ?? (/(night|tonight)/.test(m[0]) ? "evening" : "");
    const readings = part === "evening" || part === "afternoon" ? [((h % 12) + 12) * 60 + min] : part === "morning" ? [(h % 12) * 60 + min] : twelve(h, min, undefined);
    out.push({ stated: m[0], readings });
  }
  for (const m of t.matchAll(/\b(noon|midday|midnight)\b/g)) out.push({ stated: m[0], readings: [m[1] === "midnight" ? 24 * 60 : 12 * 60] });
  return out;
}

function localDayAndMinute(tz: string, at: Date): { day: string; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    const h = Number(get("hour")) % 24; const min = Number(get("minute"));
    return { day: `${get("year")}-${get("month")}-${get("day")}`, minute: h * 60 + min };
  } catch { return null; }
}

/** Sentences, each with its own terminator. A fragment with no terminator is one sentence. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 0);
}

const NEGATOR = /\b(?:not|never|no|don'?t|do\s+not|doesn'?t|does\s+not|isn'?t|is\s+not|won'?t|wouldn'?t|shouldn'?t|should\s+not|can'?t|cannot|can\s+not|avoid|without|unable)\b/i;

/** Is the match negated WITHIN ITS OWN CLAUSE? "Don't leave, but explore the city" negates only the first verb. */
function negatedInClause(sentence: string, index: number): boolean {
  const prefix = sentence.slice(0, index);
  const cut = Math.max(prefix.search(/[^,;:—–]*$/), ...[...prefix.matchAll(/\b(?:but|and|so|then|instead|rather\s+than)\b/gi)].map((m) => (m.index ?? 0) + m[0].length));
  return NEGATOR.test(prefix.slice(cut));
}

/** Leaving the airport, or going somewhere a landside verdict decides. */
const LEAVING = /\b(?:leav(?:e|es|ing)\s+(?:the\s+)?(?:airport|terminal)|(?:go|head|pop|step|venture|nip|get)\s+(?:out|outside|into|downtown|beyond|landside)|go\s+(?:see|visit|explore)|explor(?:e|ing)\s+(?:the\s+)?(?:city|town|area|neighbou?rhood|outside|downtown)|(?:visit|see|tour)\s+(?:the\s+)?(?:city|town|old\s+town|downtown|temple|museum|market|cathedral|beach|park|night\s+market|sights?)|city\s+(?:tour|trip|centre|center|visit)|into\s+(?:the\s+)?(?:city|town|downtown|centre|center)|(?:take|grab|catch|hop\s+on|ride)\s+(?:a|an|the)\s+(?:cab|taxi|train|metro|bus|uber|shuttle|mrt|subway|tram|ferry)|(?:short|quick)\s+(?:cab|taxi|train|metro|bus|ride|walk|trip)|worth\s+(?:a|the)\s+(?:trip|visit|detour)|landside|outside\s+the\s+(?:airport|terminal)|sightsee(?:ing)?|day\s+trip|(?:it'?s|it\s+is)\s+safe\s+to\s+(?:leave|go|head|explore)|you\s+(?:can|could|should|might|may)\s+(?:safely\s+|easily\s+)?(?:leave|go\s+out|head\s+out|explore|visit|pop\s+out|step\s+out|make\s+it)|go\s+ahead\s+and\s+(?:leave|go|explore)|(?:easily|comfortably)\s+make\s+it|be\s+back\s+in\s+(?:plenty\s+of\s+)?time)\b/gi;

/** An assertion that the risk is low. */
const SAFE_ASSERTION = /\b(?:(?:it'?s|it\s+is|you'?re|you\s+are|that'?s|totally|perfectly|completely|very)\s+safe|safe\s+(?:bet|enough|choice\s+to\s+leave)|(?:low|no|zero|minimal)\s+risk|risk-?free|nothing\s+to\s+worry\s+about|no\s+need\s+to\s+worry|you'?ll\s+be\s+fine)\b/gi;

const ENTRY_TOPIC = /\b(?:visas?|visa-free|e-?visa|twov|transit\s+without\s+(?:a\s+)?visa|permits?|entry|enter(?:ing)?|border|passport|immigration|customs|allowed\s+in|let\s+(?:you\s+)?in|admitted)\b/i;
const ENTRY_PERMISSION = /\b(?:visa-free|no\s+visa|without\s+(?:a\s+)?visa|(?:don'?t|do\s+not|won'?t|will\s+not|wouldn'?t)\s+need\s+(?:a\s+)?visa|(?:can|may|could|are\s+allowed\s+to|are\s+permitted\s+to|are\s+eligible\s+to|will\s+be\s+able\s+to)\s+enter|entry\s+is\s+(?:allowed|permitted|fine|possible|ok|okay|easy|straightforward)|allowed\s+in|let\s+you\s+in|eligible\s+for\s+(?:a\s+)?(?:visa|entry|transit)|visa\s+on\s+arrival|(?:passport|nationality)\s+(?:is\s+)?(?:fine|ok|okay|enough|works|qualifies)|(?:immigration|customs|the\s+border)\s+(?:is|will\s+be)\s+(?:fine|easy|quick|no\s+problem|a\s+breeze))\b/i;
const ENTRY_HEDGE = /\b(?:can(?:'|’)?t\s+(?:confirm|say|tell|know)|cannot\s+(?:confirm|say|tell|know)|unable\s+to\s+confirm|not\s+able\s+to\s+confirm|unknown|unsure|uncertain|not\s+confirmed|haven(?:'|’)?t\s+(?:confirmed|checked)|check\s+(?:the\s+)?(?:official|entry|requirements)|verify|depends?)\b/i;

/**
 * The detector. Narrowness was the old guard's rule ("a guard that fires on
 * innocent sentences gets turned off"); on this door it is the opposite,
 * because a hit costs the traveller the model's sentences and never the answer.
 * Every clause therefore fails toward reporting.
 *
 * Hardened against census-compass §54.2's eight widenings: a clock time with no
 * "back"/"return" near it, a time in words ("quarter to eight"), a time with no
 * colon ("1945", "19.45"), and "the whole evening — about fifteen hours". Any
 * stated clock time later than the certified hard return, on ANY reading, is a
 * widening; when the deadline is not on the certification's local day no clock
 * is comparable and every clock time is refused. Any stated duration longer
 * than the certified window is a widening, in digits or words.
 */
export function enforceCompassEnvelope(answer: string, ctx: EnvelopeContext): { ok: boolean; text: string; violations: CompassBoundaryViolation[] } {
  const violations: CompassBoundaryViolation[] = [];
  const tz = ctx.airport.timezone ?? "UTC";
  const certifiedLocal = formatLocalTime(tz, ctx.hardReturnTime);
  const deadline = localDayAndMinute(tz, ctx.hardReturnTime);
  const now = typeof ctx.nowMs === "number" ? localDayAndMinute(tz, new Date(ctx.nowMs)) : null;
  const comparable = deadline !== null && now !== null && deadline.day === now.day;

  for (const c of statedClockReadings(answer)) {
    if (!comparable || c.readings.some((r) => r > deadline!.minute)) {
      violations.push({ kind: "return_deadline_widened", stated: c.stated, certified: comparable ? certifiedLocal : `${certifiedLocal} (not on the certification's local day: no clock time is comparable)` });
    }
  }

  for (const d of statedDurationsMinutes(answer)) {
    if (!(d.minutes <= ctx.usableMinutes)) {
      violations.push({ kind: "usable_time_widened", stated: d.stated, certified: `${ctx.usableMinutes} minutes usable` });
    }
  }
  for (const m of answer.matchAll(UNBOUNDED_TIME)) {
    violations.push({ kind: "usable_time_widened", stated: m[0], certified: `${ctx.usableMinutes} minutes usable` });
  }

  for (const sentence of splitSentences(answer)) {
    // Entry: a permission claim is a violation hedged or not ("you don't need a
    // visa, but check" asserts first); any other entry sentence passes only as
    // an admission of not knowing.
    if (ENTRY_PERMISSION.test(sentence) || (ENTRY_TOPIC.test(sentence) && !ENTRY_HEDGE.test(sentence))) {
      violations.push({ kind: "entry_status_asserted", stated: sentence.slice(0, 140), certified: "entry permission is not certified by this envelope" });
    }
    // Risk band: one-directional. Talking it DOWN is always allowed.
    if (ctx.explicitYes !== true) {
      for (const m of sentence.matchAll(LEAVING)) {
        if (negatedInClause(sentence, m.index ?? 0)) continue;
        violations.push({ kind: "risk_band_widened", stated: m[0], certified: `certified verdict: ${ctx.verdict ?? "unknown"} (leaving is not certified)` });
      }
    }
    if (ctx.safeBand !== true) {
      for (const m of sentence.matchAll(SAFE_ASSERTION)) {
        if (negatedInClause(sentence, m.index ?? 0)) continue;
        violations.push({ kind: "risk_band_widened", stated: m[0], certified: `certified band is not safe (verdict ${ctx.verdict ?? "unknown"})` });
      }
    }
  }

  violations.push(...operationalStateViolations(answer));
  return { ok: violations.length === 0, text: answer, violations };
}

// L101's fifth noun: there is NO certified operational state on this door
// (`getAirportState.liveOperationalState` is null), so a present-state claim
// about a queue, a flight, a gate or a transfer is invented by construction.
// Restored from 6239b11f2 unchanged except that the hedge list no longer
// excuses a claim with "if" or "data" in it.
const SUBJECT_GAP = String.raw`[^.!?]{0,40}?\s`;
const OPERATIONAL_STATE_CLAIMS: readonly string[] = [
  String.raw`\b(?:no|short|small|quick|fast|light|minimal|zero)\s+(?:queues?|lines?|waits?|wait\s+times?)\b`,
  String.raw`\b(?:queues?|lines?|waits?|wait\s+times?)\b${SUBJECT_GAP}(?:is|are|looks?|seems?|(?:'|’)s)\s+(?:currently\s+|now\s+|pretty\s+|really\s+|very\s+)?(?:short|quick|fast|light|minimal|empty|moving\s+(?:quickly|fast)|not\s+(?:bad|long|busy))\b`,
  String.raw`\b(?:security|immigration|passport\s+control|customs|check-?in)\b${SUBJECT_GAP}(?:is|are|looks?|seems?|(?:'|’)s)\s+(?:currently\s+|now\s+|pretty\s+|really\s+|very\s+)?(?:quick|fast|empty|quiet|clear|not\s+busy|moving\s+(?:quickly|fast)|a\s+breeze)\b`,
  String.raw`\b(?:security|immigration|passport\s+control|customs)\s+(?:only|just)\s+takes?\b`,
  String.raw`\b(?:security|immigration|passport\s+control|customs)\s+takes?\s+(?:only|just)\b`,
  String.raw`\b(?:flight|connection|departure)\b${SUBJECT_GAP}(?:is|has\s+been|was|(?:'|’)s|isn(?:'|’)t|is\s+not|hasn(?:'|’)t\s+been)\s+(?:currently\s+|now\s+)?(?:on\s+time|delayed|cancell?ed|on\s+schedule|running\s+late|boarding)\b`,
  String.raw`\bgate\s+(?:is|has\s+(?:changed|moved)\s+to|will\s+be|(?:'|’)s)\s+(?:now\s+)?[a-z]?\d{1,3}[a-z]?\b`,
  String.raw`\bboarding\s+(?:has\s+(?:started|begun)|is\s+(?:open|underway)|(?:starts|begins)\s+(?:late|later))\b`,
  String.raw`\b(?:trains?|shuttles?|sky\s*train|people\s+mover|monorail|airport\s+express|express\s+train|metro|mrt|subway|tram|bus(?:es)?)\b${SUBJECT_GAP}(?:is|are|(?:'|’)s)\s+(?:currently\s+|still\s+|now\s+)?(?:running|operating|on\s+(?:time|schedule)|in\s+service)\b`,
  String.raw`\b(?:airport|terminal|security|immigration)\b${SUBJECT_GAP}(?:is|(?:'|’)s)\s+(?:currently\s+|pretty\s+|really\s+|very\s+)?(?:quiet|empty|dead|not\s+(?:busy|crowded))\b`,
  String.raw`\b(?:airport|terminal|security|immigration)\b${SUBJECT_GAP}(?:isn(?:'|’)t|is\s+not)\s+(?:currently\s+|very\s+)?(?:busy|crowded|packed)\b`,
];
const OPERATIONAL_STATE_ASSERTION = new RegExp(String.raw`[^.!?]*(?:` + OPERATIONAL_STATE_CLAIMS.join("|") + String.raw`)[^.!?]*[.!?]?`, "gi");
const OPERATIONAL_HEDGE = /\b(?:can(?:'|’)?t\s+(?:see|confirm|know|tell|check|verify|guarantee)|cannot\s+(?:see|confirm|know|tell|check|verify|guarantee)|don(?:'|’)?t\s+(?:know|have|see)|do\s+not\s+(?:know|have|see)|unable\s+to|not\s+able\s+to|unknown|unsure|uncertain|no\s+live|not\s+live|check|verify|may|might|could|usually|typically|generally|often|sometimes|tends?\s+to|varies|vary|depends?)\b/i;

export function operationalStateViolations(answer: string): CompassBoundaryViolation[] {
  const out: CompassBoundaryViolation[] = [];
  for (const m of answer.matchAll(OPERATIONAL_STATE_ASSERTION)) {
    const sentence = m[0];
    if (OPERATIONAL_HEDGE.test(sentence)) continue;
    out.push({ kind: "operational_state_asserted", stated: sentence.trim().slice(0, 140), certified: "no certified operational state on this door (liveOperationalState is null)" });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — the admission gate: a closed vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY WORDS A MODEL SENTENCE MAY USE (lower case; contractions as written).
 *
 * Built for what §12 lets the model add — personalised wording and a taste-led
 * comparison of certified plans — and reviewed against what it may NOT say.
 * Deliberately absent, so a sentence needing one is withheld:
 *   numbers and quantities (one, two, half, few, lot, enough, plenty, extra…);
 *   time (time, minute, hour, now, soon, later, early, late, before, after,
 *   until, when, while, still, then, first, next, morning, evening, night…);
 *   places and movement (airport, terminal, inside, outside, out, into, near,
 *   far, around, city, town, go, head, leave, exit, walk, ride, visit, explore,
 *   tour, trip…); transport (taxi, train, metro, bus…); entry (visa, passport,
 *   border, entry, enter, immigration, customs, allowed…); operations (gate,
 *   flight, boarding, security, queue, line, wait, delay, open, closed, busy…);
 *   permission and reassurance (safe, risk, okay, fine, sure, easy, worry,
 *   need, able, recommend, definitely, certainly…); "fit"; and "plan" ("your plans look
 *   great" would endorse a plan the record may refuse — a plan is named only by its certified title).
 * `layoverCompassAssistant.test.ts` asserts no word here matches the safety
 * lexicon below, so adding one that does is a red test, not a review comment.
 */
export const ASSISTANT_VOCABULARY: ReadonlySet<string> = new Set(`
a an the and or but so if as because since though although whereas also too even just only really quite very rather pretty
more most less least much some any each every both either neither other another such same different own something
i i'd i'm i'll i've me my mine you you're you'd you'll you've your yours yourself we we'd we're we'll us our ours
it it's its they they're them their this that that's these those here here's what which who whom whose how why
is are was were be been being isn't aren't wasn't weren't has have had having hasn't haven't do does did doing don't doesn't didn't
can could would should will won't wouldn't shouldn't couldn't can't cannot might may must shall
not no nor never of for with without about to in on at from by than like unlike between up over off down
enjoy enjoys enjoying enjoyed like likes liked love loves loved prefer prefers preferred want wants wanted fancy
try tries trying tried pick picks picked choose chooses choosing chose consider considering suggest suggests
offer offers offering serve serves serving feature features suit suits suited match matches matched appeal appeals
sound sounds seem seems look looks feel feels give gives keep keeps grab have take treat
relax relaxing relaxed unwind recharge rest resting refresh refreshing browse browsing shop shopping eat eating
drink drinking sip savor savour taste tasting read reading sit sitting stretch stay share sharing compare compared
comparing comparison combine skip save mind think hope know help helps
good great nice lovely wonderful excellent fantastic perfect best better tasty delicious fresh hearty filling healthy
sweet savory savoury spicy rich simple classic local authentic traditional modern unique special popular famous
favorite favourite cozy cosy comfortable comfy calm quiet peaceful restful lively fun interesting memorable charming
pleasant bright warm casual elegant affordable cheap cheaper pricey pricier generous varied wide small big little bit
well nicely especially particularly mostly mainly simply truly probably perhaps maybe likely personally instead alternatively
food foods meal meals snack snacks bite coffee tea drink drinks juice smoothie beer wine cocktail dessert desserts
noodles noodle dumplings dumpling ramen sushi rice soup salad sandwich burger pizza pastry pastries bakery bread cake
bowl bowls cup cups glass plate slice
chocolate fruit cuisine dish dishes flavor flavour flavors flavours tastes menu restaurant restaurants cafe bar bars eatery
lounge lounges shops store stores boutique bookstore bookshop books magazine gifts souvenirs spa massage shower showers nap
sleep music art gallery seat seats chair space spot corner place option options choice choices idea ideas picks
mood interests interest style vibe vibes preference preferences energy comfort quality variety value experience experiences break
hello hi thanks thank welcome glad happy layover
`.trim().split(/\s+/));

/**
 * The safety lexicon the vocabulary is checked against (by test), and the
 * reason a word is never added to it. Anything matching here is a topic §12
 * reserves for the certified text.
 */
export const SAFETY_LEXICON: readonly RegExp[] = [
  // time, deadline, window, duration, quantity
  /^(?:time|times|timing|minutes?|mins?|hours?|hrs?|seconds?|window|deadline|buffer|clock|now|soon|later|late|early|earlier|before|after|until|till|when|while|still|then|first|second|last|next|today|tonight|tomorrow|morning|afternoon|evening|night|noon|midday|midnight|day|days|week|long|short|quick|quickly|fast|slow|hurry|rush|rushing|spare|left|remaining|plenty|enough|ample|loads|lots|lot|extra|free|whole|entire|full|half|quarter|couple|few|several|dozen|double|twice|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|hundred|o'clock|am|pm|back|return|returning|countdown|usable)$/,
  // place, movement, transport
  /^(?:airport|terminal|terminals|inside|outside|out|into|onto|through|toward|towards|across|around|beyond|past|away|near|nearby|far|close|closer|closest|within|via|area|city|town|downtown|centre|center|landside|airside|neighbourhood|neighborhood|go|goes|going|went|head|heading|leave|leaving|exit|exiting|walk|walking|ride|riding|drive|visit|visiting|explore|exploring|tour|trip|outing|adventure|excursion|sightseeing|wander|stroll|journey|travel|taxi|cab|train|metro|subway|bus|shuttle|tram|uber|ferry|transit|transport|route|distance|garden|market|temple|museum|beach|park|street|reach|reachable|meet|join)$/,
  // entry
  /^(?:visa|visas|passport|passports|entry|enter|entering|border|borders|immigration|customs|permit|permits|allowed|allow|permission|permitted|eligible|admitted)$/,
  // operational state
  /^(?:gate|gates|flight|flights|plane|boarding|board|security|queue|queues|line|lines|wait|waiting|waits|delay|delayed|delays|cancelled|canceled|open|opens|closed|closes|busy|crowded|crowd|empty|status|schedule|scheduled|on-time|departure|arrival|connection)$/,
  // permission, reassurance, risk, fit
  /^(?:safe|safely|safety|unsafe|risk|risky|danger|dangerous|okay|ok|fine|sure|surely|easy|easily|worry|worried|need|needs|able|recommend|recommended|recommendation|definitely|certainly|absolutely|guaranteed|guarantee|fit|fits|fitting|feasible|possible|course|budget|anywhere|everywhere|everything|nothing|anything|all|make|makes|made|get|gets|got|reach|there|works?|manage|manageable|catch)$/,
];

/**
 * A sentence must be ABOUT something certified or tasteful: it needs one of
 * these nouns (or a masked certified name). "You have more than you think" uses
 * only admitted words and still reassures about time by ellipsis; with no
 * subject it is withheld.
 */
export const ASSISTANT_CONTENT_NOUNS: ReadonlySet<string> = new Set(`
food foods meal meals snack snacks bite coffee tea drink drinks juice smoothie beer wine cocktail dessert desserts noodles
noodle dumplings dumpling ramen sushi rice soup salad sandwich burger pizza pastry pastries bakery bread cake chocolate fruit
cuisine dish dishes flavor flavour flavors flavours tastes menu restaurant restaurants cafe bar bars eatery lounge lounges shops
shopping store stores boutique bookstore bookshop books magazine gifts souvenirs spa massage shower showers nap sleep music art
gallery seat seats chair space spot corner place option options choice choices idea ideas picks experience experiences
`.trim().split(/\s+/));

export function inSafetyLexicon(word: string): boolean {
  return SAFETY_LEXICON.some((re) => re.test(word.toLowerCase()));
}

/** Characters a sentence may contain AFTER names are masked: plain Latin letters, spaces, light punctuation. */
const ADMISSIBLE_CHARS = /^[A-Za-z\s.,!;:'’()&\u0001-]*$/;

/**
 * Layer 4. A model sentence is admitted ONLY when, with the certified names
 * masked, it is plain Latin text whose every word is in ASSISTANT_VOCABULARY,
 * it carries no digit and it asks nothing. Anything else is withheld, with the
 * reason — never rewritten.
 */
export function admitModelSentence(sentence: string, names: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (/[?¿]/.test(sentence)) return { ok: false, reason: "question" };
  let masked = sentence.replace(/[’‘]/g, "'");
  for (const n of [...names].filter((x) => x.trim().length >= 2).sort((a, b) => b.length - a.length)) {
    masked = masked.split(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[’‘]/g, "'"), "gi")).join("\u0001");
  }
  if (/\d/.test(masked)) return { ok: false, reason: "number" };
  if (!ADMISSIBLE_CHARS.test(masked)) return { ok: false, reason: "unanalysable_character" };
  const words = masked.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (words.length === 0 && !masked.includes("\u0001")) return { ok: false, reason: "empty" };
  if (words.length > 40) return { ok: false, reason: "too_long" };
  for (const w of words) if (!ASSISTANT_VOCABULARY.has(w)) return { ok: false, reason: `word_outside_vocabulary:${w}` };
  if (!masked.includes("\u0001") && !words.some((w) => ASSISTANT_CONTENT_NOUNS.has(w))) return { ok: false, reason: "no_subject" };
  return { ok: true };
}

export function confineModelText(text: string, names: readonly string[], maxSentences: number): { admitted: string[]; dropped: Array<{ sentence: string; reason: string }> } {
  const admitted: string[] = [];
  const dropped: Array<{ sentence: string; reason: string }> = [];
  for (const s of splitSentences(text)) {
    const verdict = admitModelSentence(s, names);
    if (!verdict.ok) { dropped.push({ sentence: s, reason: verdict.reason }); continue; }
    if (admitted.length >= maxSentences) { dropped.push({ sentence: s, reason: "over_sentence_budget" }); continue; }
    admitted.push(/[.!]$/.test(s) ? s : `${s}.`);
  }
  return { admitted, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// The assisted answer
// ─────────────────────────────────────────────────────────────────────────────

export type AssistantFallbackReason =
  | "rate_limited"
  | "certification_mismatch"
  | "model_error"
  | "model_timeout"
  | "model_empty"
  | "boundary_violation"
  | "nothing_admitted";

export interface CompassAssistantStatus {
  enabled: boolean;
  /** off = flag off; answered = model content reached the traveller; fallback = the certified answer alone, for `fallbackReason`. */
  status: "off" | "answered" | "fallback";
  fallbackReason: AssistantFallbackReason | null;
  model: string | null;
}

/** One server-rendered comparison line: the plan's certified fit, plus the model's admitted note. */
export interface PlanComparisonLine {
  planRef: string;
  title: string;
  available: boolean;
  status: string;
  note: string | null;
}

export interface CompassAssistantAnswer extends Omit<CompassLayoverAnswer, "boundaryViolations" | "toolsConsulted" | "modelProse" | "modelConsulted" | "clarifyingQuestion"> {
  clarifyingQuestion: ClarifyingQuestion | PlanAwareClarifyingQuestion | null;
  boundaryViolations: CompassBoundaryViolation[];
  toolsConsulted: LayoverToolName[];
  modelProse: { mode: "certified_only" | "confined"; droppedSentences: number };
  modelConsulted: boolean;
  planComparison: PlanComparisonLine[];
  assistant: CompassAssistantStatus;
}

/** The certified-only answer, as the door publishes it with the assistant OFF. */
export function assistantOff(base: CompassLayoverAnswer): CompassAssistantAnswer {
  return { ...base, planComparison: [], assistant: { enabled: false, status: "off", fallbackReason: null, model: null } };
}

export interface CompassAssistantInput {
  question: string;
  session: LayoverSession;
  airport: AirportProfile;
  entry?: EntryEligibility | null;
  snapshot?: LayoverSnapshot | null;
  /** The certification instant. REQUIRED: the assistant reads no clock of its own. */
  nowMs: number;
  userId: string;
  sources: LayoverToolSources;
  limits?: Partial<AssistantLimits>;
  /** The certified answer the route already computed for THIS question and instant; recomputed when absent. Its certification must match (checked). */
  base?: CompassLayoverAnswer;
}

/** The fixed server sentence when the model previews a flight change: the persisted replan is the traveller's report. */
export const REPORT_FLIGHT_CHANGE_SENTENCE =
  "If your flight has changed, report it under “Flight delayed or cancelled?” on your layover screen, so your plan is re-checked from what you report.";

class AssistantTimeout extends Error { constructor() { super("assistant_timeout"); this.name = "AssistantTimeout"; } }

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new AssistantTimeout()); }, Math.max(1, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The route's lazy reads, memoised, each with a NAMED absence and a NAMED failure. */
export function toolSources(s: LayoverToolSources): LayoverToolContext["sources"] {
  const absent = (name: string) => ({ ok: false as const, reason: `${name}_not_read` });
  const failed = (name: string) => ({ ok: false as const, reason: `${name}_unreadable` });
  return {
    recommendations: memo(s.recommendations, absent("layover_recommendations"), failed("layover_recommendations")),
    stops: memo(s.stops, absent("layover_plan_stops"), failed("layover_plan_stops")),
    // CompassCrewCandidates' own failure literal is `layover_crew_unreadable`; "not read" is spelled as a reason too.
    crew: memo(s.crew, { ok: false, reason: "crew_candidates_not_read" } as unknown as CompassCrewCandidates, { ok: false, reason: "layover_crew_unreadable" }),
    disruption: memo(s.disruption, absent("disruption_ledger"), failed("disruption_ledger")),
    opportunities: memo(s.opportunities, absent("layover_opportunities"), failed("layover_opportunities")),
  };
}

/** A route read, run at most once per answer. Not offered → `absent`; threw → `failed` (an unreadable read, never an empty one). */
function memo<T>(fn: (() => Promise<T>) | undefined, absent: T, failed: T): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) p = fn ? fn().catch(() => failed) : Promise.resolve(absent);
    return p;
  };
}

const SYSTEM_PROMPT = `You are Compass, Portava's layover assistant. The app itself shows the traveller every certified safety fact: whether leaving the airport is allowed, the return deadline, the usable time, entry and visa status, airport operations and the risk band. You never state, imply or restate any of those.
Your job: compare the traveller's CERTIFIED options by taste, personalise the wording, and use the tools to read the certified record.
Rules:
- "reply": at most three short sentences of plain English about taste and choice.
- Never write numbers, times, durations, deadlines, places outside the airport, transport, visas, entry, immigration, security, queues, gates, flights, delays, or whether something is safe, allowed or fits. The app writes those.
- Never ask a question. If a missing detail matters, call requestConstraintClarification; the app asks the one question that matters. You cannot change the traveller's details.
- Compare only plan refs from the list you are given or from getReachableExperiences / simulatePlan. Never invent a plan.
- If the traveller mentions a flight change, call replan with the matching trigger; it only previews.
Respond with JSON only: {"reply": string, "compare": [{"planRef": string, "why": string}], "clarify": string | null}`;

function userPrompt(input: CompassAssistantInput, record: LayoverFeasibilityRecord, planList: readonly PlanCandidate[]): string {
  const lines = [
    `Traveller question: ${JSON.stringify(input.question.slice(0, 500))}`,
    `sessionId: ${input.session.id}`,
    `Airport: ${input.airport.name} (${input.airport.iataCode})`,
    `Certified verdict (for your reasoning only; never restate it): ${record.verdict}; landside gate: ${landsideStatusOf(record)}`,
    `Traveller interests: ${(input.session.vibeChips ?? []).join(", ") || "none stated"}; comfort: ${input.session.comfortLevel}`,
    `Plan refs you may compare: ${planList.length ? planList.map((p) => `${p.ref} ${JSON.stringify(p.title)}`).join("; ") : "none"}`,
  ];
  return lines.join("\n");
}

/** Tolerant parse of the model's final content. Not JSON → the whole content is `reply` (and is gated like any reply). */
export function parseAssistantOutput(content: string, maxCompare: number): { reply: string; compare: Array<{ planRef: string; why: string }>; clarify: string | null } {
  const trimmed = content.trim();
  let obj: unknown = null;
  try { obj = JSON.parse(trimmed); } catch {
    const a = trimmed.indexOf("{"); const b = trimmed.lastIndexOf("}");
    if (a >= 0 && b > a) { try { obj = JSON.parse(trimmed.slice(a, b + 1)); } catch { obj = null; } }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { reply: trimmed.slice(0, 1200), compare: [], clarify: null };
  const o = obj as Record<string, unknown>;
  const compare: Array<{ planRef: string; why: string }> = [];
  if (Array.isArray(o.compare)) {
    for (const c of o.compare) {
      if (!c || typeof c !== "object") continue;
      const ref = (c as Record<string, unknown>).planRef;
      const why = (c as Record<string, unknown>).why;
      if (typeof ref === "string" && !compare.some((x) => x.planRef === ref)) compare.push({ planRef: ref, why: typeof why === "string" ? why.slice(0, 300) : "" });
      if (compare.length >= maxCompare) break;
    }
  }
  return { reply: typeof o.reply === "string" ? o.reply.slice(0, 1200) : "", compare, clarify: typeof o.clarify === "string" ? o.clarify : null };
}

/**
 * §12 on the layover door: the certified answer, then — behind the flag — the
 * model as orchestrator and explainer, held by the four layers in the header.
 * NEVER THROWS: every failure returns the certified answer with its reason.
 */
export async function answerLayoverQuestionWithAssistant(db: SupabaseClient | null, input: CompassAssistantInput): Promise<CompassAssistantAnswer> {
  const limits: AssistantLimits = { ...ASSISTANT_LIMITS, ...(input.limits ?? {}) };
  const entry = input.entry ?? null;
  // The certified core: the safety facts, the airport facts and the
  // certification header — exactly the answer the flag-OFF door gives.
  const base = input.base ?? await answerLayoverQuestion(db as SupabaseClient, { question: input.question, session: input.session, airport: input.airport, entry, snapshot: input.snapshot ?? null, nowMs: input.nowMs });
  const fallback = (reason: AssistantFallbackReason, extra: Partial<CompassAssistantAnswer> = {}): CompassAssistantAnswer => ({
    ...base, planComparison: [], ...extra, assistant: { enabled: true, status: "fallback", fallbackReason: reason, model: ASSISTANT_MODEL },
  });

  const rl = checkRateLimit(ASSISTANT_RATE_LIMITER, input.userId, limits.ratePerMinute, 60_000);
  if (!rl.allowed) return fallback("rate_limited");

  // THE SAME record the certified text was read off, or nothing at all.
  const record = input.snapshot?.certifiedRecord ?? certifySessionFeasibility(input.airport, input.session, { nowMs: input.nowMs, entry });
  if (certificationHeader(record).inputHash !== base.certification.inputHash) return fallback("certification_mismatch");
  const usableMinutes = input.snapshot ? input.snapshot.usableMinutes : record.envelope.usableMinutes;

  const ctx: LayoverToolContext = { db, session: input.session, airport: input.airport, record, usableMinutes, entry, nowMs: input.nowMs, sources: toolSources(input.sources) };

  const plans = await planCandidates(ctx);
  // §12.1: ONE question, the decisive one, measured by re-certification — the
  // model cannot add one (its questions are withheld) or swap in a weaker one.
  const clarifyingQuestion = planAwareClarifications(input.airport, input.session, input.nowMs, entry, plans)[0] ?? null;

  // ── the model, with the twelve tools ─────────────────────────────────────
  const consulted: LayoverToolName[] = [];
  let replanFlightPreviewed = false;
  const controller = new AbortController();
  const startedAt = Date.now();
  let content = "";
  try {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(input, record, plans) },
    ];
    for (let round = 0; round <= limits.maxToolRounds; round += 1) {
      const forceFinal = round === limits.maxToolRounds;
      const remaining = limits.totalDeadlineMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new AssistantTimeout();
      const request = getOpenAI().chat.completions.create(
        {
          model: ASSISTANT_MODEL,
          max_completion_tokens: limits.maxCompletionTokens,
          reasoning_effort: "low",
          messages,
          ...(forceFinal ? {} : { tools: LAYOVER_TOOL_SCHEMAS, tool_choice: "auto" }),
        } as never,
        { timeout: limits.perCallTimeoutMs, maxRetries: 0, signal: controller.signal } as never,
      ) as unknown as Promise<{ choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown } }> }>;
      const completion = await withDeadline(request, Math.min(limits.perCallTimeoutMs, remaining), () => controller.abort());
      const message = completion?.choices?.[0]?.message ?? {};
      const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) : [];
      if (calls.length === 0 || forceFinal) { content = String(message.content ?? "").trim(); break; }
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const [i, c] of calls.entries()) {
        const result = i < limits.maxToolCallsPerRound
          ? await runNamedLayoverTool(c?.function?.name, ctx, c?.function?.arguments)
          : { ok: false as const, tool: String(c?.function?.name ?? ""), unavailable: true as const, reason: "tool_call_budget_exhausted" };
        if (result.ok) {
          consulted.push(result.tool);
          if (result.tool === "replan" && String(result.data.trigger ?? "").startsWith("flight.")) replanFlightPreviewed = true;
        }
        messages.push({ role: "tool", tool_call_id: String(c?.id ?? ""), content: JSON.stringify(result).slice(0, 8000) });
      }
    }
  } catch (err) {
    const timedOut = err instanceof AssistantTimeout || controller.signal.aborted || /timeout|timed out|abort/i.test(String((err as { name?: unknown; message?: unknown })?.name ?? "") + String((err as { message?: unknown })?.message ?? ""));
    return fallback(timedOut ? "model_timeout" : "model_error", { modelConsulted: true, toolsConsulted: consulted, clarifyingQuestion });
  }
  if (!content) return fallback("model_empty", { modelConsulted: true, toolsConsulted: consulted, clarifyingQuestion });

  const out = parseAssistantOutput(content, limits.maxCompareItems);
  const explicitYes = layoverModelMayAnswer(record, usableMinutes);
  const envelope: EnvelopeContext = {
    airport: input.airport, hardReturnTime: record.deadline.hardReturnTime, usableMinutes,
    verdict: record.verdict, explicitYes, safeBand: explicitYes && usableMinutes >= 60, nowMs: input.nowMs,
  };
  const modelSentenceCount = splitSentences(out.reply).length + out.compare.reduce((n, c) => n + splitSentences(c.why).length, 0);

  // Layer 3: ONE detected widening anywhere withdraws everything the model wrote.
  const detected = enforceCompassEnvelope([out.reply, ...out.compare.map((c) => c.why)].join(" \n"), envelope);
  if (!detected.ok) {
    return fallback("boundary_violation", { modelConsulted: true, toolsConsulted: consulted, clarifyingQuestion, boundaryViolations: withheld(detected.violations), modelProse: { mode: "certified_only", droppedSentences: modelSentenceCount } });
  }

  // The names a model sentence may use: the airport's, and the titles of
  // certified plans that FIT this window. Not a plan that overflows it (an
  // airside spa that outlasts the window is still a missed flight), not a
  // landside place the record does not admit, and never other travellers' text
  // (crew titles are theirs to write — the crew card shows them, the model may not relay them).
  const names = [input.airport.name, ...plans.filter((p) => nameable(record, p)).map((p) => p.title)];

  // Comparison: server-rendered from the certified fit of plans the record knows.
  const comparison: PlanComparisonLine[] = [];
  let dropped = 0;
  for (const c of out.compare) {
    const plan = plans.find((p) => p.ref === c.planRef);
    if (!plan) { dropped += splitSentences(c.why).length; continue; } // an invented plan is not compared
    const fit = certifiedPlanFit(record, plan.stops);
    const insideAirport = plan.stops.length > 0 && plan.stops.every((s) => s.insideAirport === true);
    const note = confineModelText(c.why, names, 1);
    dropped += note.dropped.length;
    comparison.push({ planRef: plan.ref, title: plan.title, available: fit.fitsWindow, status: fitStatusText(fit, insideAirport), note: note.admitted[0] ?? null });
  }

  // Layer 4: sentence by sentence, the closed vocabulary.
  const reply = confineModelText(out.reply, names, limits.maxReplySentences);
  dropped += reply.dropped.length;

  // Defence in depth: what is about to be published from the model, re-checked.
  const fromModel = [...reply.admitted, ...comparison.map((l) => l.note ?? "")].join(" ");
  const recheck = enforceCompassEnvelope(fromModel, envelope);
  if (!recheck.ok) {
    return fallback("boundary_violation", { modelConsulted: true, toolsConsulted: consulted, clarifyingQuestion, boundaryViolations: withheld(recheck.violations), modelProse: { mode: "certified_only", droppedSentences: modelSentenceCount } });
  }

  const admittedCount = reply.admitted.length + comparison.filter((l) => l.note).length;
  if (admittedCount === 0 && comparison.length === 0 && !replanFlightPreviewed) {
    return fallback("nothing_admitted", { modelConsulted: true, toolsConsulted: consulted, clarifyingQuestion, modelProse: { mode: "certified_only", droppedSentences: dropped } });
  }

  // The certified text LEADS; then the server's own replan pointer; then what the model may add.
  const parts = [base.answer];
  if (replanFlightPreviewed) parts.push(REPORT_FLIGHT_CHANGE_SENTENCE);
  if (reply.admitted.length) parts.push(reply.admitted.join(" "));
  if (comparison.length) parts.push(`Comparing your options: ${comparison.map((l) => `${l.title} — ${l.status}.${l.note ? ` ${l.note}` : ""}`).join(" ")}`);

  return {
    ...base,
    answer: sanitizeCompassAnswer(parts.join(" ")),
    clarifyingQuestion,
    boundaryViolations: [],
    toolsConsulted: consulted,
    modelProse: { mode: admittedCount > 0 ? "confined" : "certified_only", droppedSentences: dropped },
    modelConsulted: true,
    planComparison: comparison,
    assistant: { enabled: true, status: "answered", fallbackReason: null, model: ASSISTANT_MODEL },
  };
}

/**
 * What the response says about a withdrawn attempt: its KIND and the certified
 * value it contradicted — never the model's words. The words are the thing
 * withheld; publishing them in a diagnostic field would still put them on the
 * traveller's device.
 */
export function withheld(violations: readonly CompassBoundaryViolation[]): CompassBoundaryViolation[] {
  return violations.map((v) => ({ kind: v.kind, stated: "(withheld)", certified: v.certified }));
}

/** A plan whose title the model may NAME: its certified fit is `fits` (which a closed landside gate never gives a landside plan). */
export function nameable(record: LayoverFeasibilityRecord, p: PlanCandidate): boolean {
  return certifiedPlanFit(record, p.stops).fitsWindow;
}

// ─────────────────────────────────────────────────────────────────────────────
// §25 / L98 — the OpportunityEvents the replanner pushed, read for getConnectionState
// ─────────────────────────────────────────────────────────────────────────────

/** `LayoverOpportunityNotifier.LAYOVER_OPPORTUNITY_EVENT_TYPE`, spelled here to avoid importing the notifier's delivery graph. */
export const OPPORTUNITY_EVENT_TYPE = "compass.layover.opportunity";

/**
 * The traveller's own layover-opportunity notifications for THIS session,
 * newest first (owner-scoped: `user_id` and the session's action URL). A failed
 * read is a reason, never "no opportunities".
 */
export async function readLayoverOpportunities(db: SupabaseClient, userId: string, sessionId: string): Promise<ToolRead<ToolOpportunity[]>> {
  const { data, error } = await db
    .from("notifications")
    .select("title, body, priority, created_at")
    .eq("user_id", userId)
    .eq("event_type", OPPORTUNITY_EVENT_TYPE)
    .eq("action_url", `/airport/sessions/${sessionId}`)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) {
    logger.warn({ err: error, sessionId }, "layover opportunity read failed — the assistant reports it unreadable, never 'no opportunities'");
    return { ok: false, reason: "layover_opportunities_unreadable" };
  }
  return {
    ok: true,
    value: (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
      title: String(row.title ?? ""), why: String(row.body ?? ""), priority: String(row.priority ?? "normal"), at: String(row.created_at ?? ""),
    })),
  };
}
