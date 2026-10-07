/**
 * clientGrantExcessBoundary — migration 3740, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/clientGrantExcessBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT (found by audit:live-unexplained run 37608414616 on portava-ci):
 *   * seven post-baseline tables kept Supabase's default client DML, because
 *     their creating migrations never revoked it;
 *   * `profiles` gained table-level SELECT and UPDATE for anon and
 *     authenticated wherever the baseline is replayed over Supabase's default
 *     ACL — this harness included (scripts/local-db/shim.sql:58) — which
 *     overrides its column grants: the anon key could read date_of_birth,
 *     phone_e164, expo_push_token and full_name.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3740 with the chain, so the database
 * under test already carries its effect. Each property rebuilds the PRE-3740
 * posture inside a transaction, proves the hole is open there, applies 3740's
 * body, and asserts it is closed; the transaction always rolls back.
 *
 * PROPERTIES
 *   CG0  3740 is in force on the replayed chain: the seven grant no client role
 *        or PUBLIC anything; profiles has no client table-level SELECT/UPDATE,
 *        hides date_of_birth / phone_e164 / expo_push_token / full_name and
 *        still exposes handle and avatar_url.
 *   CG1  over the pre-3740 grants the anon key reads profiles.date_of_birth and
 *        selects from message_edits; after 3740's body both are refused with
 *        "permission denied", and the baseline's readable columns stay readable.
 *   CG2  service_role keeps SELECT/INSERT/UPDATE/DELETE on all seven.
 *   CG3  3740's postcondition raises over each kind of excess left behind: a
 *        table grant on one of the seven, a table-level SELECT on profiles, and
 *        one extra profiles column grant.
 *   CG4  3740 is idempotent: its body runs twice in one transaction.
 *   CG5  the postcondition passes ALONE on the committed database, which is what
 *        certify:migrations stage 4 sends after COMMIT.
 *   CG6  a database missing one of the seven (2811 unapplied, as production may
 *        be) is NOT refused: the absent table is named in a NOTICE, every
 *        present one is still revoked, and the postcondition still bites on a
 *        present one (verifier F7).
 *   CG7  2955's own postcondition — which certify:migrations re-runs after
 *        COMMIT on a full-chain build — still passes after 3740 (verifier F1).
 *   IV0-IV2 (3741) trip_presence_current reads trip_presence as the CALLER: a
 *        non-crew user sees 0 rows through it, a crew member sees their trip's
 *        row; with the option reset (the pre-3741 shape) the non-crew user sees
 *        it; and 3741's postcondition refuses the reset view.
 */
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, command, deleteUser, exec, kernel, psql, rows, seedUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3740_client_grant_excess_boundary.sql");

const SEVEN = [
  "highlight_resurfacing_preferences", "highlight_projection_policies", "highlight_sources",
  "message_edits", "message_reactions", "message_attachments", "conversation_action_refs",
];

/** 3740's statements without its own BEGIN … COMMIT, so a test can run them inside its transaction. */
function body(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "3740: no BEGIN … COMMIT wrapper");
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

/** 3740's postcondition block alone: `DO $post$ … END $post$;`. */
function postcondition(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf("DO $post$");
  assert.ok(at >= 0, "3740: no DO $post$ block");
  const end = sql.indexOf("END $post$;", at);
  assert.ok(end > at, "3740: postcondition block is not terminated");
  return sql.slice(at, end + "END $post$;".length) + "\n";
}

/** 3740's precondition block alone. */
function precondition(): string {
  const b = body();
  const at = b.indexOf("DO $pre$");
  const end = b.indexOf("END $pre$;", at);
  assert.ok(at >= 0 && end > at, "3740: no DO $pre$ block");
  return b.slice(at, end + "END $pre$;".length) + "\n";
}

