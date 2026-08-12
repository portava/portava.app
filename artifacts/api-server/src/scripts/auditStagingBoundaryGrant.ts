/**
 * auditStagingBoundaryGrant — the Step 01 gate, as an instrument.
 *
 * WHY THIS EXISTS
 * ---------------
 * Step 01 of the upload staging boundary drops two live storage policies:
 *
 *   post_media_storage_memories_stories_insert   INSERT, authenticated
 *   post_media_memories_stories_delete           DELETE, authenticated
 *
 * The insert grant lets any authenticated caller write raw, unprocessed bytes
 * into the durable `post-media` bucket under `memories/{uid}/…` or
 * `stories/{uid}/…`. The client that used it was removed on 2026-08-11; the
 * grant was not. A boundary enforced only in application code is bypassed by a
 * grant, so the grant has to go.
 *
 * Dropping a live policy is only safe if two things are true, and BOTH have to
 * be measured rather than assumed:
 *
 *   1. Nothing is using those prefixes. If objects exist under them, dropping
 *      the INSERT changes behaviour for a live writer.
 *   2. The exact policy body is recorded, so the migration's rollback is a
 *      proven re-CREATE and not a reconstruction from prose.
 *
 * (2) is the reason this script exists at all. These two policies are declared
 * by NO migration and appear NOWHERE in git history — verified by
 * `git log --all -S` on both names, which returns only prose documents. They
 * were applied out of band. `docs/fact-layer-20260810/PROMOTION.md` records
 * their command and role but not their `qual` / `with_check` expressions.
 *
 * So the only surviving copy of what these policies actually say is the live
 * catalog. If they are dropped without capturing the body first, the rollback
 * does not exist — and that is discovered at the exact moment someone needs it.
 * This script captures it, verbatim, and prints the re-CREATE statement.
 *
 * READ-ONLY. Every statement is a SELECT against pg_policies, storage.objects
 * and two row counts. It writes nothing and drops nothing; applying the change
 * is a separate, deliberate migration.
 *
 * EXIT CODES
 *   0  preconditions hold — safe to proceed with the Step 01 migration
 *   1  a precondition FAILED — objects exist under the prefixes, or a policy
 *      is missing so there is nothing to capture
 *   2  environment / API error — cannot run
 *
 * See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

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

/** The two policies Step 01 drops. Named literally so the check has a subject. */
const TARGET_POLICIES = [
  "post_media_storage_memories_stories_insert",
  "post_media_memories_stories_delete",
] as const;

/** The prefixes the insert grant authorises. */
const TARGET_PREFIXES = ["memories/", "stories/"] as const;

interface PolicyRow {
  policyname: string;
  cmd: string;
  permissive: string;
  roles: string;
  qual: string | null;
  with_check: string | null;
}

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.error(`❌ ${msg}`);
};

// ── 1. Capture the policy bodies, verbatim ───────────────────────────────────
//
// This is the rollback. `qual` and `with_check` are pg's own deparsed form of
// the expressions, which is what a re-CREATE needs.

const policies = await liveQuery<PolicyRow>(`
  select policyname, cmd, permissive, roles::text as roles, qual, with_check
    from pg_policies
   where schemaname = 'storage'
     and tablename  = 'objects'
     and policyname in (${TARGET_POLICIES.map((p) => `'${p}'`).join(", ")})
   order by policyname
`);

console.log("═".repeat(74));
console.log("STEP 01 — LIVE POLICY BODIES (the rollback)");
console.log("═".repeat(74));

for (const name of TARGET_POLICIES) {
  const p = policies.find((r) => r.policyname === name);
  if (!p) {
    // Not a no-op: if the policy is already gone the migration has nothing to
    // drop AND nothing to restore, and the operator needs to know which.
    fail(
      `policy ${name} is NOT present live. Either it was already dropped, or the ` +
        `name is wrong. Do not proceed until this is explained — a rollback ` +
        `cannot be written for a policy whose body was never captured.`,
    );
    continue;
  }
  console.log(`\n── ${p.policyname} ──`);
  console.log(`  cmd        : ${p.cmd}`);
  console.log(`  permissive : ${p.permissive}`);
  console.log(`  roles      : ${p.roles}`);
  console.log(`  qual       : ${p.qual ?? "(null)"}`);
  console.log(`  with_check : ${p.with_check ?? "(null)"}`);
  console.log("\n  ROLLBACK — re-CREATE, paste verbatim into the down section:");
  const roles = p.roles.replace(/^\{|\}$/g, "");
  const parts = [
    `CREATE POLICY "${p.policyname}" ON storage.objects`,
    `  AS ${p.permissive.toUpperCase()}`,
    `  FOR ${p.cmd}`,
    `  TO ${roles}`,
  ];
  if (p.qual) parts.push(`  USING (${p.qual})`);
  if (p.with_check) parts.push(`  WITH CHECK (${p.with_check})`);
  console.log(
    parts.map((l) => `    ${l}`).join("\n") + "    ;",
  );
}

// ── 2. Prove the prefixes are unused ─────────────────────────────────────────
//
// The packet measured zero. Measured again here rather than trusted, because
// the orphan count has already moved since the packet was written (28 → 30),
// which is proof this bucket is not static.

console.log(`\n${"═".repeat(74)}`);
console.log("STEP 01 — PRECONDITION: the prefixes must be unused");
console.log("═".repeat(74));

for (const prefix of TARGET_PREFIXES) {
  const [row] = await liveQuery<{ n: number }>(`
    select count(*)::int as n
      from storage.objects
     where bucket_id = 'post-media'
       and name like '${prefix}%'
  `);
  const n = Number(row?.n ?? -1);
  if (n < 0) {
    fail(`could not count objects under '${prefix}' — treat as unproven`);
  } else if (n > 0) {
    fail(
      `${n} object(s) exist under '${prefix}' in post-media. The packet measured ` +
        `zero. Dropping the INSERT grant now changes behaviour for a live writer — ` +
        `find the writer before proceeding.`,
    );
  } else {
    console.log(`  ✅ post-media '${prefix}*' — 0 objects`);
  }
}

// ── 3. Corroborating row counts ──────────────────────────────────────────────
//
// Not gates on their own — a feature can have rows without using these
// prefixes. Reported because "stories has no production data" is load-bearing
// in the packet's argument and should be visible, not asserted.

const [storiesRow] = await liveQuery<{ n: number }>(
  `select count(*)::int as n from stories`,
);
console.log(`\n  context: stories rows = ${storiesRow?.n ?? "?"}`);

const [totalRow] = await liveQuery<{ n: number }>(
  `select count(*)::int as n from storage.objects where bucket_id = 'post-media'`,
);
console.log(`  context: post-media objects total = ${totalRow?.n ?? "?"}`);

console.log(`\n${"═".repeat(74)}`);
if (failed) {
  console.error("STEP 01 GATE: ❌ NOT SATISFIED — do not apply the migration.");
  process.exit(1);
}
console.log(
  "STEP 01 GATE: ✅ satisfied — both bodies captured, both prefixes empty.",
);
console.log(
  "The rollback above must be pasted into the migration before it is applied.",
);
process.exit(0);
