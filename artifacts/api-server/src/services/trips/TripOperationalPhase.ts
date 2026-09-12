/**
 * Trips spec §3.2 — the active operational phase, derived, PURE.
 *
 * §3.2 names eight phases and, for each, the primary UI / behaviour:
 *
 *   ARRIVAL_DAY    arrival logistics, accommodation, crew arrivals, basics
 *   FREE_TIME      Temporal Freedom windows, Saved Ideas, nearby, social
 *   ACTIVE_PLAN    current activity, participants, next constraint, leave-by
 *   TRANSIT        route, destination, ETA, group progress, transport state
 *   NIGHTLIFE      live vibe, crowd movement, queue/entry, crew state, safe return
 *   REST           suppress low-value interruptions; no recommendation churn
 *   DEPARTURE_DAY  checkout, baggage, airport timing, remaining opportunities
 *   DISRUPTED      recovery-first; entertainment/commercial deprioritised
 *
 * WHAT EXISTED
 * ============
 * census-trips TR38-TR45: "There is no phase concept at all: no column, no
 * enum, no derivation, no UI switch." §3.1's rule is that lifecycle "is
 * computed from canonical facts plus explicit user actions" — so this is a
 * DERIVATION over facts the system already holds (trip dates and timezone,
 * the plan, the §7.3 windows, Safe Return, the risk register), not a column.
 * Storing a phase would be the boolean soup §3.1 forbids, one level up.
 *
 * THE ORDER IS THE RULE
 * =====================
 * The first clause that holds names the phase. Disruption first, because
 * everything else is a way of spending time and a disrupted trip is not
 * spending time; then the trip's edges (arrival / departure day), because the
 * day's logistics own those days whatever else is on them; then what the
 * traveller is DOING now (in transit to a commitment, in an activity); then
 * the clock (night, rest); then free time, which is the default state of a
 * traveller with nothing bounding the present moment. Every answer carries
 * the clause that produced it, so a consumer can disagree with a reason
 * rather than a word.
 *
 * Outside the trip's dates there is no operational phase — a trip that has
 * not started is not in FREE_TIME — and the answer says so with `phase: null`.
 *
 * `primaryFocus` is §3.2's second column, verbatim, so the UI switch §3.2
 * describes is data a client can render rather than a rule it must know.
 */
import type { FreedomWindow } from "./TripFreedomEngine.js";

export const OPERATIONAL_PHASES = [
  "ARRIVAL_DAY", "FREE_TIME", "ACTIVE_PLAN", "TRANSIT", "NIGHTLIFE", "REST", "DEPARTURE_DAY", "DISRUPTED",
] as const;
export type OperationalPhase = (typeof OPERATIONAL_PHASES)[number];

/** §3.2's "Primary UI / behavior" column. */
export const PRIMARY_FOCUS: Record<OperationalPhase, string> = {
  ARRIVAL_DAY: "Arrival logistics, accommodation, crew arrivals, payments/connectivity basics.",
  FREE_TIME: "Temporal Freedom windows, Saved Ideas, nearby opportunities, social availability.",
  ACTIVE_PLAN: "Current activity, participants, next constraint, leave-by time if relevant.",
  TRANSIT: "Route, destination, ETA, group progress, transport state.",
  NIGHTLIFE: "Live vibe, crowd movement, queue/entry constraints, crew state, safe return.",
  REST: "Suppress low-value interruptions and avoid aggressive recommendation churn.",
  DEPARTURE_DAY: "Checkout, baggage, airport timing, remaining viable opportunities.",
  DISRUPTED: "Recovery-first UX. Entertainment/commercial surfaces are deprioritized.",
};

/** Categories that make a late hour NIGHTLIFE rather than REST. `trip_plan_items.category` values (0010). */
export const NIGHTLIFE_CATEGORIES: ReadonlySet<string> = new Set(["nightlife", "dining", "activity"]);
/** Local hours [from, to) that are night. Wraps midnight. */
export const NIGHT_HOURS = { from: 21, to: 3 } as const;
/** Local hours [from, to) that are rest when nothing says otherwise. */
export const REST_HOURS = { from: 0, to: 7 } as const;

export interface PhasePlanItem {
  id: string;
  category: string | null;
  status: string | null;
  /** ISO instants; null when the item has none. */
  startsAt: string | null;
  endsAt: string | null;
  /** YYYY-MM-DD */
  dayDate: string | null;
}

export interface PhaseInputs {
  now: Date;
  /** IANA zone the trip's days are counted in; null → UTC. */
  timezone: string | null;
  tripStartDate: string | null;
  tripEndDate: string | null;
  /** `computeTripStatus`'s answer: draft | planning | upcoming | active | completed | cancelled | archived. */
  tripStatus: string | null;
  /** The plan, live items only. */
  planItems: readonly PhasePlanItem[];
  /** §7.3 windows for the trip (between-commitment gaps). */
  windows: readonly FreedomWindow[];
  /** True when the trip is disrupted: a realised risk, a Safe Return NEEDS_HELP, or health DISRUPTED. */
  disrupted: boolean;
  /** True when the viewer has an active Safe Return session (nightlife's "safe return" input). */
  safeReturnActive: boolean;
}

