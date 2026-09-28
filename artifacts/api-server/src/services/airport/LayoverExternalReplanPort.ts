/**
 * LayoverExternalReplanPort — the I/O half of §11.1, for an event that came
 * from OUTSIDE the session it moves.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §11.1 the eight-step replanner pipeline (this file supplies steps 2's
 *         inputs and nothing else; the pipeline itself is pure)
 *   §18   `LayoverReplanner.replan(sessionId, trigger)`
 *   §20   replan_rate, and the ledger the route already writes
 *
 * ── WHERE THIS SITS ──────────────────────────────────────────────────────────
 * `services/layover/layoverExternalEventConsumer.ts` owns the DURABLE half:
 * it reads `layover_external_events` where `processed_at IS NULL`, claims a row
 * by compare-and-swap, hands the envelope to a port, and stamps `processed_at`.
 * `services/airport/LayoverEventReplanner.ts` owns the PURE half: given an
 * envelope, an airport, a set of sessions and their candidates, it runs the
 * eight steps and returns what changed.
 *
 * Neither of them reads a `layover_sessions` row, and neither may: the consumer
 * must not learn the layover domain's schema, and the pipeline must stay pure.
 * This module is the only thing that stands between them — it assembles the
 * pipeline's context out of the database and maps the result back to the
 * report the consumer publishes.
 *
 * `LayoverReplanService.ts` is the same job for the OTHER producer, a traveller
 * editing their own window through `PATCH /api/airport/sessions/:id`. The two
 * deliberately do not share a function: that one has the session in hand and
 * one session only, must compare the pipeline's post-event inputs against the
 * row the route is about to persist, and refuses rather than replanning when
 * they diverge. This one is handed ids and has to go and find everything.
 *
 * ── THE FAN-OUT, AND WHY IT IS GROUPED BY AIRPORT ───────────────────────────
 * `handleEvent` takes ONE `FeasibilityAirport`, because every session it
 * recomputes is certified against that airport's buffers. An event may name
 * several airports (and a session subject carries its own airport with it), so
 * this module groups the impacted sessions by airport ref and calls the
 * pipeline once per group, summing the counts.
 *
 * The alternative — pick the first airport and certify everyone against it —
 * would recompute a traveller's deadline using another airport's immigration
 * and traffic constants and report the difference as a replan. That is the
 * fabricated-input class census-layover L293 was opened for.
 *
 * ── A FAILED READ IS NEVER AN EMPTY SESSION LIST ─────────────────────────────
 * "No session is affected by this event" and "the sessions table could not be
 * read" are opposite facts that produce the same number, and the consumer acts
 * on that number by stamping `processed_at`. A swallowed read here would mark
 * an event permanently handled while having handled nothing. So every read is
 * checked and any failure returns `{ ok: false, reason }`, which the consumer
 * records as a stranded event rather than as a quiet success. census-layover
 * has now recorded that same swallow on this domain four separate times
 * (§21.4, §23.1); this is the fifth place it could have happened and does not.
 *
 * The airport read is held to the same rule, and that one is easy to get wrong:
 * `lookupByIata` FALLS BACK to the static dataset and reports `degraded: true`
 * with `airport_profiles_unreadable`. Treating that fallback as an answer would
 * silently re-certify a traveller's deadline against generic constants during
 * an outage and publish the change as a real one, so a degraded lookup refuses.
 *
 * ── NO CLOCK ─────────────────────────────────────────────────────────────────
 * `nowMs` is supplied when the port is built and is the same instant for every
 * event in a drain. There is no `Date.now()` and no no-arg `new Date()` in this
 * file: the whole path is deterministic under test, and a port that read the
 * clock per event would make two events claimed in one drain disagree about
 * when "now" was.
 *
 * ── WHAT IT DOES NOT DO, EACH WITH THE ARTIFACT THAT BLOCKS IT ──────────────
 *  - It does not write `layover_external_events`. The claim and the
 *    `processed_at` stamp belong to the consumer; a port that also stamped
 *    would make a duplicate replan reachable through a partial failure.
 *  - It passes NO held recommendations. §11.1 step 6 compares a held card's
 *    `inputHash` against the new record's, and `layover_recommendations` has no
 *    such column (census L64) — so the empty array is the honest shape and
 *    synthesising an id/hash pair would make `staleCertification` fire on
 *    invented evidence.
 *  - It passes NO live conditions. Nothing on this tree produces
 *    `LiveConditions` outside tests (census L81), so the pipeline's prior-live
 *    argument is genuinely absent rather than zero.
 *  - It does not persist a snapshot. `ReplanOutcome.snapshotPersisted` is
 *    `false` by construction; 2700 is unapplied.
 *  - It does not notify. `shouldNotify` DECIDES and the count is reported; the
 *    delivery surface is the consumer's caller's to choose.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { airportRowToProfile, lookupByIata } from "./AirportProfileService.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { FeasibilityAirport } from "./LayoverFeasibility.js";
import {
  handleEvent,
  type HandleEventResult,
  type LayoverEventEnvelope,
  type ReplanCandidate,
  type ReplanSession,
} from "./LayoverEventReplanner.js";
import { candidatesFromStops } from "./LayoverReplanService.js";

const logger = rootLogger.child({ service: "LayoverExternalReplanPort" });

/**
 * The consumer's report shape, restated here rather than imported.
 *
 * `services/layover/layoverExternalEventConsumer.ts` declares `ReplanReport`
 * and `ReplanPort` and is the authority on both. This module deliberately does
 * NOT import them: the dependency runs the other way — the consumer knows
 * nothing about airports, and this file knowing nothing about the durable
 * queue is what keeps the pipeline callable from a route, a test or a
 * scheduler without a `layover_external_events` row existing.
 *
 * The two are structurally identical and that is the contract. If the
 * consumer's declaration ever changes, `layoverExternalReplanPort()` stops
 * satisfying `ReplanPort` at the wiring site and the build says so there.
 */
