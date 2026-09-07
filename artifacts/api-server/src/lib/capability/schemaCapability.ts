/**
 * schemaCapability — the runtime half of the capability contract.
 *
 *   capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY
 *
 * See `schemaRequirement.ts` for the contract and why the requirement set is a
 * registry. This file answers the two runtime questions:
 *
 *   1. Is the schema this capability needs PRESENT in the database behind
 *      this client?                         → probeSchemaReadiness
 *   2. May the code behind this flag run?   → resolveCapability / requireCapability
 *
 * HOW READINESS IS PROBED — one round trip per (client, capability) per TTL
 * ========================================================================
 * For each required table: a SELECT naming exactly the required columns,
 * filtered to a sentinel the key cannot hold, so it can never return a row.
 * PostgREST answers `error: null` when every column exists; PGRST204 / 42703
 * when a column is absent; PGRST205 / 42P01 when the table is. That is the
 * same probe `lib/media/mediaSchemaCapability.ts` shipped for `media_assets`,
 * which this module now implements.
 *
 * `ready` is memoised for READY_TTL_MS, `missing` and `unknown` for the much
 * shorter ABSENT_TTL_MS, per client object (a WeakMap, so a test client is
 * collected with its test). A freshly applied migration is therefore picked
 * up within ABSENT_TTL_MS without a restart, and a broken database is not
 * re-probed on every request. There is no startup probe: readiness is a
 * property of the database, not the process, and a process that probed once
 * at boot would keep a stale verdict across the very DDL it is waiting for.
 *
 * FAIL-CLOSED, WITHOUT EXCEPTION
 * ==============================
 * Three verdicts, two of which refuse:
 *   ready    — every required object answered. The guarded path may run.
 *   missing  — an object is absent. REFUSE.
 *   unknown  — the probe failed for any other reason (network, auth, RLS, a
 *              fake without the method, a thrown builder). REFUSE. A guard
 *              that lets a write through because it could not check is not a
 *              guard.
 * The flag read is held to the same standard: `off`, `absent` and
 * `unreadable` all resolve to `enabled: false`. Nothing in this file can
 * return `enabled: true` on a failure path.
 *
 * LOUD, WITHOUT EXCEPTION
 * =======================
 * A flag that is ON over a schema that is not ready is the exact state that
 * lost three weeks of media writes. It is logged at ERROR on every probe that
 * finds it and on every refusal, naming the capability, the objects that are
 * missing, and the migration that provides them. `requireCapability` goes one
 * further and THROWS a 503 `degraded_unavailable` (retryable) so a route
 * cannot answer an empty 200 for a feature its operator believes is on.
 */
import { logger } from "../logger.js";
import type { ApiErrorCode } from "../http.js";
import {
  SCHEMA_PROBE_SENTINEL_ID,
  type CapabilityDefinition,
  type CapabilityVerdict,
  type FlagState,
  type SchemaReadiness,
  type SchemaReadinessState,
} from "./schemaRequirement.js";

export const READY_TTL_MS = 5 * 60 * 1000;
export const ABSENT_TTL_MS = 30 * 1000;

// ── Error classification (pure) ──────────────────────────────────────────────

/**
 * True when a Supabase/PostgREST error means "this database does not have
 * that column". Two layers, two shapes:
 *   • PostgREST schema cache — PGRST204,
 *     `Could not find the 'captured_at' column of 'media_assets' in the schema cache`
 *   • PostgreSQL — SQLSTATE 42703,
 *     `column "captured_at" of relation "media_assets" does not exist`
 * PURE. Never throws on a malformed error object.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as any).code ?? "");
  if (code === "PGRST204" || code === "42703") return true;
  const msg = String((error as any).message ?? "").toLowerCase();
  return (
    (msg.includes("in the schema cache") && msg.includes("column")) ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

/**
 * True when the error means "this database does not have that table".
 *   • PostgREST — PGRST205, `Could not find the table 'public.x' in the schema cache`
 *   • PostgreSQL — 42P01, `relation "x" does not exist`
 * PURE.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as any).code ?? "");
  if (code === "PGRST205" || code === "42P01") return true;
  const msg = String((error as any).message ?? "").toLowerCase();
  return (
    (msg.includes("in the schema cache") && msg.includes("table")) ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

/** Either of the above: the database lacks a required object. PURE. */
export function isMissingSchemaError(error: unknown): boolean {
  return isMissingColumnError(error) || isMissingTableError(error);
}

/**
 * The required objects a missing-schema error names, as `table` /
 * `table.column`. PostgREST names one column per rejection, so this is a
 * floor. PURE.
 */
export function missingObjectsNamedBy(
  def: CapabilityDefinition,
  error: unknown,
  table?: string,
): string[] {
  const msg = String((error as any)?.message ?? "");
  const out: string[] = [];
  const tables = table ? [table] : Object.keys(def.requires.tables);
  for (const t of tables) {
    const req = def.requires.tables[t];
    if (!req) continue;
    if (isMissingTableError(error) && !isMissingColumnError(error) && msg.includes(t)) {
      out.push(t);
      continue;
    }
    for (const c of req.columns) {
      if (msg.includes(`'${c}'`) || msg.includes(`"${c}"`) || msg.includes(` ${c} `)) {
        out.push(`${t}.${c}`);
      }
    }
  }
  return out;
}

