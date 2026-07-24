/**
 * set-flags.mjs — idempotent feature-flag flipper for the feature_flags table.
 *
 * Usage (from artifacts/api-server):
 *   ENABLE=true  node scripts/set-flags.mjs country_essentials_enabled budget_fx_conversion_enabled
 *   ENABLE=false node scripts/set-flags.mjs country_essentials_enabled   # rollback
 *
 * Rules:
 *  - Reads the row first; exits non-zero if the row is missing (refuses to create).
 *  - Prints old → new for each flag.
 *  - Exits non-zero if any DB call fails.
 *  - ENABLE env defaults to "true". Pass ENABLE=false to roll back.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in environment.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const flags = process.argv.slice(2);
if (flags.length === 0) {
  console.error("Usage: ENABLE=true node scripts/set-flags.mjs <flag1> [flag2 …]");
  process.exit(1);
}

const enableStr = (process.env.ENABLE ?? "true").toLowerCase().trim();
if (enableStr !== "true" && enableStr !== "false") {
  console.error(`ERROR: ENABLE must be 'true' or 'false', got '${enableStr}'`);
  process.exit(1);
}
const targetValue = enableStr === "true";

const sc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

let anyFailed = false;

for (const flag of flags) {
  // Read existing row first — refuse to create if missing.
  const { data: existing, error: readErr } = await sc
    .from("feature_flags")
    .select("flag, enabled")
    .eq("flag", flag)
    .maybeSingle();

  if (readErr) {
    console.error(`  ✖ [${flag}] DB read error: ${readErr.message}`);
    anyFailed = true;
    continue;
  }

  if (!existing) {
    console.error(
      `  ✖ [${flag}] Row not found in feature_flags. Refusing to create. ` +
      `Check that migrations 0177–0184 have been applied.`
    );
    anyFailed = true;
    continue;
  }

  const oldValue = existing.enabled;

  if (oldValue === targetValue) {
    console.log(`  ─ [${flag}] already ${targetValue} — no change.`);
    continue;
  }

  const { error: updateErr } = await sc
    .from("feature_flags")
    .update({ enabled: targetValue })
    .eq("flag", flag);

  if (updateErr) {
    console.error(`  ✖ [${flag}] DB update error: ${updateErr.message}`);
    anyFailed = true;
    continue;
  }

  console.log(`  ✔ [${flag}] ${oldValue} → ${targetValue}`);
}

if (anyFailed) {
  console.error("\nset-flags: one or more flags failed — see above.");
  process.exit(1);
}
console.log("\nset-flags: done.");
