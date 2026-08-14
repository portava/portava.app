/**
 * auditPostMediaPublicRead — the Unit C gate, as an instrument.
 *
 * WHY THIS EXISTS
 * ---------------
 * One live storage policy grants unauthenticated read over every object in the
 * durable `post-media` bucket:
 *
 *   post_media_storage_public_read   SELECT, TO public, USING (bucket_id = 'post-media')
 *
 * Declared by src/migrations/0103_post_media.sql, where the comment calls these
 * policies "defence-in-depth for clients that attempt direct bucket access".
 * That description was accurate when the bucket was public and every read went
 * through /object/public/ anyway. It stopped being accurate on 2026-08-06, when
 * 20260806_media_private_buckets.sql + set-media-buckets-private.ts set
 * public=false on post-media and profile-media and moved all rendering onto the
 * signed-URL relay.
 *
 * The cutover closed /object/public/. It did NOT drop this policy. So the
 * bucket is "private" in the sense that one URL shape 400s, and fully readable
 * in the sense that the RLS-governed object endpoint still serves every byte to
 * anyone holding the app's publishable key — a key that ships inside the mobile
 * client and is not a secret.
 *
 * This is the same shape as the memories/stories grant closed by
 * 20260815_close_memories_stories_grant.sql: the caller was fixed, the door was
 * left open. A read boundary enforced by "we stopped emitting that URL" is
 * bypassed by a GRANT, not by a bug, and no amount of relay hardening closes it.
 *
 * WHAT MAKES THIS PROVABLE (AND WHY THAT DIFFERS FROM STEP 01)
 * ------------------------------------------------------------
 * The Step 01 audit script had to explain that a CI red-proof would be
 * measuring residue, because those policies were declared by no migration.
 * That caveat does NOT apply here: post_media_storage_public_read IS declared,
 * in 0103_post_media.sql, so CI genuinely has it and a CI apply genuinely
 * removes it. Both a CI proof and a production proof are meaningful. This
 * script is written to run against either.
 *
 * The reachability probes below are the part that matters. A policy listing is
 * a claim about the catalog; an HTTP 200 returned to an anonymous caller is a
 * fact about exposure.
 *
 * CONTROLS — so a "denied" result cannot be a broken probe
 * --------------------------------------------------------
 *   NEGATIVE CONTROL  profile-media has ZERO storage.objects policies and is
 *                     already private. It is the exact state post-media is
 *                     being moved to, observable today. Anon read must DENY.
 *   POSITIVE CONTROL  stamp-artwork is public=true with its own public-read
 *                     policy. Anon read must SUCCEED. If this ever denies, the
 *                     probe is broken and every other result here is worthless.
 *   SIGNING CONTROL   a signed URL for a profile-media object — a bucket with
 *                     no read policy at all — must still fetch 200. This is the
 *                     load-bearing safety proof: it demonstrates that signing
 *                     and signed-URL fetch do not consult RLS, so dropping a
 *                     read policy cannot break the relay. profile-media is a
 *                     production existence proof, not a theory: the entire
 *                     avatar and cover surface renders through signing today
 *                     with no storage.objects policy backing it.
 *
 * READ-ONLY. Every statement is a SELECT; every HTTP call is a GET/LIST or a
 * signed-URL mint that writes nothing. It drops nothing. Applying the change is
 * a separate, deliberate migration.
 *
 * EXIT CODES
 *   0  BEFORE state: the policy is present, its body is captured, and the
 *      exposure is demonstrated. Safe to proceed with the migration.
 *   3  AFTER state: the policy is absent AND anon read/list are denied AND the
 *      signing control still passes. This is the success state post-apply.
 *   1  Neither: a control failed, or the catalog and the probes disagree.
 *      Fails closed — investigate before doing anything.
 *   2  environment / API error — cannot run.
 *
 * USAGE
 *   node --import tsx/esm src/scripts/auditPostMediaPublicRead.ts
 *
 * See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
const ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}
if (!ANON_KEY) {
  console.error(
    "ERROR: EXPO_PUBLIC_SUPABASE_ANON_KEY must be set. It is the credential the\n" +
      "       exposure probe uses — without it this script cannot measure the thing\n" +
      "       it exists to measure, and a pass would be vacuous.",
  );
  process.exit(2);
}
if (!SERVICE_KEY) {
  console.error(
    "ERROR: SUPABASE_SERVICE_ROLE_KEY must be set for the signing control.\n" +
      "       Without it the script cannot prove the relay survives the drop.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
const origin = new URL(SUPABASE_URL).origin;

const TARGET_POLICY = "post_media_storage_public_read";
const TARGET_BUCKET = "post-media";
const NEGATIVE_CONTROL_BUCKET = "profile-media";
const POSITIVE_CONTROL_BUCKET = "stamp-artwork";

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

interface PolicyRow {
  policyname: string;
  cmd: string;
  permissive: string;
  roles: string;
  qual: string | null;
  with_check: string | null;
}

let problems = 0;
const fail = (msg: string) => {
  problems++;
  console.error(`❌ ${msg}`);
};

/** Anonymous GET of one object through the RLS-governed object endpoint. */
async function anonRead(bucket: string, name: string): Promise<number> {
  const res = await fetch(
    `${origin}/storage/v1/object/${bucket}/${encodeURI(name)}`,
    { headers: { apikey: ANON_KEY!, Authorization: `Bearer ${ANON_KEY}` } },
  );
  return res.status;
}

