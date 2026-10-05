/**
 * LayoverConstraintStore — the read and the write of §4's `layover_constraints`
 * (migration 2992), and the two flags that decide whether either happens.
 *
 * I/O ONLY. What a constraint set MEANS is `services/airport/LayoverConstraints.ts`;
 * this module reads rows, appends rows, and attaches the result to a session.
 *
 * ── THE TWO FLAGS (both seeded FALSE by migration 3640) ─────────────────────
 *   layover_constraints_enabled
 *       ON  the declared set is read on every session load and a declaration
 *           appends a version. REQUIRES 2992 (and so 2700) applied: with the
 *           flag on and the table absent every read fails, which this module
 *           reports as `unreadable` and the engine reads as the cautious case —
 *           never as "nothing declared".
 *       OFF nothing here touches the table. A session loads exactly as it did.
 *   layover_entry_forbid_landside_enabled
 *       The OWNER's answer to §6.1 `entry_permission_state != CONFIRMED_ALLOWED
 *       ⇒ forbid landside`. OFF is today's behaviour. It rides on the same
 *       context because both are read once, at the instant the session is.
 *
 * ── THREE ANSWERS, NEVER TWO ────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. `declared`, `undeclared` and
 * `unreadable` are therefore three states here, as `SessionRead` is three for a
 * session: a failed read that came back as "undeclared" would hand the engine
 * the booleans on the row — the optimistic reading census L35 is about.
 *
 * ── ROWS ARE IMMUTABLE ──────────────────────────────────────────────────────
 * 2992 raises on UPDATE (`layover_snapshot_rows_are_immutable`). An edit is a
 * new version; this module issues no UPDATE and no DELETE against the table.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  isBaggageMode,
  type EntryPermissionState,
  type LayoverConstraintSet,
  type SessionConstraintContext,
} from "../airport/LayoverConstraints.js";

const logger = rootLogger.child({ service: "LayoverConstraintStore" });

export const CONSTRAINTS_TABLE = "layover_constraints";

/**
 * The two flag names, for callers that REPORT them (a route's disclosure, a
 * test). The two READS below spell the names as string literals at the call
 * site and must keep doing so: `check:flag-polarity` resolves a flag read only
 * when it can see the literal, and a read through this object would report both
 * flags as "seeded but never read".
 */
export const LAYOVER_CONSTRAINT_FLAGS = {
  /** Seeded FALSE by migration 3640. Needs 2992 applied before it is turned on. */
  storage: "layover_constraints_enabled",
  /** Seeded FALSE by migration 3640. Turning it ON is an owner decision. */
  entryForbidsLandside: "layover_entry_forbid_landside_enabled",
} as const;

export interface ConstraintFlags {
  storage: boolean;
  entryForbidsLandside: boolean;
}

/** Both flags, read together. Fail-closed: an unreadable flag is OFF. */
export async function readConstraintFlags(db: SupabaseClient): Promise<ConstraintFlags> {
  const [storage, entryForbidsLandside] = await Promise.all([
    isFlagEnabled(db, "layover_constraints_enabled"),
    isFlagEnabled(db, "layover_entry_forbid_landside_enabled"),
  ]);
  return { storage, entryForbidsLandside };
}

const COLUMNS = "session_id, version, baggage_mode, recheck_required, airport_change_required, created_at";

export type ConstraintRead =
  | { state: "declared"; set: LayoverConstraintSet }
  | { state: "undeclared" }
  | { state: "unreadable"; message: string };

function triState(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

/**
 * One row → one set, or `null` when the row cannot be trusted. A baggage mode
 * outside the vocabulary is not coerced to anything: the CHECK forbids it, so
 * seeing one means this build and the database disagree about the table.
 */
function rowToSet(row: Record<string, unknown>): LayoverConstraintSet | null {
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!isBaggageMode(row.baggage_mode)) return null;
  return {
    version,
    baggageMode: row.baggage_mode,
    recheckRequired: triState(row.recheck_required),
    airportChangeRequired: triState(row.airport_change_required),
    declaredAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

/** The latest declared set for one session. */
export async function readLatestConstraints(db: SupabaseClient, sessionId: string): Promise<ConstraintRead> {
  const { data, error } = await db
    .from("layover_constraints")
    .select(COLUMNS)
    .eq("session_id", sessionId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error, sessionId }, "layover constraints unreadable — the engine will take the cautious case, not 'nothing declared'");
    return { state: "unreadable", message: String(error.message ?? "layover_constraints unreadable") };
  }
  if (!data) return { state: "undeclared" };
  const set = rowToSet(data as Record<string, unknown>);
  if (!set) {
    logger.warn({ sessionId }, "layover constraints row is outside this build's vocabulary — treated as unreadable");
    return { state: "unreadable", message: "layover_constraints row not understood" };
  }
  return { state: "declared", set };
}

/** Upper bound on the batch read; see `readLatestConstraintsFor`. */
const BATCH_ROW_LIMIT = 500;

/**
 * The latest declared set for each of several sessions, in ONE statement.
 *
 * Rows arrive newest-version-first, so the first row seen per session is its
 * latest. If the statement returns exactly the row limit it may have been cut
 * short, and a session with no row in it is then `unreadable`, not
 * `undeclared`: "we did not see one" is only "there is none" when the whole
 * answer was read.
 */