export type ReplanReport =
  | { ok: true; impacted: number; notifications: number }
  | { ok: false; reason: string };

/** The one method `ReplanPort` requires, structurally. */
export interface LayoverReplanPort {
  replan(event: LayoverEventEnvelope): Promise<ReplanReport>;
}

export interface LayoverReplanPortOptions {
  /** The instant every event in this drain is replanned at. Required. */
  nowMs: number;
  /**
   * Cap on active sessions pulled in for ONE event.
   *
   * An `airport` subject fans out to every active session at that airport, and
   * the size of that fan-out is chosen by whoever produced the event. Bounded
   * so a single malformed or hostile envelope cannot turn one drain tick into
   * an unbounded recompute. A drain that hits the cap is reported, not
   * silently truncated — see `sessionLimitReached` in the log line.
   */
  sessionLimit?: number;
}

export const DEFAULT_REPLAN_SESSION_LIMIT = 200;

/** The narrow view of a profile the feasibility arithmetic reads. */
function feasibilityAirport(p: AirportProfile): FeasibilityAirport {
  return {
    id: p.id,
    iataCode: p.iataCode,
    timezone: p.timezone,
    verified: p.verified,
    domesticBufferMin: p.domesticBufferMin,
    internationalBufferMin: p.internationalBufferMin,
    immigrationExtraMin: p.immigrationExtraMin,
    checkedBagsExtraMin: p.checkedBagsExtraMin,
    trafficExtraMin: p.trafficExtraMin,
  };
}

/**
 * The airport identity a session carries, in the order the rest of this domain
 * uses: the profile row it points at, then the traveller's own IATA code for an
 * airport that has no row. `UNK` is not an airport, it is the absence of one.
 */
function sessionAirportIdentity(row: Record<string, any>): string | null {
  if (typeof row.airport_id === "string" && row.airport_id) return row.airport_id;
  const iata = typeof row.manual_iata === "string" ? row.manual_iata.trim().toUpperCase() : "";
  if (iata && iata !== "UNK") return iata;
  return null;
}

