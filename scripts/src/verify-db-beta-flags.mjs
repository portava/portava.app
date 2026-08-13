/**
 * verify-db-beta-flags.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the BETA_FLAGS_RESPONSE environment variable and verifies
 * that all kill-switch and feature-gate rows seeded by migration
 * 0117_beta_feature_flags.sql exist in the feature_flags table.
 *
 * Required flags (seeded by 0117):
 *   Kill switches  — disable_signups, disable_posting, disable_messaging,
 *                    disable_rent_buddy_booking, invite_only_beta
 *   Feature gates  — compass_ai_enabled
 *
 * city_launch_mode was required here until 2087_retire_city_launch_mode.sql
 * retired it (owner ruling 2026-08-13; see docs/ops/flag-disposition.md).
 *
 * Without these rows the kill switches always fail-open (feature allowed),
 * meaning an admin setting disable_posting = TRUE in the DB has no effect
 * because the row never existed to read.
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  all required flag rows are present
 *   1  one or more rows missing, or response malformed
 */

const MIGRATION =
  "artifacts/api-server/src/migrations/0117_beta_feature_flags.sql";

const REQUIRED_FLAGS = [
  "disable_signups",
  "disable_posting",
  "disable_messaging",
  "disable_rent_buddy_booking",
  "invite_only_beta",
  "compass_ai_enabled",
];

const raw = process.env.BETA_FLAGS_RESPONSE ?? "";

let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error(
    "  \u2718  Could not parse beta-flags check response as JSON:"
  );
  console.error("     " + raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error(
    "  \u2718  Unexpected response shape from beta-flags check:"
  );
  console.error("     " + JSON.stringify(rows).slice(0, 200));
  process.exit(1);
}

const foundFlags = new Set(rows.map((r) => r.flag));

let allPresent = true;

for (const flag of REQUIRED_FLAGS) {
  if (foundFlags.has(flag)) {
    const row = rows.find((r) => r.flag === flag);
    console.log(
      `  \u2714  feature_flags.${flag} = ${row?.enabled}`
    );
  } else {
    console.error(
      `  \u2718  MISSING feature flag: ${flag} not found in feature_flags table`
    );
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     One or more beta kill-switch / feature-gate flags are absent from production."
  );
  console.error(
    "     Without them the kill switches always fail-open (feature allowed)."
  );
  console.error(
    "     Apply the migration via the Supabase SQL editor or psql:"
  );
  console.error("       " + MIGRATION);
  console.error(
    "     Verify with:"
  );
  console.error(
    "       SELECT flag, enabled FROM feature_flags"
  );
  console.error(
    "         WHERE flag IN ('disable_posting','disable_messaging','disable_signups',"
  );
  console.error(
    "                        'invite_only_beta','compass_ai_enabled',"
  );
  console.error(
    "                        'disable_rent_buddy_booking');"
  );
  process.exit(1);
}
