/**
 * LayoverPresenceStore — §4 `layover_presence` and §14's L1 rung, "5 open to
 * food". census-layover L27 (the record), L129 (the rung), L187
 * (`LayoverCrewService.updatePresence(sessionId, input)`).
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Presence on this tree is one boolean, `layover_sessions.share_city_status`.
 * A traveller could say "I am here" and nothing about what they are open to,
 * until when, or how far they would go — so §14's ladder went straight from a
 * count (L0) to named profiles (L2), with nothing in between.
 *
 * ── WHAT A RECORD MAY SAY ───────────────────────────────────────────────────
 *   intents             a CLOSED vocabulary — the start sheet's vibe chips
 *                       minus `rest` — CHECKed by migration 3900.
 *   availableUntil      when they stop being open. Bounded by the session's own
 *                       departure: nobody is "open to food" after their flight.
 *   maxTravelMinutes    how far they would go; null = not stated, never 0.
 *
 * It never says WHERE: no coordinate column exists (3900's postcondition), and
 * `precise_location_enabled` is CHECKed FALSE until §14 L4 is built.
 *
 * ── WHAT OTHERS SEE: COUNTS, NEVER PEOPLE ───────────────────────────────────
 * `intentCounts` takes the user ids `cityPresence` already cleared — same city,
 * opted in, not blocked either way, sharing not paused, ghost mode off — and
 * returns how many of THOSE are open to each intent right now. No id, no name,
 * no window crosses the wire. A traveller whose record says
 * `visibility_scope = 'aggregate'` counts toward nothing here.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * `layover_presence_intents_enabled`, seeded FALSE by 3900 and spelled as a
 * literal at every read so check:flag-polarity can see it. OFF / absent /
 * unreadable: nothing reads or writes the table and every answer says so.
 * A failed read is a refusal, never an empty set of intents.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js"; import { activeCrewForUser, crewMembers } from "./LayoverCrewStore.js"; import { acceptedCrewOfTrip } from "../memory/memoryReadPolicy.js"; // D-PRESENCE-K (lane R, 2026-10-07)

const logger = rootLogger.child({ service: "LayoverPresenceStore" });

export const PRESENCE_INTENTS_FLAG = "layover_presence_intents_enabled";

/** 3900's CHECK vocabulary, verbatim and in the same order. */
export const PRESENCE_INTENTS = ["food", "nightlife", "shopping", "culture", "meetups"] as const;
export type PresenceIntent = (typeof PRESENCE_INTENTS)[number];

/** 3900's CHECK range for `max_travel_minutes`. */
export const MAX_TRAVEL_MINUTES_RANGE = { min: 5, max: 240 } as const;

export interface PresenceRecord {
  intents: PresenceIntent[];
  availableFrom: string;
  availableUntil: string;
  maxTravelMinutes: number | null;
}

export type PresenceIntentCounts = Record<PresenceIntent, number>;

export function isPresenceIntent(v: unknown): v is PresenceIntent {
  return typeof v === "string" && (PRESENCE_INTENTS as readonly string[]).includes(v);
}

export type PresenceInputError =
  | "intents_invalid"
  | "available_until_invalid"
  | "available_until_past_departure"
  | "available_until_not_in_future"
  | "max_travel_invalid";

/**
 * Validate and normalise what the traveller sent. Pure, so every refusal is a
 * unit case. Duplicates collapse; an unknown intent refuses the WHOLE input
 * rather than being dropped, because a dropped word is an intent the traveller
 * believes they shared and did not.
 */
export function parsePresenceInput(
  body: unknown,
  session: { departureTime: string },
  nowMs: number,
): { ok: true; value: PresenceRecord } | { ok: false; error: PresenceInputError } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.intents) || !b.intents.every(isPresenceIntent)) return { ok: false, error: "intents_invalid" };
  const intents = [...new Set(b.intents as PresenceIntent[])].sort(
    (x, y) => PRESENCE_INTENTS.indexOf(x) - PRESENCE_INTENTS.indexOf(y),
  );

  const departureMs = Date.parse(session.departureTime);
  let untilMs: number;
  if (b.availableUntil === undefined || b.availableUntil === null) {
    untilMs = departureMs;
  } else {
    if (typeof b.availableUntil !== "string") return { ok: false, error: "available_until_invalid" };
    untilMs = Date.parse(b.availableUntil);
    if (!Number.isFinite(untilMs)) return { ok: false, error: "available_until_invalid" };
  }
  if (!Number.isFinite(departureMs) || untilMs > departureMs) return { ok: false, error: "available_until_past_departure" };
  if (untilMs <= nowMs) return { ok: false, error: "available_until_not_in_future" };

  let maxTravelMinutes: number | null = null;
  if (b.maxTravelMinutes !== undefined && b.maxTravelMinutes !== null) {
    const m = b.maxTravelMinutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < MAX_TRAVEL_MINUTES_RANGE.min || m > MAX_TRAVEL_MINUTES_RANGE.max) {
      return { ok: false, error: "max_travel_invalid" };
    }
    maxTravelMinutes = m;
  }
  return {
    ok: true,
    value: { intents, availableFrom: new Date(nowMs).toISOString(), availableUntil: new Date(untilMs).toISOString(), maxTravelMinutes },
  };
}