/** The posture before 3740, as Supabase's default ACL and a baseline replay over it leave it. */
const PRE_3740 =
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${SEVEN.map((t) => `public.${t}`).join(", ")} TO anon, authenticated;\n` +
  "GRANT SELECT, UPDATE ON public.profiles TO anon, authenticated;\n";

function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

describe("3740: client roles hold no excess privilege on nine tables or on profiles (database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("CG0: 3740 is in force on the replayed chain", () => {
    const offending = rows<{ rel: string; grantee: string }>(`
      SELECT t.rel, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee
        FROM (VALUES ${SEVEN.map((n) => `('${n}')`).join(",")}) AS t(rel)
        JOIN pg_class c ON c.oid = to_regclass('public.' || t.rel)
        CROSS JOIN LATERAL aclexplode(c.relacl) x
       WHERE x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon','authenticated')
       ORDER BY 1, 2`);
    assert.deepEqual(offending, [], "one of the nine still grants a client role or PUBLIC something");
    const present = rows<{ n: number }>(`
      SELECT count(*)::int AS n FROM (VALUES ${SEVEN.map((n) => `('${n}')`).join(",")}) AS t(rel)
       WHERE to_regclass('public.' || t.rel) IS NOT NULL`)[0]!.n;
    assert.equal(present, 7, "the harness did not replay the chain through 2811");

    const probe = rows<{ k: string; v: boolean }>(`
      SELECT 'anon:table:SELECT' AS k, has_table_privilege('anon', 'public.profiles', 'SELECT') AS v
      UNION ALL SELECT 'authenticated:table:UPDATE', has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
      UNION ALL SELECT 'anon:date_of_birth', has_column_privilege('anon', 'public.profiles', 'date_of_birth', 'SELECT')
      UNION ALL SELECT 'anon:phone_e164', has_column_privilege('anon', 'public.profiles', 'phone_e164', 'SELECT')
      UNION ALL SELECT 'authenticated:expo_push_token', has_column_privilege('authenticated', 'public.profiles', 'expo_push_token', 'SELECT')
      UNION ALL SELECT 'authenticated:full_name', has_column_privilege('authenticated', 'public.profiles', 'full_name', 'SELECT')
      UNION ALL SELECT 'authenticated:role:UPDATE', has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
      UNION ALL SELECT 'anon:handle', has_column_privilege('anon', 'public.profiles', 'handle', 'SELECT')
      UNION ALL SELECT 'authenticated:avatar_url', has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'SELECT')`);
    const got = Object.fromEntries(probe.map((r) => [r.k, r.v]));
    assert.deepEqual(got, {
      "anon:table:SELECT": false,
      "authenticated:table:UPDATE": false,
      "anon:date_of_birth": false,
      "anon:phone_e164": false,
      "authenticated:expo_push_token": false,
      "authenticated:full_name": false,
      "authenticated:role:UPDATE": false,
      "anon:handle": true,
      "authenticated:avatar_url": true,
    });
  });

  it("CG1: the pre-3740 posture exposes the columns and the tables; 3740's body refuses them", () => {
    const open = inRolledBackTx(`${PRE_3740}
SELECT 'DOB=' || has_column_privilege('anon', 'public.profiles', 'date_of_birth', 'SELECT');
SET LOCAL ROLE anon;
SELECT 'EDITS=' || count(*) FROM public.message_edits;`);
    assert.equal(open.status, 0, `the pre-3740 posture: ${open.stderr}`);
    assert.match(open.stdout, /DOB=true/, "anon could not read date_of_birth before 3740, so this property proves nothing");
    assert.match(open.stdout, /EDITS=\d+/);

    const dob = inRolledBackTx(`${PRE_3740}${body()}
SET LOCAL ROLE anon;
SELECT date_of_birth FROM public.profiles WHERE false;`);
    assert.notEqual(dob.status, 0, "anon read profiles.date_of_birth after 3740");
    assert.match(dob.stderr, /permission denied for table profiles/, dob.stderr);

    const edits = inRolledBackTx(`${PRE_3740}${body()}
SET LOCAL ROLE anon;
SELECT count(*) FROM public.message_edits;`);
    assert.notEqual(edits.status, 0, "anon selected from message_edits after 3740");
    assert.match(edits.stderr, /permission denied for table message_edits/, edits.stderr);

    const kept = inRolledBackTx(`${PRE_3740}${body()}
