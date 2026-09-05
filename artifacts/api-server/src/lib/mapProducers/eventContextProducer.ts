/**
 * eventContextProducer — the `event_context` half of Map spec §10, as CAUSE
 * HYPOTHESES for the crowd-flow layer.
 *
 * §10: "Inputs may include … event context" and "Observed movement and
 * inferred cause must be separately represented." lib/crowdFlowProducer makes
 * the second sentence structural: `event_context` is a CAUSE-ONLY family, a
 * MovementSignal carrying it is rejected at intake, and the only door a cause
 * has into a published flow is `attachCauseHypotheses`, which takes a
 * `CauseHypothesis` — no actor, no group, no count. This module is the thing
 * that had never existed on the other side of that door: routes/mapProjection
 * passed no `causeHypotheses`, so `payload.inferred` was null on every flow
 * the gateway could ever serve, and §10's "inferred cause" was a field with no
 * producer.
 *
 * WHAT A HYPOTHESIS IS HERE
 * =========================
 * An event that is ADJACENT to a flow's destination zone in SPACE (inside the
 * zone, or within EVENT_CAUSE_ADJACENCY_METERS of its edge) and in TIME (on
 * now, starting within EVENT_CAUSE_UPCOMING_MINUTES, or ended within
 * EVENT_CAUSE_ENDED_MINUTES). That is a reason people MIGHT be moving there. It
 * is never evidence that anybody did: the hypothesis carries the event id as its
 * basis and nothing else, `attachCauseHypotheses` caps its confidence at
 * `provisional` and at the observation's own band, and lib/mapAggregation
 * stamps INFERRED_CAUSE_LABEL on the published half so no renderer can draw it
 * as a sighting (§37: "Do not make predictions look like observations").
 *
 * WHAT IT DOES NOT DO — the recorded ruling in lib/crowdFlowProducer.ts
 * ======================================================================
 * It never proposes a FLOW STATE. `dispersing` and `unusual_movement` are
 * explicitly-flagged observations that deriveCrowdFlow takes as given; deducing
 * "dispersing" from "an event just ended" would be an inference wearing an
 * observation's clothes. A hypothesis here explains a flow that the observed
 * families ALREADY published; it cannot create one, strengthen one, or change
 * what kind of movement it is.
 *
 * PRIVACY POSTURE
 * ===============
 * The events come from `loadNearbyEvents` — the same privacy-complete source
 * the `event` kind uses (visibility, friendship, eligibility, block set,
 * show_exact_location redaction). A viewer is therefore only ever told "the
 * event you could see anyway may explain this flow". Nothing about the event's
 * host, its attendees or its exact coordinate leaves this module: the output
 * is a sentence built from the event TITLE and an `event:<id>` reference.
 *
 * PURE. `now` is injected; there is no clock and no I/O.
 */
import type { CauseHypothesis } from "../crowdFlowProducer.js";
import { flowZoneContains, type FlowZone } from "../mapProjection.js";
import { haversineMeters } from "../protectedLocations.js";
import type { ConfidenceState } from "../mapObjects.js";

