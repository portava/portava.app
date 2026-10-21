/** §9 executable contracts. No I/O, routing, category durations or second safety engine. */
import { z } from "zod";
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import type { SafetyAssessment } from "./LayoverSafetyEngine.js";
import type { RoutedCardContract } from "./LayoverRoutedFeasibility.js";
import { calculateCommitmentEnvelope } from "./LayoverTemporalFreedom.js";
import { snapshotIdFor } from "./layoverLedger.js";
import { certifiedPlanningInstant } from "../layover/layoverCanonicalValidity.js";

const instant = z.string().datetime();
const minutes = z.number().finite().nonnegative();
const route = z.object({ mode: z.string(), departAt: instant, minutes, conservativeMinutes: minutes, forecast: z.boolean(), transferCount: z.number().int().nonnegative() });
export const recommendationContractSchema = z.object({
  contractVersion: z.literal("2026.10.19-1"),
  snapshotId: z.string().nullable(), candidateIds: z.array(z.string()).min(1),
  state: z.enum(["READY", "UNAVAILABLE"]), insideAirport: z.boolean(),
  departBy: instant.nullable(), estimatedArrival: instant.nullable(),
  minExperienceMinutes: minutes.nullable(), idealExperienceMinutes: minutes.nullable(),
  leaveActivityBy: instant.nullable(), expectedAirportReturn: instant.nullable(), hardReturnBy: instant,
  returnBufferMinutes: minutes, riskBand: z.enum(["LOW", "MODERATE", "HIGH", "UNSAFE"]),
  confidence: z.string(), expiresAt: instant.nullable(),
  fallbackPlan: z.object({ beforeDeparture: z.literal("stay_airside"), duringExperience: z.enum(["remain_airside", "return_to_airport"]), returnBy: instant, returnRoute: route.nullable() }),
  abortThreshold: z.object({ leaveBy: instant.nullable(), returnDeadline: instant, conditions: z.array(z.enum(["snapshot_changed", "route_expired", "return_deadline_at_risk", "entry_closed", "live_access_refused"])) }),
  failureModes: z.array(z.enum(["snapshot_unavailable", "snapshot_mismatch", "duration_unstated", "return_route_unmeasured", "route_expired", "insufficient_time", "safety_gate_closed", "live_access_refused"])),
  reasonCodes: z.array(z.string()),
  itinerary: z.array(z.object({ kind: z.enum(["outbound", "experience", "return"]), startsAt: instant, endsAt: instant, mode: z.string().nullable(), candidateId: z.string().optional() })),
  /** SHA-256 of the ordered compile inputs (keys, positions, dwell, activity commitment). Written by compile(); a plan without it predates the binding. */
  routeInputHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type LayoverRecommendationContract = z.infer<typeof recommendationContractSchema>;
export interface ContractInput {
  sessionId: string; snapshotId: string | null; key: string; insideAirport: boolean;
  record: LayoverFeasibilityRecord; assessment: SafetyAssessment;
  riskBand: LayoverRecommendationContract["riskBand"];
  routing?: RoutedCardContract | null;
  liveBlocked?: boolean;
}
const iso = (ms: number): string => new Date(ms).toISOString();
const positive = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** The protected airport band is the same commitment envelope used by TemporalFreedomService. */
export function recommendationCommitment(record: LayoverFeasibilityRecord) {
  return calculateCommitmentEnvelope({
    arrivalMs: Date.parse(record.inputs.session.arrivalTime), departureMs: Date.parse(record.inputs.session.departureTime),
    cutoffMs: record.deadline.cutoffMs, exitDelayMin: record.envelope.exitDelayMin,
    returnBufferMin: record.deadline.breakdown.totalBuffer, airportPoint: null, airportPlaceId: record.inputs.airport.id,
    confidence: record.confidence,
  });
}

/** Certify only the supplied engine assessment and routed return terms; missing terms stay null. */
export function compileRecommendationContract(input: ContractInput): LayoverRecommendationContract {
  const { record, assessment, routing, insideAirport } = input;
  const commitment = recommendationCommitment(record);
  const hard = insideAirport ? record.deadline.cutoffMs : Date.parse(commitment.mustLeaveBy);
  const nowMs = certifiedPlanningInstant(record);
  const start = insideAirport ? Math.max(nowMs, Date.parse(record.inputs.session.arrivalTime)) : Math.max(nowMs, record.envelope.earliestOutTime.getTime());
  const dwell = positive(assessment.statedActivityMin);
  const failures: LayoverRecommendationContract["failureModes"] = [];
  if (input.snapshotId === null) failures.push("snapshot_unavailable");
  else if (record.inputs.session.id !== input.sessionId || input.snapshotId !== snapshotIdFor(input.sessionId, record.inputHash)) failures.push("snapshot_mismatch");
  if (dwell === null) failures.push("duration_unstated");
  if (input.riskBand === "UNSAFE") failures.push("safety_gate_closed");
  if (input.liveBlocked) failures.push("live_access_refused");
  const routed = !insideAirport && routing?.state === "FEASIBLE" && routing.returnContract !== null && routing.conservativeReturnMinutes !== null && routing.outboundMinutes !== null && routing.returnContract.route.forecast;
  if (!insideAirport && !routed) failures.push("return_route_unmeasured");
  const expiry = routing?.expiresAt ? Math.min(Date.parse(routing.expiresAt),record.inputs.airport.timingEvidence?Date.parse(record.inputs.airport.timingEvidence.expiresAt):Infinity) : null;
  if (!insideAirport && (expiry === null || !Number.isFinite(expiry) || expiry <= nowMs)) failures.push("route_expired");
  const outbound = insideAirport ? 0 : routed ? routing.outboundMinutes : null;
  const back = insideAirport ? 0 : routed ? routing.conservativeReturnMinutes : null;
  const arrival = outbound === null ? null : start + outbound * 60_000;
  const finish = arrival === null || dwell === null ? null : arrival + dwell * 60_000;
  const expected = finish === null || back === null ? null : finish + back * 60_000;
  const leaveBy = back === null ? null : hard - back * 60_000;
  const departBy = outbound === null || dwell === null || leaveBy === null ? null : Math.min(leaveBy - (outbound + dwell) * 60_000, routing?.journeyTiming ? Date.parse(routing.journeyTiming.departBy) : Infinity);
  if (expected !== null && expected > hard || departBy !== null && start > departBy) failures.push("insufficient_time");
  // A returned route must describe this plan's actual return instant, not an earlier independent visit.
  if (routed && finish !== null && Date.parse(routing.returnContract!.route.departAt) !== finish) failures.push("return_route_unmeasured");
  const ready = failures.length === 0;
  const returnRoute = routed ? { mode: routing.returnContract!.route.mode, departAt: routing.returnContract!.route.departAt, minutes: routing.returnContract!.route.minutes, conservativeMinutes: routing.returnContract!.route.conservativeMinutes, forecast: true, transferCount: routing.returnContract!.route.transferCount } : null;
  const itinerary: LayoverRecommendationContract["itinerary"] = [];
  if (arrival !== null && finish !== null && expected !== null) {
    if (!insideAirport) itinerary.push({ kind: "outbound", startsAt: iso(start), endsAt: iso(arrival), mode: routing?.mode ?? null });
    itinerary.push({ kind: "experience", startsAt: iso(arrival), endsAt: iso(finish), mode: null });
    if (!insideAirport) itinerary.push({ kind: "return", startsAt: iso(finish), endsAt: iso(expected), mode: routing?.mode ?? null });
  }
  return {
    contractVersion: "2026.10.19-1", snapshotId: input.snapshotId, candidateIds: [input.key], state: ready ? "READY" : "UNAVAILABLE", insideAirport,
    departBy: departBy === null ? null : iso(departBy), estimatedArrival: arrival === null ? null : iso(arrival),
    minExperienceMinutes: dwell, idealExperienceMinutes: dwell, // the chosen visit duration, never a typical category duration
    leaveActivityBy: leaveBy === null ? null : iso(leaveBy), expectedAirportReturn: expected === null ? null : iso(expected),
    hardReturnBy: iso(hard), returnBufferMinutes: insideAirport ? 0 : record.deadline.breakdown.totalBuffer,
    riskBand: ready ? input.riskBand : "UNSAFE", confidence: record.confidence,
    expiresAt: departBy === null ? null : iso(Math.min(departBy, expiry !== null && Number.isFinite(expiry) ? expiry : Infinity)),
    fallbackPlan: { beforeDeparture: "stay_airside", duringExperience: insideAirport ? "remain_airside" : "return_to_airport", returnBy: iso(hard), returnRoute },
    abortThreshold: { leaveBy: leaveBy === null ? null : iso(leaveBy), returnDeadline: iso(hard), conditions: ["snapshot_changed", "route_expired", "return_deadline_at_risk", "entry_closed", "live_access_refused"] },
    failureModes: [...new Set(failures)], reasonCodes: [...new Set([...record.reasonCodes, ...(routing?.reasonCodes ?? []), ...failures])], itinerary,
  };
}

/** Explicit field whitelist: private extension fields in persisted JSON never cross the API boundary. */
export function servedRecommendationContract(value: unknown): LayoverRecommendationContract | null {
  const parsed = recommendationContractSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
