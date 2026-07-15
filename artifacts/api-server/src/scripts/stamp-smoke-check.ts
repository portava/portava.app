/**
 * Stamp system production smoke check
 *
 * Verifies that the stamp_system_v2_enabled feature-flag row and the expected
 * stamp_definitions rows are present in the production Supabase database.
 *
 * Usage:
 *   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     node --import tsx/esm src/scripts/stamp-smoke-check.ts
 *
 * Exit code 0 → all checks passed
 * Exit code 1 → one or more checks failed (details printed to stdout)
 *
 * In CI / pre-release, this can be wired into scripts/pre-release-check.sh
 * alongside the existing db-triggers check.
 */

import { createClient } from "@supabase/supabase-js";

const REQUIRED_FLAG_SLUG = "stamp_system_v2_enabled";

const REQUIRED_DEFINITION_SLUGS = [
  "first_trip_completed",
  "solo_traveler",
  "international_voyager",
  "weekend_wanderer",
  "long_haul",
  "globe_trotter_5",
  "globe_trotter_10",
] as const;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n" +
      "       Run from artifacts/api-server with the .env loaded, or export them manually.",
  );
  process.exit(1);
}

const sc = createClient(url, key, {
  auth: { persistSession: false },
});

// ── Checks ─────────────────────────────────────────────────────────────────────

let failed = false;

function pass(msg: string) { console.log(`  ✔ ${msg}`); }
function fail(msg: string) { console.error(`  ✖ ${msg}`); failed = true; }

// 1. feature_flags row
console.log("\n[1] Checking feature_flags.stamp_system_v2_enabled …");
{
  const { data, error } = await sc
    .from("feature_flags")
    .select("flag, enabled")
    .eq("flag", REQUIRED_FLAG_SLUG)
    .maybeSingle();

  if (error) {
    fail(`DB error querying feature_flags: ${error.message}`);
  } else if (!data) {
    fail(`Row missing: flag='${REQUIRED_FLAG_SLUG}' not found in feature_flags`);
    console.error("       → Apply migration 0081 (creates stamp_system_v2_enabled flag).");
  } else if (!data.enabled) {
    fail(`Flag exists but is disabled (enabled=false). Enable it when ready to launch stamps.`);
  } else {
    pass(`feature_flags.${REQUIRED_FLAG_SLUG} = enabled`);
  }
}

// 2. stamp_definitions rows
console.log("\n[2] Checking stamp_definitions rows …");
{
  const { data, error } = await sc
    .from("stamp_definitions")
    .select("slug, is_active")
    .in("slug", [...REQUIRED_DEFINITION_SLUGS]);

  if (error) {
    fail(`DB error querying stamp_definitions: ${error.message}`);
  } else {
    const found = new Set((data ?? []).map((r: any) => r.slug));
    for (const slug of REQUIRED_DEFINITION_SLUGS) {
      if (!found.has(slug)) {
        fail(`stamp_definitions missing slug='${slug}'`);
      } else {
        const row = (data ?? []).find((r: any) => r.slug === slug);
        if (!row?.is_active) {
          fail(`stamp_definitions '${slug}' exists but is_active=false`);
        } else {
          pass(`stamp_definitions '${slug}' present and active`);
        }
      }
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("");
if (failed) {
  console.error("Stamp smoke check FAILED. See above for details.");
  process.exit(1);
} else {
  console.log("Stamp smoke check PASSED. Production DB is ready for stamp awards.");
  process.exit(0);
}
