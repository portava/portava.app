/**
 * rehearsePostMediaRevocation — the CI rehearsal for migration 2089.
 *
 * WHAT THIS IS FOR
 * ----------------
 * 2089_revoke_post_media_public_read.sql drops one live storage policy. The
 * rehearsal runs that exact statement against the SANCTIONED CI PROJECT, with a
 * before-proof and an after-proof around it, so the production apply is a
 * repeat of something already executed rather than a first attempt.
 *
 * WHY A CI REHEARSAL IS MEANINGFUL HERE, AND WAS NOT FOR STEP 01
 * ---------------------------------------------------------------
 * auditStagingBoundaryGrant.ts had to state that a CI proof of ITS change would
 * be measuring residue: the two policies it dropped were declared by no
 * migration, so whether CI held them depended on what a previous run happened
 * to leave behind. That caveat does not apply to 2089.
 * post_media_storage_public_read is declared by 0103_post_media.sql, so any
 * project built from the migrations genuinely has it.
 *
 * "Genuinely has it" is still a claim about history, not about right now. So
 * this script does not assume it — phase `seed` ESTABLISHES the precondition
 * explicitly, and says whether it had to. A rehearsal that silently depended on
 * finding the policy already present would be measuring residue in exactly the
 * way Step 01 warned about, just with a better excuse.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * That production will behave identically. It proves the statement is valid,
 * that dropping this policy moves an anonymous caller from "can read and
 * enumerate" to "denied", and that signed-URL rendering is unaffected across
 * that transition. Production is a different project with different objects;
 * the production before/after proofs are run separately, against production,
 * with the same instrument.
 *
 * WRITE-CAPABLE, AND GUARDED ACCORDINGLY
 * --------------------------------------
 * This script CREATEs and DROPs a policy, so it imports the STRICT guard
 * (ciSupabaseGuard.mjs), not the read-only audit door. The strict guard permits
 * only the sanctioned CI project and refuses production unconditionally — there
 * is no variable that makes this script touch production, deliberately. The
 * production apply is a separate operator action outside this file.
 *
 * PHASES
 *   seed   ensure post_media_storage_public_read EXISTS (idempotent).
 *          Prints whether it created it or found it.
 *   apply  run the migration's statement: DROP POLICY IF EXISTS.
 *
 * EXIT CODES
 *   0  phase completed
 *   1  phase could not be completed
 *   2  environment / API error, or the guard refused
 *
 * USAGE
 *   node --import tsx/esm src/scripts/rehearsePostMediaRevocation.ts seed
 *   node --import tsx/esm src/scripts/rehearsePostMediaRevocation.ts apply
 */
import "../lib/ciSupabaseGuard.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and SUPABASE_PROJECT_TOKEN (or SUPABASE_ACCESS_TOKEN) must be set.",
  );
  process.exit(2);
}

const phase = process.argv[2];
if (phase !== "seed" && phase !== "apply") {
  console.error(`ERROR: phase must be 'seed' or 'apply', got: ${phase ?? "(none)"}`);
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
const POLICY = "post_media_storage_public_read";

/**
 * The policy body, captured verbatim from PRODUCTION pg_policies on 2026-08-14
 * and identical to the declaration in 0103_post_media.sql. Used by `seed` to
 * establish the precondition, and it is the same text as the migration's DOWN
 * block — if these ever disagree, the rollback is wrong.
 */
const POLICY_DDL = `
  CREATE POLICY "${POLICY}" ON storage.objects
    AS PERMISSIVE
    FOR SELECT
    TO public
    USING ((bucket_id = 'post-media'::text));
`;

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

async function policyExists(): Promise<boolean> {
  const rows = await liveQuery<{ n: number }>(
    `select count(*)::int as n from pg_policies
      where schemaname='storage' and tablename='objects' and policyname='${POLICY}'`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

console.log("═".repeat(74));
console.log(`REHEARSAL ${phase.toUpperCase()} — project ${projectRef}`);
console.log("═".repeat(74));

if (phase === "seed") {
  if (await policyExists()) {
    console.log(
      `\n  ${POLICY} was already present.\n` +
        `  Precondition already held — nothing created.\n`,
    );
  } else {
    console.log(
      `\n  ${POLICY} was ABSENT. Creating it to establish the before-state.\n\n` +
        `  This is not a workaround. The rehearsal must start from a project that\n` +
        `  demonstrably HAS the policy, or the "before" proof proves nothing and the\n` +
        `  drop that follows is a no-op dressed up as a change.\n`,
    );
    await liveQuery(POLICY_DDL);
    if (!(await policyExists())) {
      console.error(`❌ created ${POLICY} but it is still not present. Aborting.`);
      process.exit(1);
    }
    console.log(`  Created. Precondition now holds.\n`);
  }
  process.exit(0);
}

// phase === 'apply'
if (!(await policyExists())) {
  console.error(
    `\n❌ ${POLICY} is not present, so there is nothing to drop.\n` +
      `   Run the seed phase first. Applying to a project that never had the\n` +
      `   policy would produce a green run that tested nothing.\n`,
  );
  process.exit(1);
}

console.log(`\n  Running the statement from 2089_revoke_post_media_public_read.sql:\n`);
console.log(`    DROP POLICY IF EXISTS "${POLICY}" ON storage.objects;\n`);

await liveQuery(`
  BEGIN;
  DROP POLICY IF EXISTS "${POLICY}" ON storage.objects;
  COMMIT;
`);

if (await policyExists()) {
  console.error(`❌ dropped ${POLICY} but it is STILL present. Aborting.`);
  process.exit(1);
}

console.log(`  Applied. ${POLICY} is gone from ${projectRef}.\n`);
process.exit(0);
