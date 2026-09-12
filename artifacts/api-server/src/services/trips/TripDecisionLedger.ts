/**
 * Trips spec §21.2 — the decision ledger, and §12.1 / §19.2's
 * `explainTripDecision(decisionId)`.
 *
 * §21.2, verbatim:
 *
 *   TripDecision { decisionId tripId type inputs sources assumptions
 *                  constraints result confidence engineVersions calculatedAt }
 *   Any consequential automated suggestion/replan should be explainable from
 *   stored inputs and versioned algorithms without retaining unnecessary
 *   sensitive raw data.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR401: "No decision ledger." TR402: one narrow instance is
 * explainable (`route_plans.compass_explanation`, a cached paragraph). TR213
 * and TR376: nothing to explain and no route to explain it on.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ================================
 * Every §40.3-§40.5 projection is a deterministic function of STORED rows
 * (the commitments, the risk register, the plan, `trips.version`) and
 * VERSIONED algorithms (the engines below). Each build records a
 * TripDecision naming the row ids and versions it read, the engine versions
 * it ran, what it assumed, what constrained it, and a summary of what it
 * concluded — never a coordinate, never a name, never a row body. That is
 * §21.2's "explainable from stored inputs and versioned algorithms without
 * retaining unnecessary sensitive raw data", and `explainTripDecision` turns
 * one record into sentences.
 *
 * THE LEDGER IS IN-PROCESS. There is no `trip_decisions` table: creating one
 * is a migration this environment cannot execute (no database, no docker
 * daemon), and this document does not call a migration built on a text test
 * alone. The records live in a per-process ring of TRIP_DECISION_RING
 * entries; a decision id from a previous process, or one that has been
 * displaced, is answered "not retained", by name, rather than recomputed and
 * passed off as the original. census-trips §40.6 grades this W for exactly
 * that reason and says what the table would change.
 */
import type { TravelConfidence } from "../../lib/travelEstimate.js";

/** Bump when an engine's OUTPUT for the same inputs changes. Recorded on every decision. */
export const TRIP_ENGINE_VERSIONS = {
  TravelTimeProvider: "straight-line/fastest-mode.2026-09-12",
  TripFeasibilityEngine: "2026-09-09.1",
  TripFreedomEngine: "2026-09-12.1",
  TripHealth: "2026-09-12.1",
  TripOperationalPhase: "2026-09-12.1",
  TripTodayProjection: "2026-09-12.1",
} as const;
export type TripEngineName = keyof typeof TRIP_ENGINE_VERSIONS;

export const TRIP_DECISION_TYPES = ["freedom_windows", "trip_health", "today_projection"] as const;
export type TripDecisionType = (typeof TRIP_DECISION_TYPES)[number];

export interface TripDecision {
  decisionId: string;
  tripId: string;
  type: TripDecisionType;
  /** Ids, versions and counts of what was read — never row bodies. */
  inputs: Record<string, unknown>;
  /** The tables read, by name. */
  sources: string[];
  assumptions: string[];
  constraints: string[];
  /** A summary of the conclusion — verdicts and counts, not the projection itself. */
  result: Record<string, unknown>;
  confidence: TravelConfidence | "N/A";
  engineVersions: Partial<Record<TripEngineName, string>>;
  calculatedAt: string;
  sourceTripVersion: number | null;
}

export const TRIP_DECISION_RING = 256;
const ring: TripDecision[] = [];
let seq = 0;

/** Test hook. */
export function _resetTripDecisionLedger(): void { ring.length = 0; seq = 0; }

export function recordTripDecision(d: Omit<TripDecision, "decisionId">): TripDecision {
  seq += 1;
  const decision: TripDecision = { ...d, decisionId: `${d.type}:${d.tripId}:${Date.parse(d.calculatedAt)}:${seq}` };
  ring.push(decision);
  if (ring.length > TRIP_DECISION_RING) ring.splice(0, ring.length - TRIP_DECISION_RING);
  return decision;
}

export function readTripDecision(decisionId: string): TripDecision | null {
  return ring.find((d) => d.decisionId === decisionId) ?? null;
}

export function listTripDecisions(tripId: string): TripDecision[] {
  return ring.filter((d) => d.tripId === tripId);
}

export interface TripDecisionExplanation {
  decisionId: string;
  type: TripDecisionType;
  calculatedAt: string;
  sourceTripVersion: number | null;
  /** Plain sentences a person or a model can read. */
  explanation: string[];
  engineVersions: Partial<Record<TripEngineName, string>>;
  /** The record itself, for a consumer that wants the structure. */
  decision: TripDecision;
  retention: string;
}

export const DECISION_RETENTION =
  `In-process ring of ${TRIP_DECISION_RING} decisions; not persisted. A decision from another process, or displaced from the ring, is reported as not retained rather than recomputed.`;

/** §12.1 explainTripDecision(decisionId): sentences from the stored record, or null when not retained. */
export function explainTripDecision(decisionId: string): TripDecisionExplanation | null {
  const d = readTripDecision(decisionId);
  if (!d) return null;
  const explanation: string[] = [
    `This ${d.type.replace(/_/g, " ")} was computed at ${d.calculatedAt} against trip version ${d.sourceTripVersion ?? "unknown"}.`,
    `It read: ${d.sources.join(", ")}.`,
    `Inputs: ${Object.entries(d.inputs).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("; ")}.`,
    ...d.assumptions.map((a) => `Assumed: ${a}`),
    ...d.constraints.map((c) => `Constrained by: ${c}`),
    `Result: ${Object.entries(d.result).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("; ")}.`,
    `Confidence: ${d.confidence}.`,
    `Engines: ${Object.entries(d.engineVersions).map(([k, v]) => `${k}@${v}`).join(", ")}.`,
  ];
  return { decisionId: d.decisionId, type: d.type, calculatedAt: d.calculatedAt, sourceTripVersion: d.sourceTripVersion, explanation, engineVersions: d.engineVersions, decision: d, retention: DECISION_RETENTION };
}