export type PresenceWrite = { ok: true; record: PresenceRecord } | { ok: false; reason: "intents_disabled" | "write_failed" };
export type PresenceRead = { ok: true; record: PresenceRecord | null } | { ok: false; reason: "intents_disabled" | "read_failed" };
export type IntentCountsRead = { ok: true; counts: PresenceIntentCounts } | { ok: false; reason: "intents_disabled" | "read_failed" };

const SELECT = "intents, available_from, available_until, max_travel_minutes";

function toRecord(r: Record<string, unknown>): PresenceRecord {
  return {
    intents: (Array.isArray(r.intents) ? r.intents : []).filter(isPresenceIntent),
    availableFrom: String(r.available_from),
    availableUntil: String(r.available_until),
    maxTravelMinutes: typeof r.max_travel_minutes === "number" ? r.max_travel_minutes : null,
  };
}

export async function setPresenceIntents(
  db: SupabaseClient,
  args: { sessionId: string; userId: string; record: PresenceRecord; nowMs: number },
): Promise<PresenceWrite> {
  if (!(await isFlagEnabled(db, "layover_presence_intents_enabled"))) return { ok: false, reason: "intents_disabled" };
  const row = {
    session_id: args.sessionId,
    user_id: args.userId,
    visibility_scope: "intent",
    intents: args.record.intents,
    available_from: args.record.availableFrom,
    available_until: args.record.availableUntil,
    max_travel_minutes: args.record.maxTravelMinutes,
    precise_location_enabled: false,
    expires_at: args.record.availableUntil,
    updated_at: new Date(args.nowMs).toISOString(),
  };
  const { error } = await db.from("layover_presence").upsert(row, { onConflict: "session_id" });
  if (error) {
    logger.warn({ err: error, sessionId: args.sessionId }, "layover presence write failed — not stored");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, record: args.record };
}

export async function clearPresenceIntents(db: SupabaseClient, sessionId: string): Promise<{ ok: true } | { ok: false; reason: "intents_disabled" | "write_failed" }> {
  if (!(await isFlagEnabled(db, "layover_presence_intents_enabled"))) return { ok: false, reason: "intents_disabled" };
  const { error } = await db.from("layover_presence").delete().eq("session_id", sessionId);
  if (error) {
    logger.warn({ err: error, sessionId }, "layover presence delete failed — the record may still stand");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true };
}

/** The traveller's OWN record; `null` = none, or it has expired. */
export async function readOwnPresence(db: SupabaseClient, sessionId: string, nowMs: number): Promise<PresenceRead> {
  if (!(await isFlagEnabled(db, "layover_presence_intents_enabled"))) return { ok: false, reason: "intents_disabled" };
  const { data, error } = await db
    .from("layover_presence")
    .select(SELECT)
    .eq("session_id", sessionId)
    .gt("expires_at", new Date(nowMs).toISOString())
    .maybeSingle();
  if (error) {
    logger.warn({ err: error, sessionId }, "layover presence unreadable — refusing rather than reporting none");
    return { ok: false, reason: "read_failed" };
  }
  return { ok: true, record: data ? toRecord(data as Record<string, unknown>) : null };
}

export function emptyIntentCounts(): PresenceIntentCounts {
  return Object.fromEntries(PRESENCE_INTENTS.map((k) => [k, 0])) as PresenceIntentCounts;
}

/**
 * §14 L1: how many of the ALREADY-CLEARED travellers are open to each intent
 * right now. `visibleUserIds` must come from `cityPresence`; this function
 * applies no block or consent rule of its own, so it cannot disagree with it.
 * A traveller counts once per intent however many sessions they hold.
 */
