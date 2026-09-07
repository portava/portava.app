/**
 * mediaSchemaCapability — the fail-closed schema-capability guard for the
 * canonical media writer (spec §6).
 *
 * THE FAILURE THIS CLOSES
 * =======================
 * `recordMediaAssetDetailed` names three columns that migration 2250 adds
 * (`captured_at`, `provenance`, `intelligence_eligibility`). Production has
 * never had 2250 applied: measured 2026-09-07, `media_assets` there has 23
 * columns against CI's 27, and a rolled-back INSERT with the writer's exact
 * column list fails with SQLSTATE 42703 `column "captured_at" of relation
 * "media_assets" does not exist`. Through PostgREST the same rejection is
 * PGRST204. `media_canonical_enabled` is TRUE there, so the writer RUNS on
 * every upload, is rejected on every upload, and — until the warn log was
 * added — said nothing. Eight rows written 2026-07-25 → 2026-08-16, then
 * nothing, for three weeks.
 *
 * A log line on failure is the floor, not the guard. The guard is: DO NOT
 * ENTER THE WRITE PATH AT ALL when the database cannot take the payload, say so
 * at error level, and make the refusal legible to the caller — so the wrong
 * thing (a write that vanishes) cannot happen while the owner decides what to
 * do about the flag and the migration.
 *
 * HOW IT DECIDES
 * ==============
 * One probe per client per TTL: a SELECT naming exactly the 2250 columns,
 * filtered to the nil UUID so it can never return a row. PostgREST answers
 * `data: null, error: null` when every column exists and 42703 / PGRST204 when
 * one does not. Three verdicts:
 *
 *   present  — every 2250 column answered. The write path may run.
 *   missing  — a column is absent. REFUSE. `missingColumns` names what the
 *              probe could establish (PostgREST reports the first unknown
 *              column only, so this is a floor, and the full 2250 list is what
 *              the owner must apply).
 *   unknown  — the probe failed for some other reason (network, auth, RLS, a
 *              fake without the method). REFUSE. A guard that lets a write
 *              through because it could not check is not a guard.
 *
 * `present` is cached for CANONICAL_SCHEMA_PRESENT_TTL_MS; `missing` and
 * `unknown` for the much shorter CANONICAL_SCHEMA_ABSENT_TTL_MS, so a freshly
 * applied migration is picked up within a minute without a restart and a
 * broken database is not hammered once per upload.
 *
 * The reactive path feeds the same memo: when a write that the probe let
 * through is nonetheless rejected for a missing column (PostgREST's schema
 * cache can lag a DDL by a moment), `markCanonicalSchemaMissing` flips the
 * memo so the NEXT call is refused before any write.
 *
 * WHAT THIS DOES NOT DO
 * =====================
 * It does not touch the flag, does not apply anything, does not retry, and
 * does not decide whether the owner should apply 2250 or turn the flag off.
 * It makes the pending decision safe by making the dead-writer path
 * unreachable and loud.
 */
import { logger } from "../logger.js";

/** The `media_assets` columns migration 2250 adds. Nothing before it does. */
export const CANONICAL_ASSET_SCHEMA_COLUMNS = [
  "captured_at",
  "location_visibility",
  "provenance",
  "intelligence_eligibility",
] as const;

/** A row id that cannot exist, so the probe can never return a user row. */
export const CANONICAL_SCHEMA_PROBE_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

export const CANONICAL_SCHEMA_PRESENT_TTL_MS = 5 * 60 * 1000;
export const CANONICAL_SCHEMA_ABSENT_TTL_MS = 30 * 1000;

export type CanonicalSchemaState = "present" | "missing" | "unknown";

export interface CanonicalSchemaVerdict {
  state: CanonicalSchemaState;
  /** Columns the probe (or a rejected write) established as absent. A floor. */
  missingColumns: string[];
  /** The driver's error code when the verdict is not `present`. */
  errorCode: string | null;
  /** Epoch ms at which this verdict was reached. */
  checkedAt: number;
  /** True when this call served a cached verdict rather than probing. */
  cached: boolean;
}

/**
 * True when a Supabase/PostgREST error means "this database does not have that
 * column", as opposed to any other failure. Two shapes, two layers:
 *   • PostgREST schema cache — code `PGRST204`, message
 *     `Could not find the 'captured_at' column of 'media_assets' in the schema cache`
 *   • PostgreSQL itself — SQLSTATE `42703`, message
 *     `column "captured_at" of relation "media_assets" does not exist`
 * PURE. Never throws on a malformed error object.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as any).code ?? "");
  if (code === "PGRST204" || code === "42703") return true;
  const msg = String((error as any).message ?? "").toLowerCase();
  return (
    msg.includes("in the schema cache") ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

/**
 * Pull the column name out of a missing-column error message, when the driver
 * put one there. Returns the 2250 columns it names, or [] when it names none
 * we recognise. PURE.
 */
