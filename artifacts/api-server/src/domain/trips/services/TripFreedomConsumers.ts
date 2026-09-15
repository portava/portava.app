/**
 * Trips §7.3 — "Discovery, Compass, Saved Ideas, and Buddy matching consume
 * these windows rather than independently calculating 'free time.'"
 * census-trips TR133.
 *
 * Compass consumes the windows through get_freedom_windows and Saved Ideas
 * through the opportunity projection (§59). This module is the consumption
 * for the other two: a SLOT (a Buddy booking's date, start and duration) or
 * an INSTANT (an event's start) is judged against the windows the Temporal
 * Freedom Engine produced — never against a second idea of "free" computed
 * here. There is no arithmetic about commitments in this file; there are
 * only windows, and where the slot falls relative to them.
 *
 * WHAT A VERDICT MEANS
 * ====================
 *   FITS           the slot lies inside one window — free time the engine
 *                  vouches for (to the engine's own confidence; a window is
 *                  a LOWER BOUND, see FREEDOM_READING)
 *   CONFLICT       the slot lies at least partly where no window is, between
 *                  the first window's start and the last window's end: it
 *                  runs into a commitment or the travel + prep reserved
 *                  before one. The commitments involved are named.
 *   OUTSIDE_TRIP   the slot lies before every window or after every window:
 *                  the engine has no claim about that time
 *   UNPLACED       the slot could not be placed at all (no start time, no
 *                  windows because nothing on the trip is placed, or an
 *                  unparseable time) — NOT a conflict, and NOT a fit
 *   NOT_CONSULTED  the windows could not be read (gate closed, not a member,
 *                  projection refused). The caller proceeds and says so.
 *
 * Only CONFLICT is a refusal. Every other verdict lets the caller continue,
 * because "the engine cannot say" must not become "the engine says no".
 */
import { buildTripFreedomProjection, type TripFreedomProjection } from "../projections/TripFreedomProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../contracts/TripProjectionEnvelope.js";
import { wallTimeToUtc, isValidTimezone } from "../../../services/airport/AirportTime.js";
import { isAcceptedTripMember } from "../../../lib/http.js";

export const SLOT_FIT_VERDICTS = ["FITS", "CONFLICT", "OUTSIDE_TRIP", "UNPLACED", "NOT_CONSULTED"] as const;
export type SlotFitVerdict = (typeof SLOT_FIT_VERDICTS)[number];

export interface SlotFit {
  verdict: SlotFitVerdict;
  consulted: boolean;
  tripId: string | null;
  /** The window the slot lies within, when FITS. */
  windowId: string | null;
  /** The commitments the slot collides with (or whose reserved travel/prep it eats), when CONFLICT. */
  conflictingCommitmentIds: string[];
  reason: "TRIP_TEMPORAL_CONFLICT" | null;
  /** The slot as judged (UTC ISO), when it could be placed. */
  slot: { beginsAt: string; endsAt: string } | null;
  /** The freedom decision the verdict was read from, for §21.2 explain. */
  decisionId: string | null;
  info: string;
}

const notConsulted = (tripId: string | null, info: string): SlotFit =>
  ({ verdict: "NOT_CONSULTED", consulted: false, tripId, windowId: null, conflictingCommitmentIds: [], reason: null, slot: null, decisionId: null, info });

const unplaced = (p: Pick<TripFreedomProjection, "tripId" | "decisionId">, info: string): SlotFit =>
  ({ verdict: "UNPLACED", consulted: true, tripId: p.tripId, windowId: null, conflictingCommitmentIds: [], reason: null, slot: null, decisionId: p.decisionId, info });

/** Judge a slot against the windows. Pure. A zero-length slot judges an instant. */
export function fitSlotToWindows(
  p: Pick<TripFreedomProjection, "tripId" | "decisionId" | "windows">,
  slot: { beginsAt: Date; endsAt: Date },
): SlotFit {
  const b = slot.beginsAt.getTime();
  const e = slot.endsAt.getTime();
  if (!Number.isFinite(b) || !Number.isFinite(e) || e < b) return unplaced(p, "the slot has no usable begin and end");
  const iso = { beginsAt: slot.beginsAt.toISOString(), endsAt: slot.endsAt.toISOString() };
  const windows = [...p.windows]
    .map((w) => ({ w, b: Date.parse(w.beginsAt), e: Date.parse(w.endsAt) }))
    .filter((x) => Number.isFinite(x.b) && Number.isFinite(x.e))
    .sort((x, y) => x.b - y.b);
  if (windows.length === 0) return unplaced(p, "the engine produced no windows for this trip (nothing on it is placed in time), so there is nothing to fit against");

  const inside = windows.find((x) => x.b <= b && e <= x.e);
  if (inside) {
    return {
      verdict: "FITS", consulted: true, tripId: p.tripId, windowId: inside.w.id, conflictingCommitmentIds: [], reason: null,
      slot: iso, decisionId: p.decisionId,
      info: `the slot lies inside window ${inside.w.id} (${inside.w.position}, ${inside.w.confidence} confidence${inside.w.certified ? ", certified" : ", not certified"})`,
    };
  }
  const first = windows[0]!; const last = windows[windows.length - 1]!;
  if (e <= first.b || b >= last.e) {
    return {
      verdict: "OUTSIDE_TRIP", consulted: true, tripId: p.tripId, windowId: null, conflictingCommitmentIds: [], reason: null,
      slot: iso, decisionId: p.decisionId,
      info: e <= first.b ? "the slot ends before the trip's first window begins" : "the slot begins after the trip's last window ends",
    };
  }
  // Partly or wholly where no window is: name the commitments on either side
  // of the gap it falls into. A window's afterCommitmentId is the commitment
  // that ENDS the previous gap; its beforeCommitmentId is the one that ENDS it.
  const ids = new Set<string>();
  for (const x of windows) {
    const overlaps = x.b < e && b < x.e;
    if (overlaps) {
      if (b < x.b && x.w.afterCommitmentId) ids.add(x.w.afterCommitmentId);
      if (e > x.e && x.w.beforeCommitmentId) ids.add(x.w.beforeCommitmentId);
    }
  }
  if (ids.size === 0) {
    // Entirely inside a gap between two windows: the commitment block itself.
    const prev = [...windows].reverse().find((x) => x.e <= b);
    const next = windows.find((x) => x.b >= e);
    if (prev?.w.beforeCommitmentId) ids.add(prev.w.beforeCommitmentId);
    if (next?.w.afterCommitmentId) ids.add(next.w.afterCommitmentId);
  }
  const named = [...ids];
  return {
    verdict: "CONFLICT", consulted: true, tripId: p.tripId, windowId: null, conflictingCommitmentIds: named,
    reason: "TRIP_TEMPORAL_CONFLICT", slot: iso, decisionId: p.decisionId,
    info: named.length > 0
      ? `the slot runs into commitment${named.length === 1 ? "" : "s"} ${named.join(", ")} or the travel and preparation reserved before ${named.length === 1 ? "it" : "them"}`
      : "the slot falls where the engine reserves time for a commitment",
  };
}

