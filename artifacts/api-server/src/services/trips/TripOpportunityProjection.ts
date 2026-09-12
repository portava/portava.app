/**
 * Trips spec §13 — the Opportunity projection (census-trips TR224–TR253,
 * TR263, TR397, TR413): the experience compiler's eight inputs gathered from
 * the trip, compiled per open freedom window, diffed against the last
 * portfolio, and the change recorded as trip.opportunities_changed (2786)
 * when it matters.
 *
 * THE SHAPE OF THE READ
 * =====================
 * 1. Version first; the health, freedom and pulse projections accepted
 *    against it (§22.4). Freedom supplies the windows and the next
 *    commitment; the pulse supplies live conditions and the attention state.
 * 2. Candidates: the crew's saved ideas (trip_saved_places), with a place
 *    type, coordinates, and — for the ones that name a canonical place —
 *    closure.state / queue.wait / access.reservation from
 *    intel_state_snapshots. Opening hours: this system stores none for a
 *    place (places has no hours column), so a candidate's hours are null and
 *    a venue-bound primitive is UNCERTAIN, never EXECUTABLE, until a source
 *    exists. That is §22.4's rule applied to what we do not know.
 * 3. Goals (trip_goals), participants (accepted members), the viewer's
 *    position — the pulse's, read under §10 — as the origin when the
 *    window's origin has no coordinates.
 * 4. compileExperiences per window (services/trips/TripExperienceCompiler),
 *    the current-or-next window first.
 * 5. The PREVIOUS portfolio for that window is the latest ledgered
 *    'opportunity_portfolio' decision (trip_decisions, 2781) — in process
 *    when the table is not there — and diffOpportunities gives the §13.3
 *    event. If it is significant (§13.3 "changes enough to matter") and
 *    trip_kernel_enabled is on, RECORD_OPPORTUNITY_CHANGE is issued with an
 *    idempotency key made of the window and the diff, so a recompute that
 *    finds the same change is one event.
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not push. The attention policy is handed the event's kind and
 * significance by whoever delivers (a worker this codebase does not yet
 * have, §19.4); `notify` on the projection says what that delivery would
 * decide. It does not search the city: candidates are what the crew saved.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { incrementTripMetric } from "../../lib/tripMetrics.js";
import { executeTripCommand } from "../../lib/tripKernel.js";
import {
  liveEnvelope, acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION, type TripProjectionEnvelope,
} from "./TripProjectionEnvelope.js";
import { buildTripHealthProjection, type TripHealthProjection } from "./TripHealthProjection.js";
import { buildTripFreedomProjection, type TripFreedomProjection } from "./TripFreedomProjection.js";
import { buildTripPulseProjection, type TripPulseProjection } from "./TripPulseProjection.js";
import { haversineMeters, WALK_METRES_PER_SECOND, DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_MAX_METRES } from "./TravelTimeProvider.js";
import {
  compileExperiences, type ExperienceCandidate, type ExecutableTripExperience, type TravelEstimator, type CompileGoal, type GeoPoint,
} from "./TripExperienceCompiler.js";
import {
  diffOpportunities, shouldNotify, attentionKindFor, type OpportunityPortfolio, type OpportunityEvent, type OpportunityTrigger,
} from "./TripOpportunityEngine.js";
import { decideAttention, TRIP_PUSH_EVENT_PROFILES, type AttentionLevel } from "./TripAttentionPolicy.js";
import { recordTripDecision, persistTripDecision, listTripDecisions, TRIP_ENGINE_VERSIONS, type TripDecision } from "./TripDecisionLedger.js";

const log = logger.child({ mod: "tripOpportunityProjection" });

export interface WindowPortfolioView {
  windowId: string;
  window: OpportunityPortfolio["window"];
  executable: ExecutableTripExperience[];
  uncertain: ExecutableTripExperience[];
  notExecutable: ExecutableTripExperience[];
  candidates: number;
}

export interface TripOpportunityProjection extends TripProjectionEnvelope {
  tripId: string;
  decisionId: string;
  /** §17.2: what the trip is under; AT_RISK / SAFETY_EVENT suppress this projection's discovery. */
  attention: TripHealthProjection["attention"];
  /** The current-or-next window's portfolio, first; every open window after it. */
  windows: WindowPortfolioView[];
  /** §13.3 — the diff for the first window against its last ledgered portfolio. Null when there is no open window. */
  event: OpportunityEvent | null;
  /** What §11.4 would decide for `event`, per participant — decided, not sent. */
  notify: { wouldNotify: boolean; kind: string | null; level: AttentionLevel | null; reason: string };
  /** What the kernel was told. */
  recorded: { issued: boolean; duplicate: boolean; skipped: string | null; failed: string | null };
  sources: { savedIdeas: number; intelSnapshots: "ok" | "unread" | "none"; goals: number; participants: number; origin: "window" | "viewer_presence" | "none" };
  derivedFrom: { healthDecisionId: string; freedomDecisionId: string; pulseDecisionId: string; sourceTripVersion: number | null };
  reading: string;
}

