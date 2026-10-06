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
import { isFlagEnabled } from "../../lib/featureFlags.js";

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