export type TripWindowsRead =
  | { ok: true; projection: TripFreedomProjection }
  | { ok: false; info: string };

/** Read a trip's windows for a viewer, through the gate and the §19.1 rule. Never throws. */
export async function readTripWindows(sc: any, tripId: string, viewerId: string, opts: { now?: Date } = {}): Promise<TripWindowsRead> {
  let member: boolean;
  try {
    member = await isAcceptedTripMember(sc, tripId, viewerId);
  } catch (e) {
    return { ok: false, info: `membership could not be checked: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!member) return { ok: false, info: "The user is not a member of that trip." };
  let built: Awaited<ReturnType<typeof buildTripFreedomProjection>>;
  try {
    built = await buildTripFreedomProjection(sc, tripId, opts);
  } catch (e) {
    return { ok: false, info: `the freedom projection threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!built.ok) {
    return { ok: false, info: built.reason === "FEATURE_DISABLED"
      ? `Freedom windows are not enabled: ${built.message}`
      : `Freedom windows unavailable (${built.reason}): ${built.message}` };
  }
  const decision = acceptTripProjection(built.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, metric: "TripFreedomProjection" });
  if (!decision.accepted) return { ok: false, info: `Freedom windows rejected (${decision.reason}): ${decision.message}` };
  return { ok: true, projection: built.projection };
}

/** An instant (an event's start) against the windows. */
export function fitInstantToWindows(p: Pick<TripFreedomProjection, "tripId" | "decisionId" | "windows">, at: string | null): SlotFit {
  const t = at ? new Date(at) : null;
  if (!t || !Number.isFinite(t.getTime())) return unplaced(p, "no start instant to place");
  return fitSlotToWindows(p, { beginsAt: t, endsAt: t });
}

export interface SlotQuery {
  tripId: string;
  viewerId: string;
  /** YYYY-MM-DD, in the trip's local zone. */
  date: string;
  /** HH:MM (seconds tolerated), local; null when the caller has only a day. */
  startTime: string | null;
  durationHours: number;
}

/**
 * A booking-shaped slot against a trip's windows. The trip's own timezone
 * turns the wall time into an instant; a trip without one is judged in UTC
 * and the info says so.
 */
export async function readSlotFit(sc: any, q: SlotQuery, opts: { now?: Date } = {}): Promise<SlotFit> {
  const read = await readTripWindows(sc, q.tripId, q.viewerId, opts);
  if (!read.ok) return notConsulted(q.tripId, read.info);
  const p = read.projection;
  if (!q.startTime) return unplaced(p, "the booking has no start time; a whole day cannot be fitted to a window");
  if (!Number.isFinite(q.durationHours) || q.durationHours <= 0) return unplaced(p, "the booking has no usable duration");
  let tz = "UTC"; let tzAssumed = true;
  try {
    const { data } = await sc.from("trips").select("timezone").eq("id", q.tripId).maybeSingle();
    const declared = (data as any)?.timezone;
    if (typeof declared === "string" && isValidTimezone(declared)) { tz = declared; tzAssumed = false; }
  } catch { /* judged in UTC, said below */ }
  const hhmm = /^(\d{2}):(\d{2})/.exec(String(q.startTime).trim());
  const begins = hhmm ? wallTimeToUtc(tz, `${q.date}T${hhmm[1]}:${hhmm[2]}`) : null;
  if (!begins) return unplaced(p, `the booking's date and start time could not be read as a wall time (${q.date} ${q.startTime})`);
  const ends = new Date(begins.getTime() + q.durationHours * 3_600_000);
  const fit = fitSlotToWindows(p, { beginsAt: begins, endsAt: ends });
  return tzAssumed ? { ...fit, info: `${fit.info}; the trip declared no timezone, so the slot was judged in UTC` } : fit;
}