export function missingColumnsNamedBy(error: unknown): string[] {
  const msg = String((error as any)?.message ?? "");
  return CANONICAL_ASSET_SCHEMA_COLUMNS.filter((c) => msg.includes(c));
}

interface MemoEntry {
  verdict: CanonicalSchemaVerdict;
}

const memo = new WeakMap<object, MemoEntry>();

function ttlFor(state: CanonicalSchemaState): number {
  return state === "present" ? CANONICAL_SCHEMA_PRESENT_TTL_MS : CANONICAL_SCHEMA_ABSENT_TTL_MS;
}

function fresh(entry: MemoEntry | undefined, now: number): CanonicalSchemaVerdict | null {
  if (!entry) return null;
  const v = entry.verdict;
  if (now - v.checkedAt > ttlFor(v.state)) return null;
  return { ...v, cached: true };
}

/** Keys we have memoised, so reset can drop them (WeakMap is not iterable). */
const tracked = new Set<object>();

/** Forget every memoised verdict. Tests only. */
export function resetCanonicalSchemaMemo(): void {
  for (const k of tracked) memo.delete(k);
  tracked.clear();
}

function remember(sc: object, verdict: CanonicalSchemaVerdict): CanonicalSchemaVerdict {
  memo.set(sc, { verdict });
  tracked.add(sc);
  return verdict;
}

/**
 * The cached verdict for this client, or null when none is fresh. Never
 * probes. For health/observability readers that must not contact the DB.
 */
export function peekCanonicalSchemaState(sc: object, now: number = Date.now()): CanonicalSchemaVerdict | null {
  return fresh(memo.get(sc), now);
}

/**
 * Record, from a rejected write, that the schema is missing at least one 2250
 * column. Idempotent. The next `probeCanonicalAssetSchema` for this client is
 * served from this memo (for CANONICAL_SCHEMA_ABSENT_TTL_MS) without a probe.
 */
export function markCanonicalSchemaMissing(
  sc: object,
  error: unknown,
  now: number = Date.now(),
): CanonicalSchemaVerdict {
  const named = missingColumnsNamedBy(error);
  return remember(sc, {
    state: "missing",
    missingColumns: named,
    errorCode: String((error as any)?.code ?? "") || null,
    checkedAt: now,
    cached: false,
  });
}

/**
 * Establish whether `media_assets` in the database behind `sc` carries every
 * column migration 2250 adds. Memoised per client; see the header for TTLs.
 *
 * NEVER THROWS. Any failure that is not a recognisable missing-column error is
 * `unknown`, which callers must treat exactly like `missing`: refuse.
 */
export async function probeCanonicalAssetSchema(
  sc: any,
  opts: { now?: number; force?: boolean } = {},
): Promise<CanonicalSchemaVerdict> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const hit = fresh(memo.get(sc), now);
    if (hit) return hit;
  }
  try {
    const { error } = await sc
      .from("media_assets")
      .select(CANONICAL_ASSET_SCHEMA_COLUMNS.join(", "))
      .eq("id", CANONICAL_SCHEMA_PROBE_SENTINEL_ID)
      .maybeSingle();
    if (!error) {
      return remember(sc, {
        state: "present",
        missingColumns: [],
        errorCode: null,
        checkedAt: now,
        cached: false,
      });
    }
    const code = String((error as any)?.code ?? "") || null;
    if (isMissingColumnError(error)) {
      const verdict = remember(sc, {
        state: "missing",
        missingColumns: missingColumnsNamedBy(error),
        errorCode: code,
        checkedAt: now,
        cached: false,
      });
      logger.error(
        { err: error, missingColumns: verdict.missingColumns, required: CANONICAL_ASSET_SCHEMA_COLUMNS },
        "media_assets is MISSING migration-2250 columns — canonical media writes are REFUSED until 2250 is applied to this database",
      );
      return verdict;
    }
    const verdict = remember(sc, {
      state: "unknown",
      missingColumns: [],
      errorCode: code,
      checkedAt: now,
      cached: false,
    });
    logger.error(
      { err: error },
      "media_assets schema probe failed — canonical media writes are REFUSED (fail-closed) until the probe succeeds",
    );
    return verdict;
  } catch (err) {
    const verdict = remember(sc, {
      state: "unknown",
      missingColumns: [],
      errorCode: null,
      checkedAt: now,
      cached: false,
    });
    logger.error(
      { err },
      "media_assets schema probe threw — canonical media writes are REFUSED (fail-closed) until the probe succeeds",
    );
    return verdict;
  }
}