SELECT 'KEPT=' || (has_column_privilege('anon', 'public.profiles', 'handle', 'SELECT')
               AND has_column_privilege('authenticated', 'public.profiles', 'bio', 'UPDATE')
               AND NOT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE'));`);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /KEPT=true/, "3740 broke the baseline's readable/writable profile columns");
  });

  it("CG2: service_role keeps SELECT, INSERT, UPDATE and DELETE on all seven", () => {
    const out = inRolledBackTx(`${PRE_3740}${body()}
SELECT 'MISSING=' || coalesce(string_agg(t.rel || ':' || p, ',' ORDER BY t.rel, p), '')
  FROM (VALUES ${SEVEN.map((n) => `('${n}')`).join(",")}) AS t(rel)
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p
 WHERE NOT has_table_privilege('service_role', 'public.' || t.rel, p);`);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^MISSING=$/m, `service_role lost a privilege: ${out.stdout}`);
  });

  it("CG3: the postcondition raises over each kind of excess left behind", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["a table grant on one of the nine", "GRANT SELECT ON public.highlight_sources TO anon;", /still holds a table privilege on: highlight_sources/],
      ["a column grant on one of the nine", "GRANT SELECT (id) ON public.message_reactions TO authenticated;", /holds a column privilege on: message_reactions\.id/],
      ["a table-level SELECT on profiles", "GRANT SELECT ON public.profiles TO authenticated;", /table-level authenticated:SELECT on public\.profiles/],
      ["one extra profiles column", "GRANT SELECT (date_of_birth) ON public.profiles TO anon;", /anon column SELECT on public\.profiles exceeds the baseline's\. Extra: date_of_birth/],
      ["a column the app reads, lost", "REVOKE SELECT (handle) ON public.profiles FROM anon;", /anon lost column SELECT the app reads on public\.profiles: handle/],
    ];
    for (const [what, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${body()}\n${breakIt}\n${postcondition()}`);
      assert.notEqual(out.status, 0, `the postcondition passed over ${what}`);
      assert.match(out.stderr, /ERROR:\s+3740 POSTCONDITION FAILED/, `${what}: ${out.stderr}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("CG4: 3740 is idempotent", () => {
    const out = inRolledBackTx(`${PRE_3740}${body()}\n${body()}`);
    assert.equal(out.status, 0, out.stderr);
  });

  it("CG5: the postcondition passes alone on the committed database (certify:migrations stage 4)", () => {
    const out = inRolledBackTx(postcondition());
    assert.equal(out.status, 0, `the postcondition cannot be re-run after COMMIT: ${out.stderr}`);
  });

  it("CG6: a missing table is skipped by name, every present one is still revoked, and the postcondition still bites", () => {
    const skipped = inRolledBackTx(`${PRE_3740}ALTER TABLE public.message_attachments RENAME TO zz_3740_gone;
${body()}
SELECT 'EDITS=' || has_table_privilege('anon', 'public.message_edits', 'SELECT');`);
    assert.equal(skipped.status, 0, `an absent 2811 table refused the apply: ${skipped.stderr}`);
    assert.match(skipped.stderr, /NOTICE:\s+3740: message_attachments absent from schema public; skipped/, skipped.stderr);
    assert.match(skipped.stdout, /EDITS=false/, "a present table was left holding its grant");
    const post = inRolledBackTx(`ALTER TABLE public.message_attachments RENAME TO zz_3740_gone;
${body()}
GRANT SELECT ON public.message_edits TO anon;
${postcondition()}`);
    assert.notEqual(post.status, 0, "with one table absent, the postcondition passed over a present table's grant");
    assert.match(post.stderr, /3740 POSTCONDITION FAILED: a client role or PUBLIC still holds a table privilege on: message_edits/, post.stderr);
  });

  it("CG7: 2955's postcondition still passes after 3740 (certify re-runs it on a full-chain build)", () => {
    const sql = readFileSync(resolve(__dir, "../../migrations/2955_media_asset_write_boundary.sql"), "utf8");
    const blocks = [...sql.matchAll(/^DO \$\$[\s\S]*?^END \$\$;/gm)].map((m) => m[0]).filter((b) => /POSTCONDITION/.test(b));
    assert.ok(blocks.length >= 1, "2955 has no postcondition block to re-run");
    const out = inRolledBackTx(`${body()}\n${blocks.join("\n")}`);
    assert.equal(out.status, 0, `2955's postcondition fails after 3740: ${out.stderr}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3741 — trip_presence_current reads as the caller (verifier F2)
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATION_3741 = resolve(__dir, "../../migrations/3741_trip_presence_current_security_invoker.sql");

function post3741(): string {
  const sql = readFileSync(MIGRATION_3741, "utf8");
  const at = sql.indexOf("DO $post$");
  const end = sql.indexOf("END $post$;", at);
  assert.ok(at >= 0 && end > at, "3741: no DO $post$ block");
  return sql.slice(at, end + "END $post$;".length) + "\n";
}

/** As a signed-in user (the PostgREST path): the role plus the JWT GUCs auth.uid() reads. */
const asUserSql = (userId: string, sql: string) =>
  `SELECT set_config('request.jwt.claim.sub', '${userId}', true);\n` +
  `SELECT set_config('request.jwt.claim.role', 'authenticated', true);\nSET LOCAL ROLE authenticated;\n${sql}`;

describe("3741: trip_presence_current reads trip_presence as the caller (database privilege boundary)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  let owner = "";
  let outsider = "";
  let tripId = "";

  before(() => {
    owner = seedUser("iv_owner");
    outsider = seedUser("iv_outsider");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "invoker", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
    exec(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.trip_presence (trip_id, user_id, presence_state, visibility, observed_at, expires_at) ` +
        `VALUES ('${tripId}', '${owner}', 'here', 'private', now(), now() + interval '20 minutes');`,
      { single: true },
    );
  });
  after(() => {
    if (owner) deleteUser(owner);
    if (outsider) deleteUser(outsider);
  });

  it("IV0: 3741 is in force on the replayed chain", () => {
    const r = rows<{ inv: boolean }>(`
      SELECT COALESCE((SELECT lower(o.option_value) IN ('true','on','1','yes') FROM pg_options_to_table(c.reloptions) o
                        WHERE o.option_name = 'security_invoker'), false) AS inv
        FROM pg_class c WHERE c.oid = 'public.trip_presence_current'::regclass`);
    assert.equal(r[0]?.inv, true);
  });

  it("IV1: a non-crew user reads 0 rows through the view; the crew member reads the trip's row", () => {
    const seen = (who: string) =>
      inRolledBackTx(asUserSql(who, `SELECT 'ROWS=' || count(*) FROM public.trip_presence_current WHERE trip_id = '${tripId}';`));
    const out = seen(outsider);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ROWS=0/, "a non-crew user read another trip's presence through the view");
    const own = seen(owner);
    assert.equal(own.status, 0, `the crew member cannot read through the invoker view: ${own.stderr}`);
    assert.match(own.stdout, /ROWS=1/);
  });

  it("IV2: with the option reset (2776's shape) the non-crew user reads the row; 3741's postcondition refuses that view", () => {
    const open = inRolledBackTx(
      `ALTER VIEW public.trip_presence_current RESET (security_invoker);\n` +
        asUserSql(outsider, `SELECT 'ROWS=' || count(*) FROM public.trip_presence_current WHERE trip_id = '${tripId}';`),
    );
    assert.equal(open.status, 0, open.stderr);
    assert.match(open.stdout, /ROWS=1/, "the definer view did not leak before 3741, so this property proves nothing");
    const refused = inRolledBackTx(`ALTER VIEW public.trip_presence_current RESET (security_invoker);\n${post3741()}`);
    assert.notEqual(refused.status, 0, "3741's postcondition passed over a definer view");
    assert.match(refused.stderr, /ERROR:\s+3741 POSTCONDITION FAILED: public\.trip_presence_current is not security_invoker/, refused.stderr);
  });
});