export type OpportunityProjectionResult =
  | { ok: true; projection: TripOpportunityProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED" | "TRIP_PROJECTION_VERSION_AHEAD" | "TRIP_PROJECTION_SCHEMA_MISMATCH" | "TRIP_PROJECTION_STALE"; message: string };

export const OPPORTUNITY_READING =
  "Each window's experiences are the crew's saved ideas compiled against the window, travel both ways, the next commitment, live conditions, goals and participants (§13.1). " +
  "EXECUTABLE means fits, open on arrival and for the minimum stay, nothing forbids it; UNCERTAIN means something needed is unknown — hours, travel, coordinates — and unknown is not promoted; NOT_EXECUTABLE names the reason. " +
  "The event is the change since the last portfolio of the same window (§13.3); only a change that matters is recorded, and none is pushed from here.";

/** Straight-line travel with the provider's own constants: walk under 2 km, otherwise drive plus a wait. */
export const straightLineEstimator: TravelEstimator = {
  minutes(from: GeoPoint, to: GeoPoint) {
    const d = haversineMeters(from, to);
    if (!Number.isFinite(d)) return null;
    return d <= WALK_MAX_METRES
      ? { minutes: Math.ceil(d / WALK_METRES_PER_SECOND / 60), mode: "walk" }
      : { minutes: Math.ceil((d / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60), mode: "drive" };
  },
};

const OPPORTUNITY_CLAIM_TYPES = ["closure.state", "queue.wait", "crowd.level", "access.reservation"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function point(lat: unknown, lng: unknown): GeoPoint | null {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function scalar(value: unknown, keys: string[]): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const k of keys) if (typeof v[k] === "string") return v[k] as string;
  return null;
}
function numberOf(value: unknown, keys: string[]): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const k of keys) if (typeof v[k] === "number") return v[k] as number;
  return null;
}

/** A portfolio as the ledger keeps it: ids and verdicts, not the full experiences. */
interface LedgeredPortfolio { windowId: string; window: OpportunityPortfolio["window"]; executable: { id: string; candidateId: string; name: string; score: number; servesGoalIds: string[] }[]; notExecutable: { id: string; candidateId: string; name: string; verdict: string; reasonCodes: string[] }[]; computedAt: string; sourceTripVersion: number | null }

const lastPortfolio = new Map<string, LedgeredPortfolio>();
export function _resetOpportunityPortfolios(): void { lastPortfolio.clear(); }

