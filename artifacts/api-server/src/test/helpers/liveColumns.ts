/**
 * Loader for the generated live-schema column lists used by the
 * *SchemaDrift.test.ts guards.
 *
 * The data file (generated/liveColumns.json) is produced from the LIVE
 * Supabase database (information_schema.columns, table_schema='public') by:
 *
 *   pnpm --filter @workspace/scripts run refresh:live-columns
 *
 * This loader fails loudly — with that command in the message — if the
 * generated file is missing or a requested table is absent, so the drift
 * guards can never silently pass against stale/absent data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REFRESH_CMD = "pnpm --filter @workspace/scripts run refresh:live-columns";
const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dir, "..", "generated", "liveColumns.json");

type Generated = { generatedAt: string; tables: Record<string, string[]> };

let cached: Generated | null = null;

function load(): Generated {
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(DATA_PATH, "utf8");
  } catch {
    throw new Error(
      `liveColumns: generated file missing at ${DATA_PATH}. ` +
      `Regenerate it with: ${REFRESH_CMD}`,
    );
  }
  const parsed = JSON.parse(raw) as Generated;
  if (!parsed?.tables || Object.keys(parsed.tables).length === 0) {
    throw new Error(
      `liveColumns: generated file at ${DATA_PATH} is empty or malformed. ` +
      `Regenerate it with: ${REFRESH_CMD}`,
    );
  }
  cached = parsed;
  return parsed;
}

/** Returns the live column set for a public table; throws if the table is unknown. */
export function liveColumns(table: string): Set<string> {
  const { tables } = load();
  const cols = tables[table];
  if (!cols) {
    throw new Error(
      `liveColumns: table '${table}' not found in generated live schema. ` +
      `Either the table does not exist live, or the snapshot is stale — ` +
      `refresh with: ${REFRESH_CMD}`,
    );
  }
  return new Set(cols);
}

/** ISO timestamp of when the live snapshot was generated. */
export function liveColumnsGeneratedAt(): string {
  return load().generatedAt;
}
