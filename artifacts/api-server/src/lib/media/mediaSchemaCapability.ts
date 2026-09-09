/**
 * mediaSchemaCapability — the fail-closed schema-capability guard for the
 * canonical media writer (spec §6), now the media-specific face of the
 * generic contract in `lib/capability/`.
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
 * WHAT MOVED, AND WHAT DID NOT
 * ============================
 * The probe, the memo, the TTLs and the three verdicts now live in
 * `lib/capability/schemaCapability.ts`, parameterised by the registry entry
 * `MEDIA_CANONICAL` (`lib/capability/registry.ts`), so the next flag in this
 * state gets the same guard by declaration rather than by copy. This file
 * keeps the media-shaped API `lib/mediaAssets.ts` consumes — `present` /
 * `missing` / `unknown`, `missingColumns` as bare column names — so the
 * consumer and its tests are unchanged. It adds nothing of its own: every
 * function here is a rename over the generic one.
 *
 * WHAT THIS DOES NOT DO
 * =====================
 * It does not touch the flag, does not apply anything, does not retry, and
 * does not decide whether the owner should apply 2250 or turn the flag off.
 * It makes the pending decision safe by making the dead-writer path
 * unreachable and loud.
 */
import {
  ABSENT_TTL_MS,
  READY_TTL_MS,
  isMissingColumnError as isMissingColumnErrorGeneric,
  markSchemaMissing,
  peekSchemaReadiness,
  probeSchemaReadiness,
  resetSchemaCapabilityMemo,
} from "../capability/schemaCapability.js";
import { MEDIA_CANONICAL, MEDIA_CANONICAL_ASSET_COLUMNS } from "../capability/registry.js";
import { SCHEMA_PROBE_SENTINEL_ID, type SchemaReadiness } from "../capability/schemaRequirement.js";

/** The `media_assets` columns migration 2250 adds. Nothing before it does. */
export const CANONICAL_ASSET_SCHEMA_COLUMNS = MEDIA_CANONICAL_ASSET_COLUMNS;

/** A row id that cannot exist, so the probe can never return a user row. */
export const CANONICAL_SCHEMA_PROBE_SENTINEL_ID = SCHEMA_PROBE_SENTINEL_ID;

export const CANONICAL_SCHEMA_PRESENT_TTL_MS = READY_TTL_MS;
export const CANONICAL_SCHEMA_ABSENT_TTL_MS = ABSENT_TTL_MS;

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
 * column" (PGRST204 / 42703 / the two message shapes). PURE. Never throws.
 */
export function isMissingColumnError(error: unknown): boolean {
  return isMissingColumnErrorGeneric(error);
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

/** `media_assets.captured_at` → `captured_at`; a bare `media_assets` → every 2250 column. */
function toMediaVerdict(v: SchemaReadiness): CanonicalSchemaVerdict {
  const cols = new Set<string>();
  for (const m of v.missing) {
    if (m === "media_assets") for (const c of CANONICAL_ASSET_SCHEMA_COLUMNS) cols.add(c);
    else if (m.startsWith("media_assets.")) cols.add(m.slice("media_assets.".length));
  }
  return {
    state: v.state === "ready" ? "present" : v.state,
    missingColumns: [...cols],
    errorCode: v.errorCode,
    checkedAt: v.checkedAt,
    cached: v.cached,
  };
}

/** Forget every memoised verdict. Tests only. */
export function resetCanonicalSchemaMemo(): void {
  resetSchemaCapabilityMemo();
}

/**
 * The cached verdict for this client, or null when none is fresh. Never
 * probes. For health/observability readers that must not contact the DB.
 */
export function peekCanonicalSchemaState(sc: object, now: number = Date.now()): CanonicalSchemaVerdict | null {
  const v = peekSchemaReadiness(sc, MEDIA_CANONICAL, now);
  return v ? toMediaVerdict(v) : null;
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
  return toMediaVerdict(markSchemaMissing(sc, MEDIA_CANONICAL, error, now));
}

/**
 * Establish whether `media_assets` in the database behind `sc` carries every
 * column migration 2250 adds. Memoised per client; see the generic module for
 * TTLs.
 *
 * NEVER THROWS. Any failure that is not a recognisable missing-column error is
 * `unknown`, which callers must treat exactly like `missing`: refuse.
 */
export async function probeCanonicalAssetSchema(
  sc: any,
  opts: { now?: number; force?: boolean } = {},
): Promise<CanonicalSchemaVerdict> {
  return toMediaVerdict(await probeSchemaReadiness(sc, MEDIA_CANONICAL, opts));
}
