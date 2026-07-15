/**
 * verify-db-schema.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the SCHEMA_RESPONSE environment variable and verifies that a
 * specific table is present in the public schema with RLS enabled and all
 * expected policies.
 *
 * Parameterised via environment variables so the same verifier handles any
 * schema-presence check — pass TABLE/POLICIES/MIGRATION overrides alongside
 * SCHEMA_RESPONSE when invoking from check-db-triggers.sh.
 *
 * Environment variables (all optional — defaults check profile_emergency_contacts):
 *   SCHEMA_RESPONSE     Required. JSON array from the Supabase Management API.
 *   SCHEMA_TABLE        Table name to verify (default: profile_emergency_contacts)
 *   SCHEMA_POLICIES     Comma-separated list of required RLS policy names
 *                       (default: pec_own,pec_svc)
 *   SCHEMA_MIGRATION    Migration file path shown in the fix hint
 *                       (default: artifacts/api-server/migrations/0076_profile_emergency_contacts.sql)
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  table confirmed present with RLS enabled and all required policies
 *   1  table missing, RLS disabled, policies absent, or response is malformed
 */

const TABLE = process.env.SCHEMA_TABLE ?? "profile_emergency_contacts";
const POLICIES_RAW = process.env.SCHEMA_POLICIES ?? "pec_own,pec_svc";
const REQUIRED_POLICIES = POLICIES_RAW.split(",").map((p) => p.trim()).filter(Boolean);
const MIGRATION =
  process.env.SCHEMA_MIGRATION ??
  "artifacts/api-server/migrations/0076_profile_emergency_contacts.sql";

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
      TABLE +
      " does not exist in the public schema"
  );
  allPresent = false;
} else {
  const rlsEnabled =
    tableRow.detail === "true" || tableRow.detail === true;
  if (rlsEnabled) {
    console.log(
      "  \u2714  table " + TABLE + " exists (RLS enabled)"
    );
  } else {
    console.error(
      "  \u2718  table " + TABLE + " exists but RLS is NOT enabled"
    );
    allPresent = false;
  }
}

const foundPolicies = new Set(policyRows.map((r) => r.name));
for (const policy of REQUIRED_POLICIES) {
  if (foundPolicies.has(policy)) {
    console.log(
      "  \u2714  RLS policy: " + policy + " on " + TABLE
    );
  } else {
    console.error(
      "  \u2718  MISSING RLS policy: " + policy + " on " + TABLE
    );
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     The " +
      TABLE +
      " table or its RLS policies are absent from production."
  );
  console.error(
    "     Apply the missing migration via the Supabase dashboard or psql:"
  );
  console.error("       " + MIGRATION);
  process.exit(1);
}