/** The subset of a `loadNearbyEvents` row this module reads. */
export interface EventContextLike {
  id: string;
  title?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

/** How far past a zone's edge an event still counts as "at" that zone. */
export const EVENT_CAUSE_ADJACENCY_METERS = 300;
/** An event starting within this many minutes may explain people heading there. */
export const EVENT_CAUSE_UPCOMING_MINUTES = 90;
/** An event that ended within this many minutes may explain people leaving. */
export const EVENT_CAUSE_ENDED_MINUTES = 60;
/** An event with no `ends_at` is assumed on for this long after it starts. */
export const EVENT_CAUSE_DEFAULT_DURATION_MINUTES = 180;
/**
 * Inside this window of the start a hypothesis is `provisional`; further out
 * it is `unverified`. attachCauseHypotheses caps either at the observation's
 * own band and at MAX_INFERRED_CAUSE_CONFIDENCE, so this can only ever lower.
 */
export const EVENT_CAUSE_NEAR_START_MINUTES = 30;

/** Longest a title survives in a cause sentence. */
const MAX_TITLE_CHARS = 80;

export type EventCausePhase = "ongoing" | "upcoming" | "ended";

export interface EventCauseCandidate {
  zoneId: string;
  eventId: string;
  phase: EventCausePhase;
  /** Minutes: until the start (upcoming), since the start (ongoing), since the end (ended). */
  minutes: number;
  hypothesis: CauseHypothesis;
}

export interface EventCauseResult {
  /** At most one per zone — the closest in time, ongoing preferred. */
  hypotheses: CauseHypothesis[];
  /** Every (zone, event) pair that was adjacent in space AND time. */
  candidates: EventCauseCandidate[];
  /** Events examined. */
  considered: number;
  /** Events that could not be placed or timed and were skipped. */
  skipped: number;
}

const PHASE_RANK: Record<EventCausePhase, number> = { ongoing: 0, upcoming: 1, ended: 2 };

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A title fit for a sentence: trimmed, single-spaced, bounded. Never empty. */
export function causeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "an event";
  const t = raw.replace(/\s+/g, " ").trim();
  if (t === "") return "an event";
  return t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS - 1)}…` : t;
}

/** The phase of an event relative to `now`, or null when it is not temporally adjacent. */
export function eventPhaseAt(
  ev: EventContextLike,
  nowMs: number,
): { phase: EventCausePhase; minutes: number } | null {
  const startMs = toMs(ev.starts_at);
  if (startMs === null) return null;
  const endRaw = toMs(ev.ends_at);
  const endMs =
    endRaw !== null && endRaw > startMs
      ? endRaw
      : startMs + EVENT_CAUSE_DEFAULT_DURATION_MINUTES * 60_000;

  if (startMs <= nowMs && nowMs < endMs) {
    return { phase: "ongoing", minutes: Math.round((nowMs - startMs) / 60_000) };
  }
  if (startMs > nowMs) {
    const ahead = startMs - nowMs;
    if (ahead <= EVENT_CAUSE_UPCOMING_MINUTES * 60_000) {
      return { phase: "upcoming", minutes: Math.max(1, Math.round(ahead / 60_000)) };
    }
    return null;
  }
  const since = nowMs - endMs;
  if (since >= 0 && since <= EVENT_CAUSE_ENDED_MINUTES * 60_000) {
    return { phase: "ended", minutes: Math.round(since / 60_000) };
  }
  return null;
}

/** Inside the zone, or within EVENT_CAUSE_ADJACENCY_METERS of its edge. */
export function eventAdjacentToZone(zone: FlowZone, lat: number, lng: number): boolean {
  if (flowZoneContains(zone, lat, lng)) return true;
  const d = haversineMeters(zone.centroid.lat, zone.centroid.lng, lat, lng);
  return d <= zone.extentMeters / 2 + EVENT_CAUSE_ADJACENCY_METERS;
}

function causeSentence(title: string, phase: EventCausePhase, minutes: number): string {
  switch (phase) {
    case "ongoing":
      return `Event nearby: ${title} is happening now`;
    case "upcoming":
      return `Event nearby: ${title} starts in ${minutes} min`;
    case "ended":
      return minutes <= 0
        ? `Event nearby: ${title} just ended`
        : `Event nearby: ${title} ended ${minutes} min ago`;
  }
}

function proposedConfidence(phase: EventCausePhase, minutes: number): ConfidenceState {
  if (phase === "ongoing") return "provisional";
  if (phase === "upcoming" && minutes <= EVENT_CAUSE_NEAR_START_MINUTES) return "provisional";
  return "unverified";
}

/**
 * Propose at most one cause per flow zone from the events adjacent to it.
 *
 * Deterministic: ongoing beats upcoming beats ended; within a phase the
 * closest-in-time event wins; ties break on event id. So the same world always
 * yields the same sentence, and paging cannot flicker between two hypotheses.
 */
export function deriveEventCauseHypotheses(
  events: readonly EventContextLike[] | null | undefined,
  zones: readonly FlowZone[] | null | undefined,
  opts: { now?: string | number | Date } = {},
): EventCauseResult {
  const out: EventCauseResult = { hypotheses: [], candidates: [], considered: 0, skipped: 0 };
  if (!Array.isArray(events) || events.length === 0) return out;
  if (!Array.isArray(zones) || zones.length === 0) return out;
  const nowMs = toMs(opts.now ?? Date.now());
  if (nowMs === null) return out;

  for (const ev of events) {
    out.considered += 1;
    if (!ev || typeof ev.id !== "string" || ev.id === "") { out.skipped += 1; continue; }
    const lat = ev.location_lat;
    const lng = ev.location_lng;
    // loadNearbyEvents NULLS a hidden exact location: no coordinate, no adjacency.
    if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      out.skipped += 1;
      continue;
    }
    const timing = eventPhaseAt(ev, nowMs);
    if (!timing) continue;

    const title = causeTitle(ev.title);
    for (const zone of zones) {
      if (!eventAdjacentToZone(zone, lat, lng)) continue;
      out.candidates.push({
        zoneId: zone.id,
        eventId: ev.id,
        phase: timing.phase,
        minutes: timing.minutes,
        hypothesis: {
          zoneId: zone.id,
          cause: causeSentence(title, timing.phase, timing.minutes),
          // The basis names the EVENT, never a person or a coordinate.
          basis: [`event:${ev.id}`],
          confidence: proposedConfidence(timing.phase, timing.minutes),
        },
      });
    }
  }

  const best = new Map<string, EventCauseCandidate>();
  for (const c of out.candidates) {
    const cur = best.get(c.zoneId);
    if (!cur || compareCandidates(c, cur) < 0) best.set(c.zoneId, c);
  }
  out.hypotheses = [...best.values()]
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0))
    .map((c) => c.hypothesis);
  return out;
}

function compareCandidates(a: EventCauseCandidate, b: EventCauseCandidate): number {
  const pr = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  if (pr !== 0) return pr;
  if (a.minutes !== b.minutes) return a.minutes - b.minutes;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}
