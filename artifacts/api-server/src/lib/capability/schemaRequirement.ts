/**
 * The capability contract — types only, no I/O.
 *
 *   capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY
 *
 * A feature flag row saying `enabled = true` is a STATEMENT OF INTENT. It is
 * not evidence that the code behind the flag can run: that code names tables,
 * columns and functions which arrive by migration, and production is far behind
 * the tree (measured 2026-09-07: of the 2330-2490 band, ONE migration's marker
 * is present in production). `media_canonical_enabled` was TRUE in production
 * for three weeks while `media_assets` lacked the four columns migration 2250
 * adds; every write was rejected with PGRST204 and every rejection was
 * swallowed by `if (error) return null`. Enabled, dead, silent.
 *
 * This module is the shape of the fix generalised. A capability DECLARES the
 * schema it needs. The flag alone never answers "may this run"; the declaration
 * plus a probe of the live database does, and the answer is fail-closed:
 * unknown readiness is NOT ready.
 *
 * WHERE THE REQUIREMENT SET LIVES — a registry, not the flag's call site
 * ======================================================================
 * `registry.ts` is the one place. The alternative — each module declaring its
 * requirement next to its own flag read — drifts silently: nothing can
 * enumerate the declarations without importing every runtime module, so the
 * CI ratchet (`scripts/checkFlagSchemaPrerequisites.ts`) could not compare
 * declarations against the production snapshot, and a declaration that quietly
 * stopped matching the code it guards would go unnoticed. A registry can be
 * read by the ratchet without executing anything, cross-checked against the
 * flag reads the ratchet finds in the tree, and cross-checked against the
 * production snapshot. A registry entry without a consumer is itself a test
 * failure (`capabilityRegistry.test.ts`): a capability nobody consults is the
 * producer-without-consumer mistake this repository already has too many of.
 */

/** A row id that cannot exist, so a probe never returns a user row. */
export const SCHEMA_PROBE_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * What one table must provide. `columns` is the list a probe SELECTs by name;
 * an empty list means "the table must exist" and the probe selects nothing
 * but the sentinel column.
 *
 * `probe` overrides the filter the probe pins to. The default is
 * `id = SCHEMA_PROBE_SENTINEL_ID`, which is right for every uuid-keyed table
 * in this schema. A table keyed differently (a text slug, a bigint) needs a
 * filter its key can take, or PostgreSQL answers 22P02 — which the probe
 * classifies as `unknown` and therefore REFUSES, which is safe but wrong.
 */
export interface TableRequirement {
  readonly columns: readonly string[];
  readonly probe?: { readonly column: string; readonly value: string };
}

export interface SchemaRequirement {
  readonly tables: Readonly<Record<string, TableRequirement>>;
  /**
   * Functions the guarded path calls through `.rpc(...)`. CHECKED STATICALLY
   * ONLY (by the ratchet, against the production snapshot and the migrations).
   * They are deliberately not probed at runtime: PostgREST has no "does this
   * function exist" request — a POST to /rpc/<fn> with a mismatched signature
   * answers PGRST202 without executing, but a ZERO-ARGUMENT function would run.
   * A probe that can execute the writer it is checking for is not a probe.
   */
  readonly functions?: readonly string[];
}

export interface CapabilityDefinition {
  /** The feature_flags.flag row. Doubles as the capability id. */
  readonly flag: string;
  /**
   * The migration file(s) that supply the requirement. Named in every refusal
   * so the operator is told what to apply, not just that something is missing.
   */
  readonly providedBy: readonly string[];
  readonly requires: SchemaRequirement;
  /**
   * The modules that CONSULT this capability on the path that would otherwise
   * fail silently — paths relative to `src/`. Asserted non-empty and real by
   * `capabilityRegistry.test.ts`. A capability with no consumer reports
   * readiness to nobody and is exactly the mistake this contract exists to end.
   */
  readonly consumers: readonly string[];
  /** What refusing protects. Prose for the refusal log line. */
  readonly note: string;
}

export type SchemaReadinessState = "ready" | "missing" | "unknown";

export interface SchemaReadiness {
  readonly capability: string;
  readonly state: SchemaReadinessState;
  /**
   * Objects the probe (or a rejected write) established as absent, as
   * `table` or `table.column`. A FLOOR: PostgREST names the first unknown
   * column only, so the full requirement is what the owner must apply.
   */
  readonly missing: readonly string[];
  /** The driver's error code when the verdict is not `ready`. */
  readonly errorCode: string | null;
  /** Epoch ms at which this verdict was reached. */
  readonly checkedAt: number;
  /** True when this call served a memoised verdict rather than probing. */
  readonly cached: boolean;
}

export type FlagState = "on" | "off" | "absent" | "unreadable";

/**
 * The full answer to "may the code behind this flag run right now".
 * `enabled` is true ONLY when the flag is `on` AND the schema is `ready`.
 */
export interface CapabilityVerdict {
  readonly capability: string;
  readonly enabled: boolean;
  readonly flag: FlagState;
  /** null when the flag was not `on` — the schema is not probed for a dark flag. */
  readonly schema: SchemaReadiness | null;
  /** Machine-readable reason when `enabled` is false. */
  readonly reason:
    | null
    | "flag_off"
    | "flag_absent"
    | "flag_unreadable"
    | "schema_missing"
    | "schema_unknown";
}

/** Every column the requirement names, as `table.column`. Pure. */
export function requiredObjects(req: SchemaRequirement): string[] {
  const out: string[] = [];
  for (const [table, t] of Object.entries(req.tables)) {
    if (t.columns.length === 0) out.push(table);
    for (const c of t.columns) out.push(`${table}.${c}`);
  }
  for (const f of req.functions ?? []) out.push(`${f}()`);
  return out;
}
