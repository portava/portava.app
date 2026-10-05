/**
 * LayoverCheckpointStore — §4's `layover_checkpoints`, written by the traveller.
 * census-layover L30 (the table), L173 (`recordCheckpoint`), L43 (the re-entry
 * transition's input) and, through `layoverOutcomes`, L32's two observed
 * columns.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Migration 2992 created `layover_checkpoints` and `LayoverDecisionStore.ts`
 * records that nothing writes it because *"L30 needs an observation. L173's
 * `recordCheckpoint` has no caller and no route."* The only observer this tree
 * can honestly have is the traveller: the layover surface performs no location
 * sensing (census L164, guarded by `layoverSensingCadence.test.ts`) and there is
 * no airport or airline feed. 2992 anticipated exactly that — its `source`
 * column defaults to 'TRAVELLER', "the only source this tree can produce today".
 *
 * So a checkpoint here is a SELF-REPORT of one of two moments the Safe Return
 * path turns on: "I've left the airport" (`LANDSIDE_EXIT`) and "I'm back at the
 * airport" (`AIRPORT_REENTRY`). It names a KIND of place, never a position —
 * 2992's postcondition forbids a coordinate column on the table.
 *
 * ── WHAT A SELF-REPORT MAY AND MAY NOT DO ───────────────────────────────────
 * It is recorded with `source = 'TRAVELLER'` and `confidence = 'MEDIUM'`, the
 * same weight 2992 gives every community observation that has not been
 * corroborated. It FEEDS the outcome row (did they leave; when were they back)
 * and is published back to the traveller as `airportPresence`. It does NOT move
 * the certified deadline, the verdict or the return state: those stay the
 * engine's, computed from the clock and the schedule. A tap that said "I'm
 * back" while the traveller was still in the city must never be able to make
 * the app relax.
 *
 * ── THE GATE IS 2992'S, LIKE THE OUTCOME WRITER'S ───────────────────────────
 * `layover_decision_persistence_enabled` — seeded FALSE by 2992, flipped only
 * after 2700 and 2992 are applied (2992's deployment sequence, step 5). Off, a
 * write is REFUSED with `persistence_disabled` and a read answers the same,
 * never an empty list: "we do not store checkpoints here" and "you have
 * reported none" are different facts.
 *
 * ── IDEMPOTENT BY THE TRAVELLER'S OWN OPERATION ID ──────────────────────────
 * 2992 makes `(session_id, dedup_key)` UNIQUE. The key is the checkpoint type
 * plus the client's operation id, so a retried tap after a lost response is the
 * same row (answered as `duplicate: true`), while a genuinely second report —
 * leaving the airport twice on one long layover — is a second row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

const logger = rootLogger.child({ service: "LayoverCheckpointStore" });

/**
 * 2992's write gate, spelled as a LITERAL so check:flag-polarity can resolve which flag is read.
 * It is the same flag as `DECISION_PERSISTENCE_FLAG`; layoverCheckpoints.test.ts asserts the two
 * cannot drift apart.
 */
export const CHECKPOINT_WRITE_FLAG = "layover_decision_persistence_enabled";

/**
 * The two checkpoint types a traveller may report. A subset of 2992's CHECK
 * vocabulary ('SECURITY','IMMIGRATION','CUSTOMS','GATE','LOUNGE',
 * 'LANDSIDE_EXIT','AIRPORT_REENTRY','BOARDING'): the other six need either an
 * airport model this tree does not have (which security? which gate?) or are
 * the close itself (BOARDING is "I made my flight").
 */
export const TRAVELLER_CHECKPOINT_TYPES = ["LANDSIDE_EXIT", "AIRPORT_REENTRY"] as const;
export type TravellerCheckpointType = (typeof TRAVELLER_CHECKPOINT_TYPES)[number];

/** How long after the scheduled departure a checkpoint stays visible to reads (2992: "a filter, not a retention promise"). */
export const CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN = 6 * 60;

export interface LayoverCheckpoint {
  id: string;
  type: string;
  observedAt: string;
  source: string;
  confidence: string;
}

/** What the traveller has told us about where they are, from their own latest report. */
export type AirportPresence = "landside" | "airside" | "unreported";

export type CheckpointWrite =
  | { ok: true; checkpoint: LayoverCheckpoint; duplicate: boolean }
  | { ok: false; reason: "persistence_disabled" | "write_failed" };

export type CheckpointRead =
  | { ok: true; checkpoints: LayoverCheckpoint[] }
  | { ok: false; reason: "persistence_disabled" | "read_failed" };

const SELECT = "id, checkpoint_type, observed_at, source, confidence";

function toCheckpoint(r: Record<string, unknown>): LayoverCheckpoint {
  return {
    id: String(r.id),
    type: String(r.checkpoint_type),
    observedAt: String(r.observed_at),
    source: String(r.source),
    confidence: String(r.confidence),
  };
}