// ── Memo ─────────────────────────────────────────────────────────────────────

const memo = new WeakMap<object, Map<string, SchemaReadiness>>();
/** Keys we have memoised, so reset can drop them (a WeakMap is not iterable). */
const tracked = new Set<object>();

function ttlFor(state: SchemaReadinessState): number {
  return state === "ready" ? READY_TTL_MS : ABSENT_TTL_MS;
}

function fresh(sc: object, flag: string, now: number): SchemaReadiness | null {
  const v = memo.get(sc)?.get(flag);
  if (!v) return null;
  if (now - v.checkedAt > ttlFor(v.state)) return null;
  return { ...v, cached: true };
}

function remember(sc: object, v: SchemaReadiness): SchemaReadiness {
  let m = memo.get(sc);
  if (!m) {
    m = new Map();
    memo.set(sc, m);
    tracked.add(sc);
  }
  m.set(v.capability, v);
  return v;
}

/** Forget every memoised verdict, for every capability. Tests only. */
export function resetSchemaCapabilityMemo(): void {
  for (const k of tracked) memo.delete(k);
  tracked.clear();
}

/**
 * The memoised verdict for this client and capability, or null when none is
 * fresh. NEVER probes — for health/observability readers that must not
 * contact the database.
 */
export function peekSchemaReadiness(
  sc: object,
  def: CapabilityDefinition,
  now: number = Date.now(),
): SchemaReadiness | null {
  return fresh(sc, def.flag, now);
}

/**
 * Record, from a rejected write, that the schema is missing at least one
 * required object. The next probe for this client is served from the memo
 * (for ABSENT_TTL_MS) and REFUSES without a round trip. This is the reactive
 * feed: PostgREST's schema cache can lag a DDL, so a write the probe let
 * through can still be rejected, and that rejection is evidence.
 */
export function markSchemaMissing(
  sc: object,
  def: CapabilityDefinition,
  error: unknown,
  now: number = Date.now(),
): SchemaReadiness {
  const v = remember(sc, {
    capability: def.flag,
    state: "missing",
    missing: missingObjectsNamedBy(def, error),
    errorCode: String((error as any)?.code ?? "") || null,
    checkedAt: now,
    cached: false,
  });
  logger.error(
    { capability: def.flag, err: error, missing: v.missing, providedBy: def.providedBy },
    `capability ${def.flag}: a write was rejected for a required object AFTER the probe passed — memo flipped to missing; the path is REFUSED until the probe succeeds again. Apply ${def.providedBy.join(", ")}.`,
  );
  return v;
}

// ── The probe ────────────────────────────────────────────────────────────────

/**
 * Establish whether the database behind `sc` carries every table and column
 * `def.requires` names. Memoised per client; see the header for TTLs.
 *
 * NEVER THROWS. Any failure that is not a recognisable missing-schema error
 * is `unknown`, which callers must treat exactly like `missing`: refuse.
 */
export async function probeSchemaReadiness(
  sc: any,
  def: CapabilityDefinition,
  opts: { now?: number; force?: boolean } = {},
): Promise<SchemaReadiness> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const hit = fresh(sc, def.flag, now);
    if (hit) return hit;
  }

  const missing: string[] = [];
  let firstMissingCode: string | null = null;

  for (const [table, req] of Object.entries(def.requires.tables)) {
    const probe = req.probe ?? { column: "id", value: SCHEMA_PROBE_SENTINEL_ID };
    const selectList = req.columns.length > 0 ? req.columns.join(", ") : probe.column;
    let error: unknown = null;
    try {
      const res = await sc
        .from(table)
        .select(selectList)
        .eq(probe.column, probe.value)
        .maybeSingle();
      error = res?.error ?? null;
      // A resolved call with no `error` field at all is NOT success: a fake
      // that returns `undefined`, or a transport that answered nothing, has
      // not established anything. Only an explicit `error: null` counts.
      if (!res || !("error" in res)) {
        return refuseUnknown(sc, def, now, null, new Error(`probe of ${table} resolved without an error field`));
      }
    } catch (err) {
      return refuseUnknown(sc, def, now, null, err);
    }
    if (!error) continue;
    const code = String((error as any)?.code ?? "") || null;
    if (isMissingSchemaError(error)) {
      const named = missingObjectsNamedBy(def, error, table);
      missing.push(...(named.length ? named : [table]));
      firstMissingCode ??= code;
      continue;
    }
    return refuseUnknown(sc, def, now, code, error);
  }

  if (missing.length === 0) {
    return remember(sc, {
      capability: def.flag,
      state: "ready",
      missing: [],
      errorCode: null,
      checkedAt: now,
      cached: false,
    });
  }
  const v = remember(sc, {
    capability: def.flag,
    state: "missing",
    missing,
    errorCode: firstMissingCode,
    checkedAt: now,
    cached: false,
  });
  logger.error(
    { capability: def.flag, missing: v.missing, errorCode: v.errorCode, providedBy: def.providedBy },
    `capability ${def.flag}: the database is MISSING required schema — the guarded path is REFUSED until ${def.providedBy.join(", ")} is applied to this database`,
  );
  return v;
}

