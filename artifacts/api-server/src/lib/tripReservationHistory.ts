/**
 * §15.4 / §18.3 reservation history — the gate the reservation routes consult
 * before touching 2784's schema.
 *
 * trip_reservations is a PRODUCTION table (0172). 2784 adds `version`,
 * `cancelled_at`, the 'cancelled' status and trip_reservation_events; a route
 * that read or wrote those on a database without 2784 would 42703 on every
 * request. So the append-only behaviour — cancel instead of delete, If-Match
 * against the row version, compensation as an event — runs only where the
 * 2760–2785 batch is present under trip_operational_projections_enabled, and
 * the legacy behaviour (hard delete, last-write-wins) stays byte-for-byte
 * otherwise. The requirement rows live on TRIP_OPERATIONAL_PROJECTIONS (one
 * gate for the batch; the registry is keyed by flag), and this module is the
 * name the routes reach it by.
 */
import { tripOperationalProjectionsGate } from "./tripOperationalProjections.js";

export type ReservationHistoryGate = { enabled: true } | { enabled: false; reason: "flag_off" | "schema_missing" | "schema_unknown" };

export async function reservationHistoryGate(sc: any): Promise<ReservationHistoryGate> {
  const gate = await tripOperationalProjectionsGate(sc);
  return gate.enabled ? { enabled: true } : { enabled: false, reason: gate.reason };
}