/**
 * A `layover_sessions` row as the pure pipeline reads it.
 *
 * `airportRef` is the ref THIS EVENT used, not the row's own spelling, because
 * `impactedSessions` compares it against the envelope's `airport` subjects. A
 * session stored under a profile id, reached by an event naming an IATA code,
 * must carry the IATA code here or the pipeline would drop it again after this
 * module went to the trouble of finding it.
 */
function toReplanSession(row: Record<string, any>, airportRef: string): ReplanSession {
  return {
    status: String(row.status ?? ""),
    airportRef,
    session: {
      id: String(row.id),
      arrivalTime: String(row.arrival_time),
      departureTime: String(row.departure_time),
      boardingTime: row.boarding_time ?? null,
      flightType: row.flight_type ?? "domestic",
      immigrationRequired: Boolean(row.immigration_required),
      checkedBags: Boolean(row.checked_bags),
      wantsToLeave: row.wants_to_leave !== false,
    },
  };
}

type Refusal = { ok: false; reason: string };
const refuse = (reason: string): Refusal => ({ ok: false, reason });

/**
 * Every ACTIVE session this event could bear on, grouped by the airport each
 * one will be certified against.
 *
 * TWO ROUTES INTO §11.1 STEP 2, and they name an airport in different
 * alphabets. An event's `airport` subject is the producer's identity for the
 * airport — an IATA code, typically — while `layover_sessions.airport_id` is a
 * PROFILE ROW ID and `manual_iata` is the traveller's own code for an airport
 * that has no row. Matching only on the literal ref finds nobody, because no
 * production session stores an IATA code in `airport_id`. So the ref is
 * RESOLVED to an airport first, and the sessions are then read by every
 * identity that airport answers to.
 *
 * The resolved airport is carried back out, because resolving it a second time
 * per group would be a second read that could give a different answer.
 *
 * Over-reads on purpose. `impactedSessions` applies the window test that keeps
 * an airport-wide event off sessions whose flight has already gone; doing half
 * of that filtering here would put the rule in two places and let them drift.
 * The only filter applied at the database is `status = 'active'`, which the
 * pipeline states as a precondition rather than as policy.
 */
interface AirportGroup {
  airportRef: string;
  airport: FeasibilityAirport;
  sessions: ReplanSession[];
}

async function readActiveSessionsAt(
  db: SupabaseClient,
  identities: string[],
  manualIata: string | null,
  limit: number,
): Promise<{ ok: true; rows: Array<Record<string, any>>; limitReached: boolean } | Refusal> {
  const rows: Array<Record<string, any>> = [];
  let limitReached = false;
  if (identities.length > 0) {
    const { data, error } = await db
      .from("layover_sessions")
      .select("*")
      .in("airport_id", identities)
      .eq("status", "active")
      .limit(limit);
    if (error) return refuse(`layover_sessions unreadable by airport_id: ${String(error.message ?? "unknown")}`);
    rows.push(...((data ?? []) as Array<Record<string, any>>));
    if ((data ?? []).length >= limit) limitReached = true;
  }
  if (manualIata) {
    // A SECOND read, not an `.or()`. The airport identity a session carries is
    // either its `airport_id` (a profile row) or its `manual_iata` (no profile
    // row), and those are different columns. `.or()` across them is also a
    // construct this tree's fake client models as a NO-OP, so a test written
    // over it would pass on a filter that never applied.
    const { data, error } = await db
      .from("layover_sessions")
      .select("*")
      .eq("manual_iata", manualIata)
      .eq("status", "active")
      .limit(limit);
    if (error) return refuse(`layover_sessions unreadable by manual_iata: ${String(error.message ?? "unknown")}`);
    rows.push(...((data ?? []) as Array<Record<string, any>>));
    if ((data ?? []).length >= limit) limitReached = true;
  }
  return { ok: true, rows, limitReached };
}