async function readPreviousPortfolio(sc: any, tripId: string, windowId: string): Promise<LedgeredPortfolio | null> {
  // the ring first (same process), then the table (2781)
  const local = listTripDecisions(tripId).filter((d) => d.type === "opportunity_portfolio" && (d.result as any)?.windowId === windowId).sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
  if (local) return (local.result as any).portfolio as LedgeredPortfolio;
  const mem = lastPortfolio.get(`${tripId}:${windowId}`);
  if (mem) return mem;
  try {
    const { data, error } = await sc.from("trip_decisions").select("result_json, calculated_at").eq("trip_id", tripId).eq("decision_type", "opportunity_portfolio").order("calculated_at", { ascending: false }).limit(20);
    if (error) return null;
    const rows = ((data ?? []) as any[]).filter((r) => r.result_json?.windowId === windowId).sort((a, b) => String(b.calculated_at).localeCompare(String(a.calculated_at)));
    return rows[0]?.result_json?.portfolio ?? null;
  } catch { return null; }
}

function toPortfolio(tripId: string, view: WindowPortfolioView, computedAt: string, sourceTripVersion: number | null): OpportunityPortfolio {
  return {
    tripId, windowId: view.windowId, window: view.window, executable: view.executable,
    notExecutable: [...view.uncertain, ...view.notExecutable].map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, verdict: e.verdict, reasonCodes: e.reasonCodes })),
    computedAt, sourceTripVersion,
  };
}
function fromLedgered(tripId: string, l: LedgeredPortfolio): OpportunityPortfolio {
  return {
    tripId, windowId: l.windowId, window: l.window,
    executable: l.executable.map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, score: e.score, servesGoalIds: e.servesGoalIds } as ExecutableTripExperience)),
    notExecutable: l.notExecutable as any, computedAt: l.computedAt, sourceTripVersion: l.sourceTripVersion,
  };
}
function toLedgered(p: OpportunityPortfolio): LedgeredPortfolio {
  return {
    windowId: p.windowId, window: p.window,
    executable: p.executable.map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, score: e.score, servesGoalIds: e.servesGoalIds })),
    notExecutable: p.notExecutable.map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, verdict: e.verdict, reasonCodes: [...e.reasonCodes] })),
    computedAt: p.computedAt, sourceTripVersion: p.sourceTripVersion,
  };
}

function diffKey(ev: OpportunityEvent): string {
  const added = ev.opportunitiesAdded.map((a) => a.id).sort().join("|");
  const removed = ev.opportunitiesRemoved.map((r) => r.id).sort().join("|");
  return `engine:opportunity:${ev.tripId}:${ev.windowId}:${ev.significance}:${added}:${removed}`;
}