export async function intentCounts(
  db: SupabaseClient,
  visibleUserIds: readonly string[],
  nowMs: number,
): Promise<IntentCountsRead> {
  if (!(await isFlagEnabled(db, "layover_presence_intents_enabled"))) return { ok: false, reason: "intents_disabled" };
  const counts = emptyIntentCounts();
  if (visibleUserIds.length === 0) return { ok: true, counts };
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("layover_presence")
    .select("user_id, intents, available_from, available_until, visibility_scope")
    .in("user_id", [...visibleUserIds])
    .eq("visibility_scope", "intent")
    .gt("expires_at", nowIso)
    .limit(500);
  if (error) {
    logger.warn({ err: error }, "layover presence intents unreadable — refusing rather than reporting nobody open");
    return { ok: false, reason: "read_failed" };
  }
  const seen = new Map<PresenceIntent, Set<string>>(PRESENCE_INTENTS.map((k) => [k, new Set<string>()]));
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const from = Date.parse(String(r.available_from));
    const until = Date.parse(String(r.available_until));
    if (!(from <= nowMs && nowMs < until)) continue;
    for (const i of Array.isArray(r.intents) ? r.intents : []) {
      if (isPresenceIntent(i)) seen.get(i)!.add(String(r.user_id));
    }
  }
  for (const k of PRESENCE_INTENTS) counts[k] = seen.get(k)!.size;
  return { ok: true, counts };
}

// ── D-PRESENCE-K: what a count may say, and to whom ─────────────────────────
//
// Lead ruling D-PRESENCE-K (2026-10-06; census-layover §52.1, §54.5):
// "Presence intents never show a count below 5, and never combine a count with
// a roster that could name someone." §52.1's probe P4 is the reason: with the
// cleared crew at ONE traveller and that traveller named on the presence
// roster, `nightlife: 1` said exactly what a named person was open to.
//
// Three rules, each applied by the intents read before a count leaves:
//   1. MINIMUM k. A count below k — ZERO INCLUDED, because "nobody here is open
//      to X" is a statement about every person on a roster — is withheld:
//      `null` on the wire, "fewer than k", never a number.
//   2. NO ROSTER BESIDE IT. Counts are served only while the presence surface
//      itself is aggregate-only (`layover_presence_ladder_enabled` ON). With
//      the ladder off, `GET /:id/presence` answers with named profiles for the
//      same population, so the counts are withheld whole (`roster_visible`).
//   3. (D-PRESENCE-K-3, 2026-10-07, amending K-2 after the fourth verification's
//      F1.) The count is VIEWER-INVARIANT — one city-wide population, the same
//      for every viewer (routes/airport.ts `cityIntentPopulation`) — and it is
//      withheld WHOLE (`roster_visible`) whenever ANY of the viewer's rosters for
//      the city is non-empty (their crew card, their trip's crew, the city's
//      buddy roster), whoever is in the counted population. K-2 withheld only
//      when a NAMED person was in the population, and that bit then said whether
//      a named crewmate was sharing their city. The first rule 3 subtracted the
//      named people from the count, which made the count itself the oracle.
//      An unreadable roster read refuses; it is never "no roster".
//   4. (D-PRESENCE-K-3.) The count is a SNAPSHOT: one per city per hour, the
//      same for every viewer until the next hour (`intentCountSnapshot` below).

export const PRESENCE_INTENT_MIN_K = 5;

/** Per intent: a count of at least k, or `null` — fewer than k (zero included). */
export type DisclosedIntentCounts = Record<PresenceIntent, number | null>;

export function discloseIntentCounts(raw: PresenceIntentCounts, k: number = PRESENCE_INTENT_MIN_K): DisclosedIntentCounts {
  const out = {} as DisclosedIntentCounts;
  for (const i of PRESENCE_INTENTS) {
    const n = raw[i];
    out[i] = Number.isInteger(n) && n >= k ? n : null;
  }
  return out;
}

export type ViewerRostersRead =
  | { ok: true; nonEmpty: boolean; rosters: Array<"layover_crew" | "trip_crew" | "buddies"> }
  | { ok: false; reason: "crew_unreadable" | "trip_crew_unreadable" | "buddies_unreadable" };

/**
 * D-PRESENCE-K-3 rule 3: are any of the viewer's rosters for this city
 * NON-EMPTY? A roster is one this product shows them by name:
 *   - their live layover crew card, with any OTHER live member;
 *   - their trip's accepted crew (owner fallback included), with anyone else;
 *   - the city's buddy roster (`GET /:id/buddies`), taken as a SUPERSET — any
 *     active buddy profile in the city other than their own, whether or not the
 *     marketplace or the safety gate would show it today — so an error here can
 *     only withhold more.
 * Independent of who is in the counted population: the answer is about what the
 * viewer already sees, so the withholding it causes carries nothing new.
 */
