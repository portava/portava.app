/**
 * Refresh the generated live-columns module used by the api-server
 * schema-drift guard tests.
 *
 * Queries information_schema.columns (table_schema='public') on the LIVE
 * Supabase database via the Supabase Management API and writes the result to
 *   artifacts/api-server/src/test/generated/liveColumns.json
 *
 * Run:  pnpm --filter @workspace/scripts run refresh:live-columns
 *
 * Requires env: SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) and
 * SUPABASE_ACCESS_TOKEN (Management API token).
 *
 * The drift tests read the JSON through
 * artifacts/api-server/src/test/helpers/liveColumns.ts, which fails loudly
 * (pointing at this command) if the generated file is missing or a table is
 * absent.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(
  __dir, "..", "..", "artifacts", "api-server", "src", "test", "generated",
  "liveColumns.json",
);

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

if (!supabaseUrl || !accessToken) {
  console.error("refresh-live-columns: SUPABASE_URL and SUPABASE_ACCESS_TOKEN are required.");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];

const SQL = `
  select table_name, column_name
  from information_schema.columns
  where table_schema = 'public'
  order by table_name, column_name
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: SQL }),
});

if (!res.ok) {
  console.error(`refresh-live-columns: Management API query failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const rows = (await res.json()) as Array<{ table_name: string; column_name: string }>;

if (!Array.isArray(rows) || rows.length === 0) {
  console.error("refresh-live-columns: query returned no rows — refusing to write an empty column list.");
  process.exit(1);
}

const tables: Record<string, string[]> = {};
for (const { table_name, column_name } of rows) {
  (tables[table_name] ??= []).push(column_name);
}

const payload = {
  $comment:
    "GENERATED FILE — do not edit by hand. Live public-schema columns fetched " +
    "from Supabase (information_schema.columns). Refresh with: " +
    "pnpm --filter @workspace/scripts run refresh:live-columns",
  // WHICH database this describes. The snapshot went ~6 weeks stale without
  // anyone noticing, and the reason it stayed unnoticed is that the file said
  // "live" without saying live WHERE: with two projects in the org, a reader
  // could not tell whether a missing column meant the schema lacked it or the
  // snapshot came from the other database. Recording the ref makes a snapshot
  // regenerated against the wrong project visible in the diff.
  projectRef: ref,
  generatedAt: new Date().toISOString(),
  tables,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n");
console.log(
  `refresh-live-columns: wrote ${Object.keys(tables).length} tables ` +
  `(${rows.length} columns) to ${OUT_PATH}`,
);
