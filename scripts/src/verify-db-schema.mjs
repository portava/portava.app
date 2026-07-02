/**
 * verify-db-schema.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the SCHEMA_RESPONSE environment variable and verifies that
 * the profile_emergency_contacts table (migration 0076) is present in the
 * public schema with RLS enabled and the two expected policies.
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  table confirmed present with RLS enabled and all required policies
 *   1  table missing, RLS disabled, policies absent, or response is malformed
 */

const REQUIRED_TABLE = "profile_emergency_contacts";
const REQUIRED_POLICIES = ["pec_own", "pec_svc"];

const raw = process.env.SCHEMA_RESPONSE ?? "";

let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error("  \u2718  Could not parse schema check response as JSON:");
  console.error("     " + raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error("  \u2718  Unexpected response shape from schema check:");
  console.error("     " + JSON.stringify(rows).slice(0, 200));
  process.exit(1);
}

const tableRow = rows.find((r) => r.check_type === "table");
const policyRows = rows.filter((r) => r.check_type === "policy");

let allPresent = true;

if (!tableRow) {
  console.error(
    "  \u2718  MISSING table: " +
      REQUIRED_TABLE +
      " does not exist in the public schema"
  );
  allPresent = false;
} else {
  const rlsEnabled =
    tableRow.detail === "true" || tableRow.detail === true;
  if (rlsEnabled) {
    console.log(
      "  \u2714  table " + REQUIRED_TABLE + " exists (RLS enabled)"
    );
  } else {
    console.error(
      "  \u2718  table " + REQUIRED_TABLE + " exists but RLS is NOT enabled"
    );
    allPresent = false;
  }
}

const foundPolicies = new Set(policyRows.map((r) => r.name));
for (const policy of REQUIRED_POLICIES) {
  if (foundPolicies.has(policy)) {
    console.log(
      "  \u2714  RLS policy: " + policy + " on " + REQUIRED_TABLE
    );
  } else {
    console.error(
      "  \u2718  MISSING RLS policy: " + policy + " on " + REQUIRED_TABLE
    );
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     The " +
      REQUIRED_TABLE +
      " table or its RLS policies are absent from production."
  );
  console.error(
    "     Apply the missing migration via the Supabase dashboard or psql:"
  );
  console.error(
    "       artifacts/api-server/migrations/0076_profile_emergency_contacts.sql"
  );
  process.exit(1);
}
