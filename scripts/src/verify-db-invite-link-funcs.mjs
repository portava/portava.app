/**
 * verify-db-invite-link-funcs.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the INVITE_LINK_FUNCS_RESPONSE environment variable and
 * verifies that the PostgreSQL functions and table introduced by migrations
 * 0109–0111 are all present in the production database.
 *
 * Required objects:
 *   function  claim_invite_link_slot         (migration 0109)
 *   function  release_invite_link_slot        (migration 0109)
 *   table     trip_invite_link_attempts       (migration 0110)
 *   function  claim_invite_link_slot_for_user (migration 0110)
 *   function  reconcile_invite_link_slots     (migration 0111)
 *
 * Called by scripts/check-db-triggers.sh.
 *
 * Exit codes:
 *   0  all five objects confirmed
 *   1  one or more objects missing or response is malformed
 */

const REQUIRED = [
  { type: "function", name: "claim_invite_link_slot",         migration: "0109" },
  { type: "function", name: "release_invite_link_slot",       migration: "0109" },
  { type: "table",    name: "trip_invite_link_attempts",      migration: "0110" },
  { type: "function", name: "claim_invite_link_slot_for_user",migration: "0110" },
  { type: "function", name: "reconcile_invite_link_slots",    migration: "0111" },
];

const raw = process.env.INVITE_LINK_FUNCS_RESPONSE ?? "";

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

const present = new Set(rows.map((r) => r.name));

let allPresent = true;
for (const { type, name, migration } of REQUIRED) {
  if (present.has(name)) {
    console.log("  \u2714  " + type + " " + name + " (migration " + migration + ")");
  } else {
    console.error("  \u2718  MISSING " + type + ": " + name + " (migration " + migration + ")");
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error("     One or more invite-link slot functions or tables are absent from production.");
  console.error("     Apply the missing migrations via the Supabase SQL editor:");
  console.error("       artifacts/api-server/src/migrations/0109_claim_invite_link_slot.sql");
  console.error("       artifacts/api-server/src/migrations/0110_invite_link_idempotency.sql");
  console.error("       artifacts/api-server/src/migrations/0111_reconcile_invite_slots.sql");
  console.error("     Without these, POST /api/trips/invite-link/:token/accept returns a DB error");
  console.error("     and POST /api/admin/trips/reconcile-invite-slots cannot fix stranded slots.");
  process.exit(1);
}