export async function readLatestConstraintsFor(
  db: SupabaseClient,
  sessionIds: string[],
): Promise<Map<string, ConstraintRead>> {
  const out = new Map<string, ConstraintRead>();
  if (sessionIds.length === 0) return out;
  const { data, error } = await db
    .from("layover_constraints")
    .select(COLUMNS)
    .in("session_id", sessionIds)
    .order("version", { ascending: false })
    .limit(BATCH_ROW_LIMIT);
  if (error) {
    logger.warn({ err: error, count: sessionIds.length }, "layover constraints batch unreadable — every session takes the cautious case");
    for (const id of sessionIds) out.set(id, { state: "unreadable", message: String(error.message ?? "layover_constraints unreadable") });
    return out;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = String(row.session_id);
    if (out.has(id)) continue;
    const set = rowToSet(row);
    out.set(id, set ? { state: "declared", set } : { state: "unreadable", message: "layover_constraints row not understood" });
  }
  const truncated = rows.length >= BATCH_ROW_LIMIT;
  for (const id of sessionIds) {
    if (out.has(id)) continue;
    out.set(id, truncated ? { state: "unreadable", message: "layover_constraints batch truncated" } : { state: "undeclared" });
  }
  return out;
}

function contextOf(read: ConstraintRead, entryForbidsLandside: boolean): SessionConstraintContext {
  return {
    read: read.state,
    set: read.state === "declared" ? read.set : null,
    entryForbidsLandside,
  };
}

/**
 * Attach the constraint context to a loaded session.
 *
 * BOTH FLAGS OFF RETURNS THE SESSION ITSELF — the same object, with no
 * `constraints` key — so a response that serialises the session and a
 * certification that hashes its inputs are both exactly what they were.
 */
export async function attachConstraintContext<S extends { id: string }>(
  db: SupabaseClient,
  session: S,
): Promise<S & { constraints?: SessionConstraintContext }> {
  const flags = await readConstraintFlags(db);
  if (!flags.storage && !flags.entryForbidsLandside) return session;
  if (!flags.storage) {
    return { ...session, constraints: { read: "storage_off", set: null, entryForbidsLandside: true } };
  }
  return { ...session, constraints: contextOf(await readLatestConstraints(db, session.id), flags.entryForbidsLandside) };
}

/** `attachConstraintContext` for a list: two flag reads and at most one table read. */
export async function attachConstraintContexts<S extends { id: string }>(
  db: SupabaseClient,
  sessions: S[],
): Promise<Array<S & { constraints?: SessionConstraintContext }>> {
  if (sessions.length === 0) return sessions;
  const flags = await readConstraintFlags(db);
  if (!flags.storage && !flags.entryForbidsLandside) return sessions;
  if (!flags.storage) {
    return sessions.map((s) => ({ ...s, constraints: { read: "storage_off" as const, set: null, entryForbidsLandside: true } }));
  }
  const reads = await readLatestConstraintsFor(db, sessions.map((s) => s.id));
  return sessions.map((s) => ({
    ...s,
    constraints: contextOf(reads.get(s.id) ?? { state: "unreadable", message: "not read" }, flags.entryForbidsLandside),
  }));
}

export type ConstraintInsert =
  | { ok: true; set: LayoverConstraintSet }
  /** `(session_id, version)` is taken: another declaration landed first. */
  | { ok: false; reason: "version_conflict"; message: string }
  | { ok: false; reason: "write_failed"; message: string };

/**
 * Append one version. Never an UPDATE.
 *
 * `snapshotId`, `entryPermissionState` and `criticalUnknowns` describe the
 * computation this version was certified under — 2992 stores them WITH the set
 * so a row answers "what did the engine make of this declaration" without a
 * join. None of them is read back by a safety predicate.
 */
export async function insertConstraintVersion(
  db: SupabaseClient,
  row: {
    sessionId: string;
    set: LayoverConstraintSet;
    snapshotId: string | null;
    entryPermissionState: EntryPermissionState;
    criticalUnknowns: string[];
  },
): Promise<ConstraintInsert> {
  const { data, error } = await db
    .from("layover_constraints")
    .insert({
      session_id: row.sessionId,
      snapshot_id: row.snapshotId,
      version: row.set.version,
      baggage_mode: row.set.baggageMode,
      recheck_required: row.set.recheckRequired,
      airport_change_required: row.set.airportChangeRequired,
      entry_permission_state: row.entryPermissionState,
      critical_unknowns: row.criticalUnknowns,
    })
    .select(COLUMNS)
    .maybeSingle();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return { ok: false, reason: "version_conflict", message: String(error.message ?? "version already declared") };
    }
    logger.warn({ err: error, sessionId: row.sessionId, version: row.set.version }, "layover constraints insert failed — nothing was declared");
    return { ok: false, reason: "write_failed", message: String(error.message ?? "layover_constraints unwritable") };
  }
  const set = data ? rowToSet(data as Record<string, unknown>) : null;
  if (!set) {
    // The statement ran and handed back nothing readable. Reporting success on
    // that would be asserting a row this code has not seen.
    logger.warn({ sessionId: row.sessionId, version: row.set.version }, "layover constraints insert returned no readable row");
    return { ok: false, reason: "write_failed", message: "layover_constraints insert returned no row" };
  }
  return { ok: true, set };
}