export interface PhaseDecision {
  /** null: the trip is not in progress today, so no operational phase applies. */
  phase: OperationalPhase | null;
  /** The clause that produced the phase. */
  reason: string;
  primaryFocus: string | null;
  /** What was looked at, so a consumer can disagree with facts rather than a word. */
  evidence: {
    localDate: string;
    localHour: number;
    activePlanId: string | null;
    windowId: string | null;
    inTransitTo: string | null;
  };
}

/** Local calendar date and hour in `timezone` (UTC on an unknown zone). */
export function localClock(now: Date, timezone: string | null): { date: string; hour: number } {
  const tz = timezone ?? "UTC";
  const fmt = (z: string) => new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  let parts: Intl.DateTimeFormatPart[];
  try { parts = fmt(tz).formatToParts(now); } catch { parts = fmt("UTC").formatToParts(now); }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24; // en-CA can render midnight as "24"
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.isFinite(hour) ? hour : 0 };
}

const inHours = (h: number, r: { from: number; to: number }) => (r.from <= r.to ? h >= r.from && h < r.to : h >= r.from || h < r.to);

export function deriveOperationalPhase(inputs: PhaseInputs): PhaseDecision {
  const { date, hour } = localClock(inputs.now, inputs.timezone);
  const nowMs = inputs.now.getTime();
  const evidence = { localDate: date, localHour: hour, activePlanId: null as string | null, windowId: null as string | null, inTransitTo: null as string | null };
  const answer = (phase: OperationalPhase | null, reason: string): PhaseDecision =>
    ({ phase, reason, primaryFocus: phase ? PRIMARY_FOCUS[phase] : null, evidence });

  // 0. Not in progress: no phase. A trip that has not started is not in FREE_TIME.
  const start = inputs.tripStartDate; const end = inputs.tripEndDate;
  const withinDates = !!start && date >= start && (!end || date <= end);
  if (inputs.tripStatus === "cancelled" || inputs.tripStatus === "archived") return answer(null, `trip is ${inputs.tripStatus}`);
  if (!withinDates) return answer(null, start ? `local date ${date} is outside ${start}..${end ?? "open"}` : "trip has no dates");

  // 1. Disruption first.
  if (inputs.disrupted) return answer("DISRUPTED", "a realised risk, a Safe Return NEEDS_HELP, or DISRUPTED health");

  // 2. The trip's edges own their days.
  const isStart = date === start; const isEnd = !!end && date === end;
  if (isStart && isEnd) return answer(hour < 12 ? "ARRIVAL_DAY" : "DEPARTURE_DAY", "a one-day trip: arrival before local noon, departure after");
  if (isStart) return answer("ARRIVAL_DAY", `local date ${date} is the trip's first day`);
  if (isEnd) return answer("DEPARTURE_DAY", `local date ${date} is the trip's last day`);

  // 3. What the traveller is doing now.
  for (const w of inputs.windows) {
    if (w.position !== "between" || !w.requiredDestination) continue;
    const ends = Date.parse(w.endsAt); const arrive = Date.parse(w.requiredDestination.arriveBy);
    if (Number.isFinite(ends) && Number.isFinite(arrive) && ends <= nowMs && nowMs < arrive) {
      evidence.inTransitTo = w.requiredDestination.commitmentId; evidence.windowId = w.id;
      return answer("TRANSIT", `past the leave-by time of window ${w.id}; due at commitment ${w.requiredDestination.commitmentId}`);
    }
  }
  const active = inputs.planItems.find((p) => {
    if (p.status === "cancelled" || p.status === "done") return false;
    if (p.status === "in_progress") return true;
    const s = p.startsAt ? Date.parse(p.startsAt) : NaN; const e = p.endsAt ? Date.parse(p.endsAt) : NaN;
    return Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && nowMs < e;
  });
  if (active) { evidence.activePlanId = active.id; return answer("ACTIVE_PLAN", `plan item ${active.id} is under way now`); }

  // 4. The clock.
  if (inHours(hour, NIGHT_HOURS)) {
    const tonight = inputs.planItems.some((p) => p.dayDate === date && p.status !== "cancelled" && NIGHTLIFE_CATEGORIES.has(String(p.category ?? "")));
    if (inputs.safeReturnActive || tonight) return answer("NIGHTLIFE", inputs.safeReturnActive ? "night hours with an active Safe Return" : "night hours with a nightlife-category plan today");
  }
  if (inHours(hour, REST_HOURS)) return answer("REST", `local hour ${hour} is a rest hour with nothing under way`);

  // 5. Free time — the default state of a traveller nothing is bounding now.
  const window = inputs.windows.find((w) => Date.parse(w.beginsAt) <= nowMs && nowMs < Date.parse(w.endsAt));
  if (window) { evidence.windowId = window.id; return answer("FREE_TIME", `inside freedom window ${window.id}`); }
  return answer("FREE_TIME", "no commitment bounds the present moment");
}
