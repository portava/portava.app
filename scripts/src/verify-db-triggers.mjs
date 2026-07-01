/**
 * verify-db-triggers.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the TRIGGER_RESPONSE environment variable and verifies that
 * the three DB protection triggers introduced in migrations 0071–0073 are
 * all present.
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  all three triggers confirmed
 *   1  one or more triggers missing or response is malformed
 */

const REQUIRED = [
  { name: "enforce_default_collection_no_delete", table: "collections" },
  { name: "block_collections_truncate", table: "collections" },
  { name: "block_collection_items_truncate", table: "collection_items" },
];

const raw = process.env.TRIGGER_RESPONSE ?? "";

let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error("  \u2718  Could not parse Management API response as JSON:");
  console.error("     " + raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error("  \u2718  Unexpected response shape from Management API:");
  console.error("     " + JSON.stringify(rows).slice(0, 200));
  process.exit(1);
}

const found = new Map(rows.map((r) => [r.trigger_name, r.event_object_table]));

let allPresent = true;
for (const { name, table } of REQUIRED) {
  if (found.has(name)) {
    console.log("  \u2714  " + name + " on " + found.get(name));
  } else {
    console.error("  \u2718  MISSING trigger: " + name + " (expected on " + table + ")");
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error("     One or more DB protection triggers are absent from production.");
  console.error("     Apply the missing migrations via the Supabase dashboard or psql:");
  console.error("       artifacts/api-server/src/migrations/0071_protect_default_collection.sql");
  console.error("       artifacts/api-server/src/migrations/0072_block_collections_truncate.sql");
  console.error("       artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql");
  process.exit(1);
}