export function isTravellerCheckpointType(v: unknown): v is TravellerCheckpointType {
  return typeof v === "string" && (TRAVELLER_CHECKPOINT_TYPES as readonly string[]).includes(v);
}

/** 1–120 characters of the client's operation id; anything else is refused by the route. */
export function isOperationId(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 120;
}

/**
 * The latest report decides — newest `observed_at` first, never `received_at`,
 * so a delayed report cannot read as "now" (2992's own rule for this table).
 */
export function airportPresenceFrom(checkpoints: readonly LayoverCheckpoint[]): AirportPresence {
  let latest: LayoverCheckpoint | null = null;
  for (const c of checkpoints) {
    if (!latest || Date.parse(c.observedAt) > Date.parse(latest.observedAt)) latest = c;
  }
  if (!latest) return "unreported";
  if (latest.type === "LANDSIDE_EXIT") return "landside";
  if (latest.type === "AIRPORT_REENTRY") return "airside";
  return "unreported";
}

/**
 * The two outcome columns checkpoints can fill. `null` is NOT OBSERVED, and a
 * failed or disabled read is not observed: an outcome must never record
 * "did not leave the airport" because a table could not be read.
 */
export function observedReturnFrom(read: CheckpointRead): { leftAirport: boolean | null; actualAirportReturnAt: string | null } {
  if (!read.ok) return { leftAirport: null, actualAirportReturnAt: null };
  const exits = read.checkpoints.filter((c) => c.type === "LANDSIDE_EXIT").map((c) => Date.parse(c.observedAt));
  if (exits.length === 0) return { leftAirport: null, actualAirportReturnAt: null };
  const lastExit = Math.max(...exits);
  const returns = read.checkpoints
    .filter((c) => c.type === "AIRPORT_REENTRY" && Date.parse(c.observedAt) >= lastExit)
    .map((c) => Date.parse(c.observedAt));
  return {
    leftAirport: true,
    actualAirportReturnAt: returns.length > 0 ? new Date(Math.min(...returns)).toISOString() : null,
  };
}

export async function recordTravellerCheckpoint(
  db: SupabaseClient,
  args: {
    sessionId: string;
    type: TravellerCheckpointType;
    operationId: string;
    nowMs: number;
    departureTime: string;
  },
): Promise<CheckpointWrite> {
  if (!(await isFlagEnabled(db, "layover_decision_persistence_enabled"))) return { ok: false, reason: "persistence_disabled" };
  const dedupKey = `${args.type}:${args.operationId.trim()}`.slice(0, 200);
  const departureMs = Date.parse(args.departureTime);
  const expiresMs = Math.max(
    args.nowMs,
    Number.isFinite(departureMs) ? departureMs : args.nowMs,
  ) + CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN * 60_000;
  const row = {
    session_id: args.sessionId,
    checkpoint_type: args.type,
    observed_at: new Date(args.nowMs).toISOString(),
    source: "TRAVELLER",
    confidence: "MEDIUM",
    dedup_key: dedupKey,
    expires_at: new Date(expiresMs).toISOString(),
  };
  const { data, error } = await db
    .from("layover_checkpoints")
    .insert(row)
    .select(SELECT)
    .single();
  if (!error && data) return { ok: true, checkpoint: toCheckpoint(data as Record<string, unknown>), duplicate: false };

  // A replayed tap: the UNIQUE (session_id, dedup_key) refused the second row.
  // Answer the FIRST one rather than an error — and only if it can be read.
  if (error && (error as { code?: string }).code === "23505") {
    const { data: prior, error: priorErr } = await db
      .from("layover_checkpoints")
      .select(SELECT)
      .eq("session_id", args.sessionId)
      .eq("dedup_key", dedupKey)
      .maybeSingle();
    if (!priorErr && prior) return { ok: true, checkpoint: toCheckpoint(prior as Record<string, unknown>), duplicate: true };
  }
  logger.warn({ err: error, sessionId: args.sessionId, type: args.type }, "layover checkpoint write failed — not recorded");
  return { ok: false, reason: "write_failed" };
}

export async function readTravellerCheckpoints(
  db: SupabaseClient,
  sessionId: string,
  nowMs: number,
): Promise<CheckpointRead> {
  if (!(await isFlagEnabled(db, "layover_decision_persistence_enabled"))) return { ok: false, reason: "persistence_disabled" };
  const { data, error } = await db
    .from("layover_checkpoints")
    .select(SELECT)
    .eq("session_id", sessionId)
    .gt("expires_at", new Date(nowMs).toISOString())
    .order("observed_at", { ascending: false })
    .limit(50);
  if (error) {
    logger.warn({ err: error, sessionId }, "layover checkpoints unreadable — refusing rather than reporting none");
    return { ok: false, reason: "read_failed" };
  }
  return { ok: true, checkpoints: ((data ?? []) as Record<string, unknown>[]).map(toCheckpoint) };
}
