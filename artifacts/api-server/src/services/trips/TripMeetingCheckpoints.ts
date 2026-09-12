/**
 * Trips spec §10.4 meeting checkpoints, §11.3 "Return / regroup", §14.3 the
 * meeting point as a chosen candidate with its explanation (2794).
 * census-trips TR177, TR198, TR262.
 *
 * WHAT A CHECKPOINT IS. A place the crew — or a subgroup — agreed to meet:
 * coordinates, a label, an optional meet-by, why (regroup | planned |
 * safety), the §14.3 explanation it was chosen with, a status (open | met |
 * cancelled) and, per expected participant, an arrival state. The kernel
 * writes it (CREATE_MEETING_CHECKPOINT / SET_MEETING_ARRIVAL /
 * CLOSE_MEETING_CHECKPOINT); this module reads it and composes the §11.3
 * regroup: compute the §14.3 meeting point, take the recommended candidate
 * (or the one the caller chose among the alternatives, or an explicit point),
 * and issue the command with the computation's explanation attached.
 *
 * WHAT SWITCHES PRIORITY. Nothing here writes a priority. An open regroup or
 * safety checkpoint with someone still expected is a REGROUP_OPEN health
 * reason (TripHealth.ts), which the §17.2 switch reads as SAFETY_EVENT —
 * location coordination — until the checkpoint is closed or everyone has
 * arrived. So the switch flips by derivation, and flips back the same way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { executeTripCommand, type TripKernelResult } from "../../lib/tripKernel.js";
import { computeMeetingPoint } from "./TripReplanService.js";
import type { MeetingOption } from "./TripMeetingPoint.js";

export const CHECKPOINT_PURPOSES = ["regroup", "planned", "safety"] as const;
export type CheckpointPurpose = (typeof CHECKPOINT_PURPOSES)[number];
export const CHECKPOINT_STATUSES = ["open", "met", "cancelled"] as const;
export const ARRIVAL_STATES = ["pending", "en_route", "arrived", "late", "no_show"] as const;
export type ArrivalState = (typeof ARRIVAL_STATES)[number];

export interface CheckpointParticipantView {
  userId: string;
  arrivalState: ArrivalState;
  arrivedAt: string | null;
}

export interface MeetingCheckpointView {
  id: string;
  tripId: string;
  subgroupId: string | null;
  createdBy: string;
  label: string;
  lat: number;
  lng: number;
  placeId: string | null;
  meetAt: string | null;
  purpose: CheckpointPurpose;
  status: (typeof CHECKPOINT_STATUSES)[number];
  explanation: unknown;
  createdAt: string;
  closedAt: string | null;
  participants: CheckpointParticipantView[];
  /** Expected and not yet arrived (pending, en_route, late). */
  pendingCount: number;
  arrivedCount: number;
}

export type ListCheckpointsResult =
  | { ok: true; checkpoints: MeetingCheckpointView[] }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE"; message: string };

const PENDING = new Set<string>(["pending", "en_route", "late"]);

/** Crew-scoped read; a subgroup checkpoint is listed for the whole crew (it is a place, not a position). */
export async function listMeetingCheckpoints(sc: SupabaseClient, tripId: string, opts: { status?: "open" | "all" } = {}): Promise<ListCheckpointsResult> {
  let q = sc.from("trip_meeting_checkpoints")
    .select("id, trip_id, subgroup_id, created_by, label, lat, lng, place_id, meet_at, purpose, status, explanation, created_at, closed_at")
    .eq("trip_id", tripId);
  if ((opts.status ?? "open") === "open") q = q.eq("status", "open");
  const { data: rows, error } = await q;
  if (error) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `trip_meeting_checkpoints could not be read: ${error.message}` };
  const list = (rows ?? []) as any[];
  const byId = new Map<string, CheckpointParticipantView[]>();
  if (list.length > 0) {
    const { data: parts, error: pErr } = await sc.from("trip_meeting_checkpoint_participants")
      .select("checkpoint_id, user_id, arrival_state, arrived_at")
      .in("checkpoint_id", list.map((r) => String(r.id)));
    if (pErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `trip_meeting_checkpoint_participants could not be read: ${pErr.message}` };
    for (const p of ((parts ?? []) as any[])) {
      const arr = byId.get(String(p.checkpoint_id)) ?? [];
      arr.push({ userId: String(p.user_id), arrivalState: String(p.arrival_state) as ArrivalState, arrivedAt: p.arrived_at ?? null });
      byId.set(String(p.checkpoint_id), arr);
    }
  }
  const checkpoints = list.map((r) => {
    const participants = (byId.get(String(r.id)) ?? []).sort((a, b) => a.userId.localeCompare(b.userId));
    return {
      id: String(r.id), tripId: String(r.trip_id), subgroupId: r.subgroup_id ?? null, createdBy: String(r.created_by),
      label: String(r.label ?? ""), lat: Number(r.lat), lng: Number(r.lng), placeId: r.place_id ?? null, meetAt: r.meet_at ?? null,
      purpose: (r.purpose ?? "regroup") as CheckpointPurpose, status: (r.status ?? "open") as MeetingCheckpointView["status"],
      explanation: r.explanation ?? null, createdAt: String(r.created_at ?? ""), closedAt: r.closed_at ?? null,
      participants,
      pendingCount: participants.filter((p) => PENDING.has(p.arrivalState)).length,
      arrivedCount: participants.filter((p) => p.arrivalState === "arrived").length,
    } satisfies MeetingCheckpointView;
  });
  checkpoints.sort((a, b) => (a.meetAt ?? "9999").localeCompare(b.meetAt ?? "9999") || a.createdAt.localeCompare(b.createdAt));
  return { ok: true, checkpoints };
}