export async function buildTripOpportunityProjection(
  sc: any,
  tripId: string,
  viewerId: string,
  opts: { now?: Date; health?: TripHealthProjection; freedom?: TripFreedomProjection; pulse?: TripPulseProjection; trigger?: OpportunityTrigger } = {},
): Promise<OpportunityProjectionResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  const { data: trip, error: tripErr } = await sc.from("trips").select("id, version").eq("id", tripId).maybeSingle();
  if (tripErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const canonicalVersion: number | null = typeof (trip as any).version === "number" ? (trip as any).version : null;
  const accept = <P extends TripProjectionEnvelope>(p: P, metric: string): { ok: true } | { ok: false; reason: any; message: string } => {
    const d = acceptTripProjection(p, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric });
    return d.accepted ? { ok: true } : { ok: false, reason: d.reason, message: `${metric} refused: ${d.message}` };
  };

  let health = opts.health;
  if (!health) {
    const b = await buildTripHealthProjection(sc, tripId, viewerId, { now });
    if (!b.ok) return b.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Health: ${b.message}` } : b;
    health = b.projection;
  }
  const ha = accept(health, "TripHealthProjection"); if (!ha.ok) return ha;
  let freedom = opts.freedom;
  if (!freedom) {
    const b = await buildTripFreedomProjection(sc, tripId, { now });
    if (!b.ok) return b.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Freedom: ${b.message}` } : b;
    freedom = b.projection;
  }
  const fa = accept(freedom, "TripFreedomProjection"); if (!fa.ok) return fa;
  let pulse = opts.pulse;
  if (!pulse) {
    const b = await buildTripPulseProjection(sc, tripId, viewerId, { now, health });
    if (!b.ok) return b.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Pulse: ${b.message}` } : b;
    pulse = b.projection;
  }
  const pa = accept(pulse, "TripPulseProjection"); if (!pa.ok) return pa;

  // 2. candidates
  const { data: saved, error: sErr } = await sc.from("trip_saved_places").select("id, place_id, place_name, place_type, lat, lng").eq("trip_id", tripId);
  if (sErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "trip_saved_places could not be read" };
  const savedRows = ((saved ?? []) as any[]);
  const subjectIds = [...new Set(savedRows.map((s) => String(s.place_id ?? "")).filter((id) => UUID_RE.test(id)))];
  const live = new Map<string, { closure?: string | null; queueWaitMinutes?: number | null; crowdLevel?: string | null; reservationRequired?: boolean | null; confidence?: number | null }>();
  let intelStatus: "ok" | "unread" | "none" = "none";
  if (subjectIds.length > 0) {
    const { data: snaps, error: iErr } = await sc.from("intel_state_snapshots").select("subject_id, claim_type, value, confidence, expires_at").in("subject_id", subjectIds).in("claim_type", [...OPPORTUNITY_CLAIM_TYPES]).gt("expires_at", nowIso);
    if (iErr) intelStatus = "unread";
    else {
      intelStatus = "ok";
      for (const r of ((snaps ?? []) as any[])) {
        if (Date.parse(String(r.expires_at)) <= nowMs) continue;
        const l = live.get(String(r.subject_id)) ?? {};
        if (r.claim_type === "closure.state") l.closure = scalar(r.value, ["state", "status"]);
        if (r.claim_type === "queue.wait") l.queueWaitMinutes = numberOf(r.value, ["minutes", "wait_minutes", "p90", "value"]);
        if (r.claim_type === "crowd.level") l.crowdLevel = scalar(r.value, ["level"]);
        if (r.claim_type === "access.reservation") { const s = scalar(r.value, ["state", "status", "policy"]); l.reservationRequired = s ? /required|only/.test(s) : null; }
        l.confidence = typeof r.confidence === "number" ? r.confidence : l.confidence ?? null;
        live.set(String(r.subject_id), l);
      }
    }
  }
  const candidates: ExperienceCandidate[] = savedRows.map((s) => {
    const l = s.place_id ? live.get(String(s.place_id)) : undefined;
    return {
      id: String(s.id), placeId: s.place_id ? String(s.place_id) : null, name: String(s.place_name ?? ""), placeType: s.place_type ?? null, point: point(s.lat, s.lng),
      properties: l?.reservationRequired === true ? { reservationRequired: true } : undefined,
      openingWindows: null, // no hours source in this system — stated, not guessed
      liveConditions: l ? { closure: l.closure ?? null, queueWaitMinutes: l.queueWaitMinutes ?? null, crowdLevel: l.crowdLevel ?? null, confidence: l.confidence ?? null } : null,
      source: "saved_idea",
    };
  });

  // 3. goals, participants, origin
  const { data: goalRows, error: gErr } = await sc.from("trip_goals").select("id, type, scope, status, priority, weight").eq("trip_id", tripId);
  if (gErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "trip_goals could not be read" };
  const goals: CompileGoal[] = ((goalRows ?? []) as any[]).map((g) => ({ id: String(g.id), type: String(g.type ?? ""), scope: String(g.scope ?? "shared"), status: String(g.status ?? "open"), priority: g.priority ?? null, weight: typeof g.weight === "number" ? g.weight : null }));
  const { data: members, error: mErr } = await sc.from("trip_members").select("user_id, status").eq("trip_id", tripId);
  if (mErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "trip_members could not be read" };
  const participantIds = ((members ?? []) as any[]).filter((m) => m.status == null || m.status === "accepted").map((m) => String(m.user_id));

  // The viewer's position is the pulse's: it read the crew map under every
  // §10 rule and reports where its location band came from. One presence
  // read per request, and this file names no presence flag of its own.
  const viewerPoint: GeoPoint | null = pulse.context.locationBand?.from === "viewer_presence" ? pulse.context.locationBand.centre : null;

  // 4. compile per open window, current-or-next first
  const open = freedom.windows.filter((w) => Date.parse(w.endsAt) > nowMs).sort((a, b) => a.beginsAt.localeCompare(b.beginsAt));
  const views: WindowPortfolioView[] = [];
  let originKind: "window" | "viewer_presence" | "none" = "none";
  for (const w of open) {
    const origin = w.origin?.point ?? viewerPoint;
    if (origin) originKind = w.origin?.point ? "window" : "viewer_presence";
    const dest = w.requiredDestination;
    const r = compileExperiences({
      now: nowMs, window: w, origin, participants: participantIds.map((userId) => ({ userId })), candidates, liveSignals: pulse.signals, travel: straightLineEstimator,
      goals, preferences: {}, nextCommitment: dest ? { id: dest.commitmentId, arriveBy: dest.arriveBy, point: dest.point } : null, prepMinutes: w.reservedMinutes ?? 0,
    });
    views.push({
      windowId: w.id, window: { id: w.id, beginsAt: w.beginsAt, endsAt: w.endsAt, durationMinutes: w.durationMinutes, certified: w.certified, participants: [...w.participants] },
      executable: r.experiences.filter((e) => e.verdict === "EXECUTABLE"), uncertain: r.experiences.filter((e) => e.verdict === "UNCERTAIN"), notExecutable: r.experiences.filter((e) => e.verdict === "NOT_EXECUTABLE"),
      candidates: candidates.length,
    });
  }

  // §17.2: under AT_RISK / SAFETY_EVENT discovery is suppressed — the portfolio is computed (it is logistics too) but served empty of executables, by name.
  const suppressed = health.attention.suppression.discovery;

  // 5. the event for the first window
  let event: OpportunityEvent | null = null;
  const recorded = { issued: false, duplicate: false, skipped: null as string | null, failed: null as string | null };
  let notify: TripOpportunityProjection["notify"] = { wouldNotify: false, kind: null, level: null, reason: "no open window" };
  if (views.length > 0) {
    const first = views[0];
    const nextP = toPortfolio(tripId, first, nowIso, canonicalVersion);
    const prevL = await readPreviousPortfolio(sc, tripId, first.windowId);
    event = diffOpportunities(prevL ? fromLedgered(tripId, prevL) : null, nextP, opts.trigger ?? (prevL ? "recompute" : "initial"));
    for (const a of event.opportunitiesAdded) incrementTripMetric("opportunity_created_total", { trip: tripId, primitive: a.primitive ?? "unknown" });
    if (suppressed) {
      notify = { wouldNotify: false, kind: null, level: null, reason: `TRIP_DISRUPTION_SUPPRESSED: ${health.attention.suppression.detail}` };
    } else if (shouldNotify(event)) {
      const kind = attentionKindFor(event);
      const d = decideAttention({ kind, ...TRIP_PUSH_EVENT_PROFILES[kind], deadlineAt: event.expiresAt }, { now: nowMs, mode: health.attention.mode, recentNotifyCount: 0, quietHours: false });
      notify = { wouldNotify: d.level === "NOTIFY" || d.level === "INTERRUPT", kind, level: d.level, reason: d.reasons.join(",") };
    } else {
      notify = { wouldNotify: false, kind: null, level: null, reason: `significance ${event.significance} does not change the action universe enough to matter (§13.3)` };
    }
    // the ledger keeps this portfolio as the next diff's previous
    const ledgered = toLedgered(nextP);
    lastPortfolio.set(`${tripId}:${first.windowId}`, ledgered);
    const pd: TripDecision = recordTripDecision({
      tripId, type: "opportunity_portfolio",
      inputs: { canonicalVersion, windowId: first.windowId, candidates: candidates.length, goals: goals.length, participants: participantIds.length, liveSignals: pulse.signals.length, intel: intelStatus },
      sources: ["trip_saved_places", "trip_goals", "trip_members", "TripFreedomProjection", "TripPulseProjection", ...(intelStatus === "ok" ? ["intel_state_snapshots"] : [])],
      assumptions: ["straight-line travel with the provider's constants; hours unknown → venue-bound primitives UNCERTAIN"],
      constraints: [], result: { windowId: first.windowId, portfolio: ledgered, executable: first.executable.length },
      confidence: "N/A", engineVersions: { TripExperienceCompiler: TRIP_ENGINE_VERSIONS.TripExperienceCompiler }, calculatedAt: nowIso, sourceTripVersion: canonicalVersion,
    });
    void persistTripDecision(sc, pd);

    if (event.significance !== "none") {
      if (!(await isFlagEnabled(sc, "trip_kernel_enabled"))) recorded.skipped = "trip_kernel_enabled is false";
      else {
        try {
          const r = await executeTripCommand(sc, {
            commandId: randomUUID(), tripId, actorUserId: null, actorRole: "system", idempotencyKey: diffKey(event), type: "RECORD_OPPORTUNITY_CHANGE",
            payload: {
              trigger: event.trigger, window_id: event.windowId, previous_window: event.previousFreedomWindow, new_window: event.newFreedomWindow,
              added: event.opportunitiesAdded.map((a) => ({ id: a.id, candidateId: a.candidateId, name: a.name, primitive: a.primitive, score: a.score })),
              removed: event.opportunitiesRemoved.map((r) => ({ id: r.id, candidateId: r.candidateId, name: r.name, reasonCodes: r.reasonCodes, verdictNow: r.verdictNow })),
              significance: event.significance, expires_at: event.expiresAt, reason_codes: event.reasonCodes, source: "TripOpportunityProjection",
            },
            clientObservedAt: nowIso,
          });
          if (r.ok) { recorded.issued = !r.duplicate; recorded.duplicate = r.duplicate; }
          else recorded.failed = r.reason;
        } catch (e: any) { recorded.failed = String(e?.message ?? e); log.warn({ tripId, err: recorded.failed }, "opportunity event threw"); }
      }
    } else recorded.skipped = "no change";
  }

  const envelope = liveEnvelope(canonicalVersion, now);
  const decision = recordTripDecision({
    tripId, type: "opportunity_projection",
    inputs: { canonicalVersion, windows: views.map((v) => ({ id: v.windowId, executable: v.executable.length, uncertain: v.uncertain.length, notExecutable: v.notExecutable.length })), suppressed, trigger: event?.trigger ?? null },
    sources: ["trips", "TripHealthProjection", "TripFreedomProjection", "TripPulseProjection", "trip_saved_places", "trip_goals", "trip_members"],
    assumptions: ["the event is the diff against the last ledgered portfolio of the same window", "a significant change is recorded through the kernel, never pushed from here"],
    constraints: event ? event.reasonCodes.map(String) : [],
    result: { event: event ? { significance: event.significance, added: event.opportunitiesAdded.length, removed: event.opportunitiesRemoved.length } : null, recorded, notify },
    confidence: "N/A",
    engineVersions: { TripExperienceCompiler: TRIP_ENGINE_VERSIONS.TripExperienceCompiler, TripOpportunityEngine: TRIP_ENGINE_VERSIONS.TripOpportunityEngine, TripOpportunityProjection: TRIP_ENGINE_VERSIONS.TripOpportunityProjection },
    calculatedAt: envelope.generatedAt, sourceTripVersion: canonicalVersion,
  });
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope, tripId, decisionId: decision.decisionId, attention: health.attention,
      windows: suppressed ? views.map((v) => ({ ...v, executable: [] })) : views,
      event, notify, recorded,
      sources: { savedIdeas: candidates.length, intelSnapshots: intelStatus, goals: goals.length, participants: participantIds.length, origin: originKind },
      derivedFrom: { healthDecisionId: health.decisionId, freedomDecisionId: freedom.decisionId, pulseDecisionId: pulse.decisionId, sourceTripVersion: canonicalVersion },
      reading: OPPORTUNITY_READING,
    },
  };
}