async function readGroups(
  db: SupabaseClient,
  event: LayoverEventEnvelope,
  limit: number,
): Promise<{ ok: true; groups: AirportGroup[]; limitReached: boolean } | Refusal> {
  const airportRefs = [...new Set(event.subjectRefs.filter((s) => s.kind === "airport").map((s) => s.ref))];
  const sessionRefs = [...new Set(event.subjectRefs.filter((s) => s.kind === "session").map((s) => s.ref))];

  const groups = new Map<string, AirportGroup>();
  const claimed = new Set<string>();
  let limitReached = false;

  for (const ref of airportRefs) {
    const resolved = await resolveAirport(db, ref);
    if (!resolved.ok) return resolved;
    const identities = [...new Set([ref, resolved.airport.id].filter((x): x is string => Boolean(x)))];
    const read = await readActiveSessionsAt(db, identities, ref, limit);
    if (!read.ok) return read;
    if (read.limitReached) limitReached = true;
    const group: AirportGroup = { airportRef: ref, airport: resolved.airport, sessions: [] };
    for (const row of read.rows) {
      const id = String(row.id);
      if (claimed.has(id)) continue;
      claimed.add(id);
      group.sessions.push(toReplanSession(row, ref));
    }
    groups.set(ref, group);
  }

  if (sessionRefs.length > 0) {
    const { data, error } = await db
      .from("layover_sessions")
      .select("*")
      .in("id", sessionRefs.slice(0, limit))
      .eq("status", "active")
      .limit(limit);
    if (error) {
      logger.warn({ err: error.message, eventId: event.eventId }, "replan port: session-subject read failed");
      return refuse(`layover_sessions unreadable by id: ${String(error.message ?? "unknown")}`);
    }
    for (const row of (data ?? []) as Array<Record<string, any>>) {
      const id = String(row.id);
      if (claimed.has(id)) continue;
      const own = sessionAirportIdentity(row);
      if (own === null) {
        // No airport identity at all. The pipeline needs an `airportRef` to
        // hold the session and there is nothing honest to put there; dropped,
        // and named in the log rather than silently.
        logger.warn({ sessionId: id, eventId: event.eventId }, "replan port: session has no airport identity — skipped");
        continue;
      }
      let group = groups.get(own);
      if (!group) {
        const resolved = await resolveAirport(db, own);
        if (!resolved.ok) return resolved;
        group = { airportRef: own, airport: resolved.airport, sessions: [] };
        groups.set(own, group);
      }
      claimed.add(id);
      group.sessions.push(toReplanSession(row, group.airportRef));
    }
  }

  return { ok: true, groups: [...groups.values()], limitReached };
}

/**
 * The plan stops of the impacted sessions, as `ReplanCandidate`s.
 *
 * Through `candidatesFromStops`, which is `LayoverPlanFit`'s classifier and the
 * single rule for what an unstated leg is — `layover_plan_stops.travel_min` is
 * `NOT NULL DEFAULT 0`, so a landside 0 is an ABSENCE and not a free journey
 * (census L47). A second mapping here would be the fourth copy of that rule.
 */
async function readCandidates(
  db: SupabaseClient,
  sessionIds: string[],
  limit: number,
): Promise<{ ok: true; candidates: Record<string, ReplanCandidate[]> } | Refusal> {
  if (sessionIds.length === 0) return { ok: true, candidates: {} };
  const { data, error } = await db
    .from("layover_plan_stops")
    .select("id,session_id,travel_min,duration_min,inside_airport")
    .in("session_id", sessionIds)
    .limit(limit);
  if (error) {
    logger.warn({ err: error.message }, "replan port: plan-stop read failed");
    return refuse(`layover_plan_stops unreadable: ${String(error.message ?? "unknown")}`);
  }
  const bySession = new Map<string, Array<Record<string, unknown>>>();
  for (const r of (data ?? []) as Array<Record<string, any>>) {
    const sid = String(r.session_id);
    const bucket = bySession.get(sid) ?? [];
    bucket.push({
      id: r.id,
      travelMin: r.travel_min,
      durationMin: r.duration_min,
      insideAirport: r.inside_airport,
    });
    bySession.set(sid, bucket);
  }
  const candidates: Record<string, ReplanCandidate[]> = {};
  for (const [sid, stops] of bySession) candidates[sid] = candidatesFromStops(stops);
  return { ok: true, candidates };
}