export interface RegroupInput {
  participantIds?: string[];
  subgroupId?: string | null;
  /** Pick this candidate among the §14.3 recommended/alternatives instead of the recommended one. */
  candidateId?: string | null;
  /** An explicit point the crew already agreed on; §14.3 is still computed and attached as the explanation. */
  point?: { lat: number; lng: number; label: string } | null;
  label?: string | null;
  meetAt?: string | null;
  purpose?: CheckpointPurpose;
  idempotencyKey?: string | null;
  now?: Date;
}

export type RegroupResult =
  | {
      ok: true;
      checkpoint: Record<string, unknown>;
      kernel: { version: number; eventId: string; duplicate: boolean };
      meetingPoint: { chosen: MeetingOption | null; recommended: MeetingOption | null; alternatives: MeetingOption[]; unplaced: { userId: string; reason: string }[]; explanation: string[]; constraintsApplied: string[] };
      /** What the regroup does to §17.2's switch, by derivation. */
      prioritySwitch: string;
    }
  | { ok: false; reason: string; message: string; meetingPoint?: { recommended: null; alternatives: MeetingOption[]; unplaced: { userId: string; reason: string }[]; explanation: string[] }; kernel?: TripKernelResult };

export const REGROUP_PRIORITY_READING =
  "while this checkpoint is open with someone still expected, trip health carries REGROUP_OPEN and the §17.2 switch is SAFETY_EVENT (location coordination); it returns to NORMAL when everyone has arrived or the checkpoint is closed";

/** §11.3 "Return / regroup → creates route/meeting operation and switches context priority." */
export async function regroup(sc: SupabaseClient, tripId: string, actorUserId: string, input: RegroupInput): Promise<RegroupResult> {
  const now = input.now ?? new Date();
  const mp = await computeMeetingPoint(sc as any, tripId, actorUserId, { participantIds: input.participantIds, now });
  if (!mp.ok) return { ok: false, reason: mp.reason, message: mp.message };
  const { result } = mp;
  const options = [...(result.recommended ? [result.recommended] : []), ...result.alternatives];
  let chosen: MeetingOption | null = null;
  let point: { lat: number; lng: number; label: string; placeId: string | null } | null = null;
  if (input.point) {
    point = { lat: input.point.lat, lng: input.point.lng, label: input.label ?? input.point.label, placeId: null };
    chosen = options.find((o) => o.candidateId === input.candidateId) ?? null;
  } else {
    chosen = input.candidateId ? options.find((o) => o.candidateId === input.candidateId) ?? null : result.recommended;
    if (!chosen) {
      return {
        ok: false, reason: "TRIP_MEETING_NO_CANDIDATE",
        message: input.candidateId
          ? `candidate ${input.candidateId} is not among the recommended or alternative meeting points`
          : "§14.3 recommended no meeting point the crew could meet at; pass a point the crew agreed on, or a candidateId from the alternatives",
        meetingPoint: { recommended: null, alternatives: result.alternatives, unplaced: result.unplaced, explanation: result.explanation },
      };
    }
    const cand = mp.candidates.find((c) => c.id === chosen!.candidateId);
    if (!cand) return { ok: false, reason: "TRIP_MEETING_NO_CANDIDATE", message: `candidate ${chosen.candidateId} has no point` };
    point = { lat: cand.point.lat, lng: cand.point.lng, label: input.label ?? cand.name, placeId: cand.id.startsWith("place:") ? cand.id.slice(6) : null };
  }
  const explanation = {
    computedAt: now.toISOString(),
    chosenCandidateId: chosen?.candidateId ?? null,
    chosenBy: input.point ? "explicit_point" : input.candidateId ? "caller_picked_alternative" : "recommended",
    recommended: result.recommended ? summarize(result.recommended) : null,
    alternatives: result.alternatives.map(summarize),
    refused: result.refused.map((o) => ({ candidateId: o.candidateId, refusals: o.refusals })),
    unplaced: result.unplaced,
    constraintsApplied: result.constraintsApplied,
    explanation: result.explanation,
    candidatesConsidered: mp.candidatesConsidered,
  };
  const kernel = await executeTripCommand(sc, {
    commandId: randomUUID(),
    tripId,
    actorUserId,
    actorRole: "user",
    idempotencyKey: input.idempotencyKey ?? `regroup:${randomUUID()}`,
    type: "CREATE_MEETING_CHECKPOINT",
    payload: {
      label: point.label, lat: point.lat, lng: point.lng, place_id: point.placeId,
      meet_at: input.meetAt ?? null, purpose: input.purpose ?? "regroup", subgroup_id: input.subgroupId ?? null,
      participant_ids: input.participantIds ?? [],
      explanation,
    },
    correlationId: `regroup:${tripId}`,
  });
  if (!kernel.ok) return { ok: false, reason: kernel.reason, message: kernel.detail ?? kernel.reason, kernel };
  return {
    ok: true,
    checkpoint: (kernel.result ?? {}) as Record<string, unknown>,
    kernel: { version: kernel.version, eventId: kernel.eventId, duplicate: kernel.duplicate },
    meetingPoint: { chosen, recommended: result.recommended, alternatives: result.alternatives, unplaced: result.unplaced, explanation: result.explanation, constraintsApplied: result.constraintsApplied },
    prioritySwitch: REGROUP_PRIORITY_READING,
  };
}

function summarize(o: MeetingOption) {
  return { candidateId: o.candidateId, name: o.name, primitive: o.primitive, groupBurdenMinutes: o.groupBurdenMinutes, longestJourneyMinutes: o.longestJourneyMinutes, journeys: o.journeys, explanation: o.explanation };
}