export async function viewerRosters(
  db: SupabaseClient,
  viewerId: string,
  tripId: string | null,
  nowIso: string,
  city: string | null,
): Promise<ViewerRostersRead> {
  const rosters: Array<"layover_crew" | "trip_crew" | "buddies"> = [];
  const mine = await activeCrewForUser(db, viewerId, nowIso);
  if (!mine.ok) return { ok: false, reason: "crew_unreadable" };
  if (mine.value) {
    const members = await crewMembers(db, mine.value.crew.id);
    if (!members.ok) return { ok: false, reason: "crew_unreadable" };
    if (members.value.some((m) => m.userId !== viewerId)) rosters.push("layover_crew");
  }
  if (tripId) {
    const crew = await acceptedCrewOfTrip(db, tripId);
    if (!crew.ok) {
      logger.warn({ err: crew.error, tripId }, "layover presence intents: trip crew unreadable — refusing rather than serving a count beside a roster");
      return { ok: false, reason: "trip_crew_unreadable" };
    }
    if ([...crew.ids].some((id) => id !== viewerId)) rosters.push("trip_crew");
  }
  if (city) {
    const { data: buddies, error: buddyErr } = await db
      .from("rent_buddy_profiles")
      .select("user_id")
      .eq("status", "active")
      .ilike("city", `%${city}%`)
      .limit(1000);
    if (buddyErr) {
      logger.warn({ err: buddyErr, city }, "layover presence intents: buddy roster unreadable — refusing rather than serving a count beside a roster");
      return { ok: false, reason: "buddies_unreadable" };
    }
    if (((buddies ?? []) as Array<{ user_id: unknown }>).some((b) => typeof b.user_id === "string" && b.user_id !== viewerId)) rosters.push("buddies");
  }
  return { ok: true, nonEmpty: rosters.length > 0, rosters };
}

// ── D-PRESENCE-K-3 rule 4: ONE snapshot per city per hour ─────────────────────
//
// A live count, even viewer-invariant, moves the instant one person toggles
// their sharing or their intents; anyone who can see that toggle by other means
// (a trip screen, a conversation) reads that person's intents off the change.
// So the count a viewer is served is a SNAPSHOT: computed once per city per
// fixed hour (by the first request in it; concurrent first requests share one
// computation) and served unchanged to every viewer until the next hour. A
// toggle shows only at the next boundary, folded into every other change in
// that hour. One process holds the snapshot — this API runs as one process (its
// in-process schedulers assume the same); a durable snapshot is the step if it
// ever scales out. A failed computation is never cached: the next request
// retries, and this one is a 503.

export const PRESENCE_INTENT_SNAPSHOT_MS = 60 * 60_000;
const SNAPSHOT_CITY_CAP = 5000;

let _snapshotClock: () => number = () => Date.now();
/** Test seam: the snapshot's clock. `null` restores Date.now. */
export function _setIntentSnapshotClock(clock: (() => number) | null): void {
  _snapshotClock = clock ?? (() => Date.now());
}

type SnapshotRead = { ok: true; counts: DisclosedIntentCounts; asOf: string } | { ok: false; reason: string };
const _snapshots = new Map<string, { bucket: number; counts: DisclosedIntentCounts }>();
const _inflight = new Map<string, Promise<SnapshotRead>>();

/** Test seam: forget every snapshot. */
export function _resetIntentCountSnapshots(): void {
  _snapshots.clear();
  _inflight.clear();
}

/**
 * The city's disclosed counts for the current hour. `compute` runs at most once
 * per city per hour and returns RAW counts; k is applied before anything is
 * stored, so a raw count never sits in memory longer than one computation.
 */
export async function intentCountSnapshot(
  city: string,
  compute: (nowMs: number) => Promise<{ ok: true; counts: PresenceIntentCounts } | { ok: false; reason: string }>,
): Promise<SnapshotRead> {
  const now = _snapshotClock();
  const bucket = Math.floor(now / PRESENCE_INTENT_SNAPSHOT_MS);
  const key = city.trim().toLowerCase();
  const asOf = new Date(bucket * PRESENCE_INTENT_SNAPSHOT_MS).toISOString();
  const hit = _snapshots.get(key);
  if (hit && hit.bucket === bucket) return { ok: true, counts: hit.counts, asOf };
  const flightKey = `${key}#${bucket}`;
  const pending = _inflight.get(flightKey);
  if (pending) return pending;
  const run = (async (): Promise<SnapshotRead> => {
    try {
      const r = await compute(now);
      if (!r.ok) return r;
      const counts = discloseIntentCounts(r.counts);
      if (_snapshots.size >= SNAPSHOT_CITY_CAP) _snapshots.clear();
      _snapshots.set(key, { bucket, counts });
      return { ok: true, counts, asOf };
    } finally {
      _inflight.delete(flightKey);
    }
  })();
  _inflight.set(flightKey, run);
  return run;
}