function refuseUnknown(
  sc: any,
  def: CapabilityDefinition,
  now: number,
  code: string | null,
  err: unknown,
): SchemaReadiness {
  const v = remember(sc, {
    capability: def.flag,
    state: "unknown",
    missing: [],
    errorCode: code,
    checkedAt: now,
    cached: false,
  });
  logger.error(
    { capability: def.flag, err, errorCode: code, providedBy: def.providedBy },
    `capability ${def.flag}: schema probe failed — the guarded path is REFUSED (fail-closed) until the probe succeeds`,
  );
  return v;
}

// ── Flag && schema ───────────────────────────────────────────────────────────

/**
 * Read the flag row as FOUR states, not two. `isFlagEnabled` collapses
 * off/absent/unreadable into `false`; that is the right answer for "may I
 * run" but it hides WHY, and an operator told "disabled" when the row is
 * unreadable will look in the wrong place. NEVER throws; never returns `on`
 * on any failure path.
 */
export async function readFlagState(sc: any, flag: string): Promise<FlagState> {
  try {
    const res = await sc.from("feature_flags").select("enabled").eq("flag", flag).maybeSingle();
    if (!res || !("error" in res) || res.error) return "unreadable";
    if (res.data == null) return "absent";
    return res.data.enabled === true ? "on" : "off";
  } catch {
    return "unreadable";
  }
}

/**
 * THE contract: `enabled` iff the flag is `on` AND the schema is `ready`.
 * The schema is not probed for a flag that is not on — a dark feature makes
 * no database contact beyond the flag read. Every refusal of an ON flag is
 * logged at ERROR: that combination is the defect, and silence is how it
 * lasted three weeks.
 */
export async function resolveCapability(
  sc: any,
  def: CapabilityDefinition,
  opts: { now?: number } = {},
): Promise<CapabilityVerdict> {
  const flag = await readFlagState(sc, def.flag);
  if (flag !== "on") {
    if (flag === "unreadable") {
      logger.warn({ capability: def.flag }, `capability ${def.flag}: feature_flags row is UNREADABLE — treated as off (fail-closed)`);
    }
    return {
      capability: def.flag,
      enabled: false,
      flag,
      schema: null,
      reason: flag === "off" ? "flag_off" : flag === "absent" ? "flag_absent" : "flag_unreadable",
    };
  }
  const schema = await probeSchemaReadiness(sc, def, opts);
  if (schema.state === "ready") {
    return { capability: def.flag, enabled: true, flag, schema, reason: null };
  }
  logger.error(
    {
      capability: def.flag,
      schemaState: schema.state,
      missing: schema.missing,
      errorCode: schema.errorCode,
      providedBy: def.providedBy,
    },
    `capability ${def.flag} is ON but its schema is ${schema.state === "missing" ? "ABSENT" : "UNVERIFIABLE"} — REFUSED, nothing ran. ${def.note} Apply ${def.providedBy.join(", ")} or turn the flag off.`,
  );
  return {
    capability: def.flag,
    enabled: false,
    flag,
    schema,
    reason: schema.state === "missing" ? "schema_missing" : "schema_unknown",
  };
}

/**
 * Thrown by `requireCapability` when the flag is ON and the schema is not
 * ready. Carries `status`/`code` the global error handler reads, so an
 * Express 5 route that lets it propagate answers 503 `degraded_unavailable`
 * (retryable) — never an empty 200 for a feature the operator believes is on.
 */
export class CapabilityUnavailableError extends Error {
  readonly status: number = 503;
  readonly code: ApiErrorCode = "degraded_unavailable";
  readonly verdict: CapabilityVerdict;
  constructor(verdict: CapabilityVerdict) {
    const s = verdict.schema;
    super(
      `capability ${verdict.capability} is enabled but its schema is ${s?.state ?? "unknown"}` +
        (s && s.missing.length ? ` (missing: ${s.missing.join(", ")})` : "") +
        ` — refusing to run`,
    );
    this.name = "CapabilityUnavailableError";
    this.verdict = verdict;
  }
}

/**
 * For routes and services with a caller to answer. Returns the verdict when
 * the flag is not on (the caller answers `feature_disabled` as it always did)
 * or when everything is ready; THROWS `CapabilityUnavailableError` when the
 * flag is on and the schema is not. The throw is the loud part: a refusal
 * that returns a value can be dropped by `void f()`, and that is the original
 * bug wearing a new name.
 */
export async function requireCapability(
  sc: any,
  def: CapabilityDefinition,
  opts: { now?: number } = {},
): Promise<CapabilityVerdict> {
  const v = await resolveCapability(sc, def, opts);
  if (v.flag === "on" && !v.enabled) throw new CapabilityUnavailableError(v);
  return v;
}
