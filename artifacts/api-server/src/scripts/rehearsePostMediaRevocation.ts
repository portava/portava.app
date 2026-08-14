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
 *   seed   ensure the three fixture buckets exist with production's public
 *          flags, upsert one 67-byte PNG into each, and ensure
 *          post_media_storage_public_read EXISTS. All idempotent; prints what
 *          it had to create. The fixtures are not decoration — the CI project
 *          has no media objects of its own, and without them the reachability
 *          probes have nothing to read and the rehearsal degrades to "the SQL
 *          parses". That was discovered by running this job, not predicted.
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

// ── Storage fixtures ────────────────────────────────────────────────────────
//
// WHY THIS IS HERE, discovered by the first run of this job rather than assumed.
//
// The CI project is built from the migrations, so it genuinely holds the
// POLICIES. It holds no OBJECTS: nobody uploads media to it. The first rehearsal
// run therefore reported "no objects in post-media — the exposure probe has
// nothing to read", and both controls that need a real object failed with -1.
// The audit script refused to report a pass, which is the correct behaviour and
// is why the gap was visible at all.
//
// Without fixtures the rehearsal could only prove the catalog half — policy
// present, DROP, policy absent — which is "the SQL parses", not "the SQL closes
// the hole". The reachability transition is the part worth rehearsing, so the
// seed phase creates exactly enough state for the probes to be meaningful:
// three buckets with production's public flags, and one tiny object in each.
//
// Everything here is idempotent and additive. The fixture objects are left in
// place between runs — they are 67 bytes each, they are the fixture, and
// deleting them would make the next run's before-proof fail for the same reason
// this one did.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const origin = new URL(SUPABASE_URL).origin;

/** 1x1 transparent PNG, 67 bytes. */
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** bucket → { public flag production uses, fixture object path }. */
const FIXTURE_BUCKETS: Array<{ id: string; isPublic: boolean; path: string }> = [
  { id: "post-media", isPublic: false, path: "ci-rehearsal/fixture.png" },
  { id: "profile-media", isPublic: false, path: "ci-rehearsal/fixture.png" },
  { id: "stamp-artwork", isPublic: true, path: "ci-rehearsal/fixture.png" },
];

async function ensureBucket(id: string, isPublic: boolean): Promise<void> {
  const get = await fetch(`${origin}/storage/v1/bucket/${id}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (get.ok) {
    console.log(`    bucket ${id.padEnd(14)} already exists`);
    return;
  }
  const create = await fetch(`${origin}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, name: id, public: isPublic }),
  });
  if (!create.ok) {
    throw new Error(`could not create bucket ${id}: ${create.status} ${await create.text()}`);
  }
  console.log(`    bucket ${id.padEnd(14)} CREATED (public=${isPublic})`);
}

async function ensureFixtureObject(bucket: string, path: string): Promise<void> {
  const res = await fetch(`${origin}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: new Uint8Array(FIXTURE_PNG),
  });
  if (!res.ok) {
    throw new Error(
      `could not upload fixture to ${bucket}/${path}: ${res.status} ${await res.text()}`,
    );
  }
  console.log(`    object ${(bucket + "/" + path).padEnd(38)} upserted`);
}

console.log("═".repeat(74));
console.log(`REHEARSAL ${phase.toUpperCase()} — project ${projectRef}`);
console.log("═".repeat(74));

if (phase === "seed") {
  if (!SERVICE_KEY) {
    console.error(
      "ERROR: SUPABASE_SERVICE_ROLE_KEY must be set — the seed phase uploads the\n" +
        "       fixture objects the reachability probes read.",
    );
    process.exit(2);
  }

  console.log("\n  Storage fixtures (idempotent):\n");
  for (const b of FIXTURE_BUCKETS) {
    await ensureBucket(b.id, b.isPublic);
    await ensureFixtureObject(b.id, b.path);
  }
  console.log("");

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
