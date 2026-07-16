/**
 * Generic startup schema-drift check.
 *
 * Production databases have repeatedly drifted from the migrations directory
 * (columns that a migration should have added are missing on the live
 * schema).  Historically each incident got its own hand-written startup
 * probe in index.ts; this module replaces those with a single declarative
 * list of critical { table, column } pairs.  Every pair is probed with a
 * `select <column> ... limit 1` and ALL missing columns are reported in one
 * consolidated warning naming the migration to apply.
 *
 * SQL functions that must exist can also be declared (probed via rpc()).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

export interface ColumnProbe {
  table: string;
  column: string;
  /** Migration file (in src/migrations/) that introduces the column. */
  migration: string;
  /** Short description of what breaks while the column is missing. */
  impact: string;
}

export interface FunctionProbe {
  fn: string;
  args: Record<string, unknown>;
  migration: string;
  impact: string;
}

/**
 * Error codes that indicate the probed column (or its table) does not exist
 * on the live schema:
 *   42703    — undefined column (Postgres)
 *   42P01    — undefined table (Postgres)
 *   PGRST100 — PostgREST could not parse the select (unknown column)
 *   PGRST204 — PostgREST schema cache does not know the column
 *   PGRST205 — PostgREST schema cache does not know the table
 */
const MISSING_CODES = new Set([
  "42703",
  "42P01",
  "PGRST100",
  "PGRST204",
  "PGRST205",
]);

/** SQL function does not exist. */
const MISSING_FUNCTION_CODES = new Set(["42883", "PGRST202"]);

/**
 * Critical table/column pairs that production has drifted on before (or
 * that recent migrations introduce and routes hard-depend on).
 */
export const CRITICAL_COLUMNS: ColumnProbe[] = [
  {
    table: "profiles",
    column: "passport_section_order",
    migration: "0120_passport_section_order.sql",
    impact: "passport layout saves fail",
  },
  {
    table: "trip_crew_location_sessions",
    column: "status",
    migration: "(no migration adds this column yet — live-share cleanup expects it)",
    impact: "live-share cleanup job fails every sweep",
  },
  {
    table: "user_account_states",
    column: "updated_at",
    migration: "0130_user_account_states_updated_at.sql",
    impact: "account deactivate/reactivate fails",
  },
  {
    table: "passport_visibility_preferences",
    column: "default_stamp_visibility",
    migration: "0132_passport_visibility_prefs_columns.sql",
    impact: "passport visibility preference saves fail",
  },
  {
    table: "rent_buddy_profiles",
    column: "available_now",
    migration: "0133_rent_buddy_availability_alignment.sql",
    impact: "buddy availability settings fail to save",
  },
  {
    table: "buddy_availability_exceptions",
    column: "exception_date",
    migration: "0133_rent_buddy_availability_alignment.sql",
    impact: "bookings are not blocked on vacation/blocked dates",
  },
];

/** SQL functions routes hard-depend on. */
export const CRITICAL_FUNCTIONS: FunctionProbe[] = [
  {
    fn: "toggle_feature_flag_with_audit",
    args: {
      p_flag: "__startup_probe__",
      p_new_enabled: false,
      p_changed_by_id: "00000000-0000-0000-0000-000000000000",
    },
    migration: "0119_toggle_flag_atomic.sql",
    impact: "PATCH /admin/feature-flags/:flag returns 503",
  },
];

export interface SchemaDriftResult {
  missingColumns: ColumnProbe[];
  missingFunctions: FunctionProbe[];
}

export interface CachedSchemaDriftResult extends SchemaDriftResult {
  /** ISO timestamp of when the check that produced this result ran. */
  checkedAt: string;
}

// Last completed check result (startup or on-demand). Lets the admin health
// endpoint answer cheaply without re-probing the live schema every request.
let lastResult: CachedSchemaDriftResult | null = null;

/** Result of the most recent schema-drift check, or null if none has run. */
export function getCachedSchemaDriftResult(): CachedSchemaDriftResult | null {
  return lastResult;
}

/** Test-only: reset the cached result. */
export function _resetSchemaDriftCache(): void {
  lastResult = null;
}

/**
 * Probes every declared column and function against the live schema and
 * logs ONE consolidated warning naming everything that is missing plus the
 * migration to apply.  Probe transport errors are logged individually at
 * warn level but never throw.
 */
export async function runSchemaDriftCheck(
  client: Pick<SupabaseClient, "from" | "rpc">,
  logger: Logger,
  columns: ColumnProbe[] = CRITICAL_COLUMNS,
  functions: FunctionProbe[] = CRITICAL_FUNCTIONS,
): Promise<SchemaDriftResult> {
  const missingColumns: ColumnProbe[] = [];
  const missingFunctions: FunctionProbe[] = [];

  await Promise.all([
    ...columns.map(async (probe) => {
      try {
        const { error } = await client
          .from(probe.table)
          .select(probe.column)
          .limit(1);
        if (error && MISSING_CODES.has(error.code ?? "")) {
          missingColumns.push(probe);
        }
      } catch (err) {
        logger.warn(
          { err, table: probe.table, column: probe.column },
          "schema drift check: probe failed",
        );
      }
    }),
    ...functions.map(async (probe) => {
      try {
        const { error } = await client.rpc(probe.fn, probe.args);
        if (error && MISSING_FUNCTION_CODES.has(error.code ?? "")) {
          missingFunctions.push(probe);
        }
      } catch (err) {
        logger.warn(
          { err, fn: probe.fn },
          "schema drift check: function probe failed",
        );
      }
    }),
  ]);

  if (missingColumns.length > 0 || missingFunctions.length > 0) {
    const columnLines = missingColumns.map(
      (p) =>
        `${p.table}.${p.column} (apply ${p.migration}; until then: ${p.impact})`,
    );
    const functionLines = missingFunctions.map(
      (p) => `${p.fn}() (apply ${p.migration}; until then: ${p.impact})`,
    );
    logger.warn(
      { missing: [...columnLines, ...functionLines] },
      `startup: schema drift detected — ${
        missingColumns.length + missingFunctions.length
      } missing database object(s); apply the named migrations`,
    );
  } else {
    logger.info("startup: schema drift check passed — all critical columns present");
  }

  lastResult = {
    missingColumns,
    missingFunctions,
    checkedAt: new Date().toISOString(),
  };
  return { missingColumns, missingFunctions };
}
