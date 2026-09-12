/**
 * The trip as the impact preview, the replan and the meeting point see it —
 * one loader, under the operational-projections gate that owns 2782's
 * transport segments and 2761's commitments. Everything the pure engines
 * (TripImpactPreview, TripReplan, TripMeetingPoint) take is read here, once,
 * and nothing is written.
 */
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { operationalState, type SafetySessionRow } from "./TripSafetyProjection.js";
import type { ImpactState, StatePlan, StateReservation, StateTransport, StateCommitment } from "./TripImpactPreview.js";

export type ImpactStateResult =
  | { ok: true; state: ImpactState; sourceTripVersion: number | null; unread: string[] }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED"; message: string };

export async function loadImpactState(sc: any, tripId: string, opts: { now?: Date } = {}): Promise<ImpactStateResult> {
  const now = opts.now ?? new Date();
  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate) as ImpactStateResult;
  const { data: trip, error: tErr } = await sc.from("trips").select("id, version, owner_id").eq("id", tripId).maybeSingle();
  if (tErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const unread: string[] = [];
  const read = async (table: string, q: any): Promise<any[]> => {
    const { data, error } = await q;
    if (error) { unread.push(table); return []; }
    return (data ?? []) as any[];
  };
  const members = await read("trip_members", sc.from("trip_members").select("user_id, status").eq("trip_id", tripId));
  const crewIds = [...new Set([String((trip as any).owner_id ?? ""), ...members.filter((m) => m.status == null || m.status === "accepted").map((m) => String(m.user_id))])].filter(Boolean);
  const planRows = await read("trip_plan_items", sc.from("trip_plan_items").select("id, title, status, starts_at, ends_at, day_date, plan_scope, lat, lng, location_is_private, place_id, location_name").eq("trip_id", tripId).is("removed_at", null));
  const attendance = await read("trip_plan_participants", sc.from("trip_plan_participants").select("plan_id, user_id, attendance_state").in("plan_id", planRows.map((p) => String(p.id))));
  const going = new Map<string, string[]>();
  for (const a of attendance) {
    if (["going", "GOING", "maybe", "MAYBE", "interested", "INTERESTED"].includes(String(a.attendance_state))) {
      const l = going.get(String(a.plan_id)) ?? []; l.push(String(a.user_id)); going.set(String(a.plan_id), l);
    }
  }
  const plans: StatePlan[] = planRows.map((p) => ({
    id: String(p.id), title: p.title ?? null, status: p.status ?? null, startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, dayDate: p.day_date ?? null,
    participantIds: going.get(String(p.id)) ?? (String(p.plan_scope ?? "ALL_CREW").toUpperCase() === "SOLO" ? [] : crewIds),
    planScope: p.plan_scope ?? null, confirmed: p.status === "confirmed" || p.status === "in_progress",
  }));
  const reservationRows = await read("trip_reservations", sc.from("trip_reservations").select("id, title, type, status, starts_at, ends_at, cancellation_deadline_at, user_id").eq("trip_id", tripId));
  const reservations: StateReservation[] = reservationRows.map((r) => ({
    id: String(r.id), title: r.title ?? null, type: r.type ?? null, status: r.status ?? null, startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null,
    cancellationDeadlineAt: r.cancellation_deadline_at ?? null,
    // trip_reservations carries no price: the cost is unknown, not zero (§15.3)
    costMinor: null, currency: null, planId: null, participantIds: r.user_id ? [String(r.user_id)] : crewIds,
  }));
  const transportRows = await read("trip_transport_segments", sc.from("trip_transport_segments").select("id, mode, state, planned_departure_at, planned_arrival_at, party_size, cost_minor, currency").eq("trip_id", tripId));
  const transport: StateTransport[] = transportRows.map((t) => ({
    id: String(t.id), mode: String(t.mode ?? ""), state: String(t.state ?? ""), plannedDepartureAt: t.planned_departure_at ?? null, plannedArrivalAt: t.planned_arrival_at ?? null,
    servesId: null, partySize: typeof t.party_size === "number" ? t.party_size : null, costMinor: typeof t.cost_minor === "number" ? t.cost_minor : null, currency: t.currency ?? null,
  }));
  const commitmentRows = await read("trip_commitments", sc.from("trip_commitments").select("id, type, starts_at, required_arrival_at, flexibility").eq("trip_id", tripId));
  const commitments: StateCommitment[] = commitmentRows.map((c) => ({ id: String(c.id), type: String(c.type ?? ""), startsAt: c.starts_at ?? null, requiredArrivalAt: c.required_arrival_at ?? null, flexibility: c.flexibility ?? null, participantIds: crewIds }));
  const sessions = await read("safe_return_sessions", sc.from("safe_return_sessions").select("id, user_id, trip_id, status, escalation_level, timer_start_at, timer_end_at, notify_trip_crew_enabled, closed_at, updated_at").eq("trip_id", tripId).in("status", ["active", "missed"]));
  const safeReturnActiveFor = (sessions as SafetySessionRow[]).filter((s) => { const st = operationalState(s, now.getTime()); return st === "RETURNING" || st === "NEEDS_HELP"; }).map((s) => String(s.user_id));
  return {
    ok: true, unread, sourceTripVersion: typeof (trip as any).version === "number" ? (trip as any).version : null,
    state: { plans, reservations, transport, commitments, safeReturnActiveFor, crewIds },
  };
}
