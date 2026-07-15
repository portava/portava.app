/**
 * verify-db-rent-buddy-rollout.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the RENT_BUDDY_ROLLOUT_RESPONSE environment variable and
 * verifies that:
 *   • rent_buddy_global_controls exists with RLS enabled and the correct
 *     columns (id, all_bookings_paused, applications_paused, cash_balance_paused,
 *     nightlife_paused, force_full_in_app, force_public_meetup, force_delayed_posting)
 *   • rent_buddy_city_rollouts exists with RLS enabled and both expected
 *     policies: rb_rollout_svc (service role) and rb_rollout_public_read (public)
 *
 * Both tables are created by migration 0090_rent_buddy_rollout_tables.sql.
 * Without them every call to checkRentBuddyAccess returns city_not_available,
 * effectively disabling rent-a-buddy entirely.
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  both tables confirmed present with expected RLS configuration
 *   1  table missing, RLS disabled, policy absent, or response malformed
 */

const MIGRATION =
  "artifacts/api-server/src/migrations/0090_rent_buddy_rollout_tables.sql";

const raw = process.env.RENT_BUDDY_ROLLOUT_RESPONSE ?? "";

let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error(
    "  \u2718  Could not parse rent_buddy rollout check response as JSON:"
  );
  console.error("     " + raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error(
    "  \u2718  Unexpected response shape from rent_buddy rollout check:"
  );
  console.error("     " + JSON.stringify(rows).slice(0, 200));
  process.exit(1);
}

let allPresent = true;

const gcTableRow = rows.find((r) => r.check_type === "table_global_controls");
const crTableRow = rows.find((r) => r.check_type === "table_city_rollouts");
const gcColumns  = rows.filter((r) => r.check_type === "col_global_controls");
const policyRows = rows.filter((r) => r.check_type === "policy");

// ── rent_buddy_global_controls ───────────────────────────────────────────────

if (!gcTableRow) {
  console.error(
    "  \u2718  MISSING table: rent_buddy_global_controls does not exist in the public schema"
  );
  allPresent = false;
} else {
  const rlsEnabled =
    gcTableRow.detail === "true" || gcTableRow.detail === true;
  if (rlsEnabled) {
    console.log("  \u2714  table rent_buddy_global_controls exists (RLS enabled)");
  } else {
    console.error(
      "  \u2718  table rent_buddy_global_controls exists but RLS is NOT enabled"
    );
    allPresent = false;
  }
}

const REQUIRED_GC_COLS = [
  "all_bookings_paused",
  "applications_paused",
  "cash_balance_paused",
  "nightlife_paused",
  "force_full_in_app",
  "force_public_meetup",
  "force_delayed_posting",
];

if (gcTableRow) {
  const foundCols = new Set(gcColumns.map((r) => r.name));
  for (const col of REQUIRED_GC_COLS) {
    if (foundCols.has(col)) {
      console.log(`  \u2714  column rent_buddy_global_controls.${col} present`);
    } else {
      console.error(
        `  \u2718  MISSING column: rent_buddy_global_controls.${col}`
      );
      allPresent = false;
    }
  }
}

// ── rent_buddy_city_rollouts ─────────────────────────────────────────────────

if (!crTableRow) {
  console.error(
    "  \u2718  MISSING table: rent_buddy_city_rollouts does not exist in the public schema"
  );
  allPresent = false;
} else {
  const rlsEnabled =
    crTableRow.detail === "true" || crTableRow.detail === true;
  if (rlsEnabled) {
    console.log(
      "  \u2714  table rent_buddy_city_rollouts exists (RLS enabled)"
    );
  } else {
    console.error(
      "  \u2718  table rent_buddy_city_rollouts exists but RLS is NOT enabled"
    );
    allPresent = false;
  }
}

const foundPolicies = new Set(policyRows.map((r) => r.name));
for (const policy of ["rb_rollout_public_read", "rb_rollout_svc"]) {
  if (foundPolicies.has(policy)) {
    console.log(
      `  \u2714  RLS policy: ${policy} on rent_buddy_city_rollouts`
    );
  } else {
    console.error(
      `  \u2718  MISSING RLS policy: ${policy} on rent_buddy_city_rollouts`
    );
    allPresent = false;
  }
}

// ── feature_flags.rent_buddy_enabled ────────────────────────────────────────

const flagRow = rows.find((r) => r.check_type === "feature_flag");
if (!flagRow) {
  console.error(
    "  \u2718  MISSING feature flag: rent_buddy_enabled not found in feature_flags table"
  );
  allPresent = false;
} else {
  const enabled = flagRow.detail === "true" || flagRow.detail === true;
  if (enabled) {
    console.log("  \u2714  feature_flags.rent_buddy_enabled = true");
  } else {
    console.error(
      "  \u2718  feature_flags.rent_buddy_enabled is FALSE — Rent a Buddy is globally disabled"
    );
    console.error(
      "     Run: UPDATE feature_flags SET enabled = TRUE WHERE flag = 'rent_buddy_enabled';"
    );
    allPresent = false;
  }
}

// ── live city count ──────────────────────────────────────────────────────────
// At least one city must be at public_mvp or beta_testing status before the
// feature is usable.  An empty table means every checkRentBuddyAccess call
// returns city_not_available regardless of the feature flag.

const liveCityRow = rows.find((r) => r.check_type === "live_city_count");
if (!liveCityRow) {
  console.error(
    "  \u2718  live city count query missing — check SQL in check-db-triggers.sh"
  );
  allPresent = false;
} else {
  const count = parseInt(liveCityRow.name ?? "0", 10);
  if (count >= 1) {
    console.log(
      `  \u2714  rent_buddy_city_rollouts has ${count} live city/cities (public_mvp or beta_testing)`
    );
  } else {
    console.error(
      "  \u2718  rent_buddy_city_rollouts has NO cities at public_mvp or beta_testing status"
    );
    console.error(
      "     Rent a Buddy is deployed but invisible — all access checks return city_not_available."
    );
    console.error(
      "     Apply the seed migration via the Supabase dashboard or psql:"
    );
    console.error(
      "       artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql"
    );
    console.error(
      "     Or insert manually (see docs/production-migration-runbook.md \u00a79.7):"
    );
    console.error(
      "       INSERT INTO rent_buddy_city_rollouts (city, country, status)"
    );
    console.error(
      "         VALUES ('Cebu', 'Philippines', 'public_mvp')"
    );
    console.error(
      "         ON CONFLICT (city) DO NOTHING;"
    );
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     The rent_buddy rollout tables are absent or misconfigured in production."
  );
  console.error(
    "     Without them every checkRentBuddyAccess call returns city_not_available."
  );
  console.error(
    "     Apply the missing migration via the Supabase dashboard or psql:"
  );
  console.error("       " + MIGRATION);
  console.error(
    "     Then seed launch cities:"
  );
  console.error(
    "       artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql"
  );
  console.error(
    "     See docs/production-migration-runbook.md \u00a79.7 for the full seeding runbook."
  );
  process.exit(1);
}