/**
 * The airport an `airportRef` names, or a refusal.
 *
 * A DEGRADED lookup is a refusal. `lookupByIata` answers an unreadable
 * `airport_profiles` with the static dataset and `degraded: true`; certifying a
 * replan against constants that are not this airport's, and publishing the
 * difference as a change the traveller should act on, is the defect this whole
 * file's fail-closed rule exists for.
 *
 * A ref that is not IATA-shaped is read as a profile ROW ID, which is what
 * `layover_sessions.airport_id` holds. A ref that matches nothing at all is a
 * refusal too: there is no airport to certify against, and the generic fallback
 * profile is not "this airport" — it is the absence of one, and replanning a
 * real traveller's deadline on it would be the fabricated input again.
 */
async function resolveAirport(
  db: SupabaseClient,
  airportRef: string,
): Promise<{ ok: true; airport: FeasibilityAirport } | Refusal> {
  if (!/^[A-Za-z]{3}$/.test(airportRef)) {
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .eq("id", airportRef)
      .maybeSingle();
    if (error) return refuse(`airport_profiles unreadable for ${airportRef}: ${String(error.message ?? "unknown")}`);
    if (!data) return refuse(`no airport known for ${airportRef}`);
    return { ok: true, airport: feasibilityAirport(airportRowToProfile(data)) };
  }

  const lookup = await lookupByIata(db, airportRef);
  if (lookup.degraded) {
    return refuse(
      `airport lookup for ${airportRef} is degraded (${lookup.degradedReasons.join(",")}) — ` +
        "refusing rather than replanning against constants that are not this airport's",
    );
  }
  if (!lookup.airport) return refuse(`no airport known for ${airportRef}`);
  return { ok: true, airport: feasibilityAirport(lookup.airport) };
}

/**
 * Build the port the external-event consumer drives.
 *
 * Satisfies `ReplanPort` from
 * `services/layover/layoverExternalEventConsumer.ts` structurally; see
 * `ReplanReport` above for why it is not imported.
 */
export function layoverExternalReplanPort(
  db: SupabaseClient,
  opts: LayoverReplanPortOptions,
): LayoverReplanPort {
  const limit = opts.sessionLimit ?? DEFAULT_REPLAN_SESSION_LIMIT;
  return {
    async replan(event: LayoverEventEnvelope): Promise<ReplanReport> {
      return replanExternalEvent(db, event, { nowMs: opts.nowMs, sessionLimit: limit });
    },
  };
}

/**
 * One event, replanned. Exported on its own so a route or a test can drive it
 * without a queue; the port above is a two-line adapter over it.
 */
export async function replanExternalEvent(
  db: SupabaseClient,
  event: LayoverEventEnvelope,
  opts: LayoverReplanPortOptions,
): Promise<ReplanReport> {
  const limit = opts.sessionLimit ?? DEFAULT_REPLAN_SESSION_LIMIT;

  const read = await readGroups(db, event, limit);
  if (!read.ok) return read;

  const sessionIds = read.groups.flatMap((g) => g.sessions.map((s) => s.session.id));
  if (sessionIds.length === 0) {
    // A genuine zero. Every read succeeded and nothing active sits at any
    // subject this event names, which is a fact the consumer may stamp on.
    return { ok: true, impacted: 0, notifications: 0 };
  }

  const stops = await readCandidates(db, sessionIds, limit);
  if (!stops.ok) return stops;

  let impacted = 0;
  let notifications = 0;
  for (const group of read.groups) {
    if (group.sessions.length === 0) continue;
    const result: HandleEventResult = handleEvent(event, {
      airport: group.airport,
      sessions: group.sessions,
      candidates: stops.candidates,
      // heldRecommendations / liveConditions / disruptionStates deliberately
      // omitted — see the header. An empty shape, never an invented one.
      nowMs: opts.nowMs,
    });
    impacted += result.impacted;
    notifications += result.notifications;
  }

  logger.info(
    {
      eventId: event.eventId,
      eventType: event.eventType,
      airports: read.groups.length,
      sessionsRead: sessionIds.length,
      sessionLimitReached: read.limitReached,
      impacted,
      notifications,
    },
    "layover external event replanned",
  );
  return { ok: true, impacted, notifications };
}