/** Anonymous LIST of a bucket. Returns the number of entries returned. */
async function anonList(bucket: string): Promise<number> {
  const res = await fetch(`${origin}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY!,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefix: "", limit: 100 }),
  });
  if (!res.ok) return -1;
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) ? rows.length : -1;
}

/** Mint a signed URL with the service role and fetch it unauthenticated. */
async function signedFetch(bucket: string, name: string): Promise<number> {
  const signRes = await fetch(
    `${origin}/storage/v1/object/sign/${bucket}/${encodeURI(name)}`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY!,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 }),
    },
  );
  if (!signRes.ok) return -1;
  const { signedURL } = (await signRes.json()) as { signedURL: string };
  const res = await fetch(`${origin}/storage/v1${signedURL}`);
  return res.status;
}

async function sampleObject(bucket: string): Promise<string | null> {
  const rows = await liveQuery<{ name: string }>(
    `select name from storage.objects where bucket_id = '${bucket}' order by created_at limit 1`,
  );
  return rows[0]?.name ?? null;
}

// ── 1. Catalog: is the policy present, and what does it say? ─────────────────

const policies = await liveQuery<PolicyRow>(`
  select policyname, cmd, permissive, roles::text as roles, qual, with_check
    from pg_policies
   where schemaname = 'storage'
     and tablename  = 'objects'
   order by policyname
`);

const target = policies.find((p) => p.policyname === TARGET_POLICY);

console.log("═".repeat(74));
console.log(`UNIT C — post-media public-read grant  (project ${projectRef})`);
console.log("═".repeat(74));
console.log("\nAll storage.objects policies live right now:\n");
for (const p of policies) {
  console.log(`  ${p.policyname.padEnd(42)} ${p.cmd.padEnd(7)} ${p.roles}`);
}

if (target) {
  console.log("\n── THE ROLLBACK — captured verbatim from pg_policies ──────────────────\n");
  console.log(`CREATE POLICY "${target.policyname}" ON storage.objects`);
  console.log(`  AS ${target.permissive.toUpperCase()}`);
  console.log(`  FOR ${target.cmd}`);
  console.log(`  TO ${target.roles.replace(/[{}]/g, "")}`);
  console.log(`  USING (${target.qual});`);
  if (target.with_check) console.log(`  WITH CHECK (${target.with_check});`);
}

// ── 2. Reachability: what can an anonymous caller actually do? ───────────────

const postSample = await sampleObject(TARGET_BUCKET);
const profSample = await sampleObject(NEGATIVE_CONTROL_BUCKET);
const stampSample = await sampleObject(POSITIVE_CONTROL_BUCKET);

if (!postSample) {
  fail(
    `no objects in ${TARGET_BUCKET} — the exposure probe has nothing to read, so ` +
      `neither a pass nor a fail here would mean anything.`,
  );
}

const postRead = postSample ? await anonRead(TARGET_BUCKET, postSample) : -1;
const postList = await anonList(TARGET_BUCKET);
const profRead = profSample ? await anonRead(NEGATIVE_CONTROL_BUCKET, profSample) : -1;
const stampRead = stampSample
  ? await fetch(`${origin}/storage/v1/object/public/${POSITIVE_CONTROL_BUCKET}/${encodeURI(stampSample)}`).then((r) => r.status)
  : -1;
const signOk = profSample ? await signedFetch(NEGATIVE_CONTROL_BUCKET, profSample) : -1;

console.log("\n── REACHABILITY, measured with the app's publishable key ──────────────\n");
console.log(`  ${TARGET_BUCKET} anon GET object   HTTP ${postRead}`);
console.log(`  ${TARGET_BUCKET} anon LIST         ${postList < 0 ? "denied" : postList + " entries"}`);
console.log(`  ${NEGATIVE_CONTROL_BUCKET} anon GET object   HTTP ${profRead}   (negative control)`);
console.log(`  ${POSITIVE_CONTROL_BUCKET} public GET object HTTP ${stampRead}   (positive control)`);
console.log(`  ${NEGATIVE_CONTROL_BUCKET} signed URL fetch  HTTP ${signOk}   (signing control)`);

// ── 3. Controls must hold in BOTH states, or nothing below is meaningful ─────

if (stampRead !== 200) {
  fail(
    `POSITIVE CONTROL FAILED: ${POSITIVE_CONTROL_BUCKET} is a public bucket with a ` +
      `public-read policy and should return 200, but returned ${stampRead}. The probe ` +
      `cannot distinguish "denied" from "broken", so every other reachability result ` +
      `in this run is worthless. Do not act on this output.`,
  );
}
if (profRead === 200) {
  fail(
    `NEGATIVE CONTROL FAILED: ${NEGATIVE_CONTROL_BUCKET} has no storage.objects policy ` +
      `and must deny anonymous reads, but returned 200. Something grants read that this ` +
      `script does not know about — find it before changing anything.`,
  );
}
if (signOk !== 200) {
  fail(
    `SIGNING CONTROL FAILED: a signed URL for ${NEGATIVE_CONTROL_BUCKET} returned ` +
      `${signOk}, not 200. The safety argument for this whole change is that signing ` +
      `does not consult RLS. If that is not observably true, DO NOT DROP THE POLICY.`,
  );
}

// ── 4. Verdict ──────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(74));

if (problems > 0) {
  console.error(`\n${problems} control failure(s). Exit 1 — fails closed.\n`);
  process.exit(1);
}

const anonCanRead = postRead === 200 || postList > 0;

if (target && anonCanRead) {
  console.log(
    "BEFORE state confirmed.\n\n" +
      `  The policy is present, its body is captured above, and an anonymous caller\n` +
      `  holding only the app's publishable key CAN read and/or enumerate\n` +
      `  ${TARGET_BUCKET}. The grant is live and reachable, not vestigial.\n\n` +
      "  Safe to apply the migration. Re-run afterwards and expect exit 3.\n",
  );
  process.exit(0);
}

if (!target && !anonCanRead) {
  console.log(
    "AFTER state confirmed.\n\n" +
      `  The policy is gone, anonymous read and list are both denied, and the\n` +
      `  signing control still returns 200 — so the relay is unaffected.\n\n` +
      `  ${TARGET_BUCKET} now behaves exactly like ${NEGATIVE_CONTROL_BUCKET}.\n`,
  );
  process.exit(3);
}

// Catalog and reachability disagree. This is the interesting failure.
fail(
  target
    ? `the policy IS present but anonymous read/list are denied (GET ${postRead}, ` +
        `LIST ${postList}). Something else is blocking reads. Do not assume the policy ` +
        `is harmless — find out what is masking it first, because that mask may be ` +
        `removed by someone who does not know it is load-bearing.`
    : `the policy is GONE but an anonymous caller can still read (GET ${postRead}, ` +
        `LIST ${postList}). Dropping it did not close the exposure — there is another ` +
        `grant. THIS IS THE DANGEROUS CASE: the change looks done and is not.`,
);
process.exit(1);
