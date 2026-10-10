/**
 * telegraphAvailabilityClientDoor — migrations 3653 and 3762 (lead rulings
 * P-T1 / P-T1a, census-telegraph §65), executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/telegraphAvailabilityClientDoor.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT. The API withholds an invisible owner's availability on every
 * door (services/telegraph/availabilityInvisibility.ts). PostgREST did not:
 *   * user_availability / quick_availability_status: the baseline grants the
 *     client roles ALL and six friend / circle / trip SELECT policies admit a
 *     crew-mate — so a friend read an invisible person's weekly grid, "open to
 *     meet" and live "free now" status with the public key and their own session;
 *   * profiles.open_to_meet: column SELECT to anon and authenticated (baseline,
 *     re-issued by 3740), every non-private row admitted by profiles_select.
 *
 * HOW THESE PROPERTIES BITE: up.sh replays 3653 and 3762 with the chain, so the
 * database under test already carries their effect. The "open" posture is
 * rebuilt inside a transaction from the two ROLLBACK files, the hole is shown
 * open there with a real row read by a real friend, the two bodies are applied,
 * and the same reads are refused; every transaction rolls back.
 *
 * PROPERTIES
 *   DC0  in force on the replayed chain: no client privilege on the two tables,
 *        no client SELECT on profiles.open_to_meet; profiles.handle still
 *        readable; service_role untouched.
 *   DC1  THE POINT: over the rollback posture a friend reads the owner's grid and
 *        "free now" status and anon can select open_to_meet; after the bodies each
 *        of those reads is refused with "permission denied".
 *   DC2  each postcondition raises over the excess it exists to catch.
 *   DC3  both postconditions pass ALONE on the committed database (what
 *        certify:migrations stage 4 sends after COMMIT), and 3740's still does
 *        after 3762 (its SELECT list is an upper bound — the ORDER claim).
 *   DC4  both bodies are idempotent.
 *   DC5  3762 refuses a table-level client SELECT on profiles ("Apply 3740 first").
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, exec, psql, rows, seedUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const M3653 = resolve(__dir, "../../migrations/3653_availability_client_reads_withheld.sql");
const M3762 = resolve(__dir, "../../migrations/3762_profiles_open_to_meet_client_read_withheld.sql");
const M3740 = resolve(__dir, "../../migrations/3740_client_grant_excess_boundary.sql");
const R3653 = resolve(__dir, "../../../../../db/rollback/2026-10-08-3653-availability-client-reads-withheld-rollback.sql");
const R3762 = resolve(__dir, "../../../../../db/rollback/2026-10-08-3762-profiles-open-to-meet-client-read-withheld-rollback.sql");

/** A file's statements between its BEGIN and COMMIT, so a test can run them inside its own transaction. */
function body(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

/** A file's postcondition block alone: `DO $post$ … END $post$;`. */
function postcondition(path: string): string {
  const sql = readFileSync(path, "utf8");
  const at = sql.indexOf("DO $post$");
  assert.ok(at >= 0, `${path}: no DO $post$ block`);
  const end = sql.indexOf("END $post$;", at);
  assert.ok(end > at, `${path}: postcondition block is not terminated`);
  return sql.slice(at, end + "END $post$;".length) + "\n";
}

function inRolledBackTx(script: string) {
  return psql(`BEGIN;\n${script}\nROLLBACK;\n`);
}

let OWNER = "";
let FRIEND = "";

/** Become the signed-in friend for the rest of the transaction (the PostgREST path). */
const asFriend = () =>
  `SELECT set_config('request.jwt.claim.sub', '${FRIEND}', true);\n` +
  `SELECT set_config('request.jwt.claim.role', 'authenticated', true);\n` +
  `SET LOCAL ROLE authenticated;\n`;
const asAnon = () =>
  `RESET ROLE;\nSELECT set_config('request.jwt.claim.sub', '', true);\n` +
  `SELECT set_config('request.jwt.claim.role', 'anon', true);\nSET LOCAL ROLE anon;\n`;
/** The posture before 3653 / 3762: the two rollbacks' bodies (they re-grant what the files revoke). */
const OPEN = () => `${body(R3653)}${body(R3762)}`;
const CLOSE = () => `${body(M3653)}${body(M3762)}`;

describe("P-T1 / P-T1a: PostgREST withholds availability the API withholds (3653, 3762)", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => {
    OWNER = seedUser("ptdoorowner");
    FRIEND = seedUser("ptdoorfriend");
    const [a, b] = OWNER < FRIEND ? [OWNER, FRIEND] : [FRIEND, OWNER];
    exec(
      `UPDATE public.profiles SET open_to_meet = true WHERE id = '${OWNER}';\n` +
        `INSERT INTO public.user_friendships (user_a, user_b) VALUES ('${a}', '${b}');\n` +
        `INSERT INTO public.user_availability (user_id, open_to_meet) VALUES ('${OWNER}', true);\n` +
        `INSERT INTO public.quick_availability_status (user_id, status, expires_at) VALUES ('${OWNER}', 'free_now', now() + interval '1 hour');`,
    );
  });

  after(() => {
    if (!OWNER) return;
    exec(
      `DELETE FROM public.quick_availability_status WHERE user_id IN ('${OWNER}', '${FRIEND}');\n` +
        `DELETE FROM public.user_availability WHERE user_id IN ('${OWNER}', '${FRIEND}');\n` +
        `DELETE FROM public.user_friendships WHERE user_a IN ('${OWNER}', '${FRIEND}') OR user_b IN ('${OWNER}', '${FRIEND}');`,
    );
    deleteUser(OWNER);
    deleteUser(FRIEND);
  });

  it("DC0: in force on the replayed chain", () => {
    const probe = rows<{ k: string; v: boolean }>(`
      SELECT r || ':' || t || ':' || p AS k, has_table_privilege(r, 'public.' || t, p) AS v
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
        CROSS JOIN unnest(ARRAY['user_availability', 'quick_availability_status']) t
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
      UNION ALL SELECT 'anon:open_to_meet', has_column_privilege('anon', 'public.profiles', 'open_to_meet', 'SELECT')
      UNION ALL SELECT 'authenticated:open_to_meet', has_column_privilege('authenticated', 'public.profiles', 'open_to_meet', 'SELECT')
      UNION ALL SELECT 'service_role:open_to_meet', has_column_privilege('service_role', 'public.profiles', 'open_to_meet', 'SELECT')
      UNION ALL SELECT 'anon:handle', has_column_privilege('anon', 'public.profiles', 'handle', 'SELECT')
      UNION ALL SELECT 'authenticated:handle', has_column_privilege('authenticated', 'public.profiles', 'handle', 'SELECT')`);
    const got = Object.fromEntries(probe.map((r) => [r.k, r.v]));
    for (const [k, v] of Object.entries(got)) {
      const expected = k.startsWith("service_role:") || k.endsWith(":handle");
      assert.equal(v, expected, `${k} = ${v}`);
    }
    assert.equal(Object.keys(got).length, 29, "the probe went blind");
  });

  it("DC1 THE POINT: over the rollback posture a friend reads the owner's availability and anon the column; after the bodies every read is refused", () => {
    const open = inRolledBackTx(`${OPEN()}${asFriend()}
SELECT 'UA=' || open_to_meet FROM public.user_availability WHERE user_id = '${OWNER}';
SELECT 'QAS=' || status FROM public.quick_availability_status WHERE user_id = '${OWNER}';
${asAnon()}
SELECT 'OTM=' || count(*) FROM (SELECT open_to_meet FROM public.profiles WHERE false) s;`);
    assert.equal(open.status, 0, `the open posture: ${open.stderr}`);
    assert.match(open.stdout, /UA=true/, "the friend could not read the owner's grid before 3653, so this property proves nothing");
    assert.match(open.stdout, /QAS=free_now/, "the friend could not read the owner's quick status before 3653");
    assert.match(open.stdout, /OTM=0/);

    const refused: Array<[string, string, RegExp]> = [
      ["the friend reads user_availability", `${asFriend()}SELECT open_to_meet FROM public.user_availability WHERE user_id = '${OWNER}';`, /permission denied for table user_availability/],
      ["the friend reads quick_availability_status", `${asFriend()}SELECT status FROM public.quick_availability_status WHERE user_id = '${OWNER}';`, /permission denied for table quick_availability_status/],
      ["anon reads user_availability", `${asAnon()}SELECT count(*) FROM public.user_availability;`, /permission denied for table user_availability/],
      ["the friend selects profiles.open_to_meet", `${asFriend()}SELECT open_to_meet FROM public.profiles WHERE id = '${OWNER}';`, /permission denied for table profiles/],
      ["anon selects profiles.open_to_meet", `${asAnon()}SELECT open_to_meet FROM public.profiles WHERE false;`, /permission denied for table profiles/],
      ["anon filters on profiles.open_to_meet", `${asAnon()}SELECT id FROM public.profiles WHERE open_to_meet AND false;`, /permission denied for table profiles/],
    ];
    for (const [what, read, expected] of refused) {
      const out = inRolledBackTx(`${OPEN()}${CLOSE()}${read}`);
      assert.notEqual(out.status, 0, `${what}: succeeded after 3653/3762`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }

    // The narrowing is one column: the friend still reads the owner's handle.
    const kept = inRolledBackTx(`${OPEN()}${CLOSE()}${asFriend()}SELECT 'H=' || count(*) FROM (SELECT handle FROM public.profiles WHERE id = '${OWNER}') s;`);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /H=1/, "3762 took more than open_to_meet");
  });

  it("DC2: each postcondition raises over the excess it exists to catch", () => {
    const cases: Array<[string, string, string, RegExp]> = [
      ["SELECT handed back on user_availability", M3653, "GRANT SELECT ON public.user_availability TO authenticated;", /POSTCONDITION FAILED \(3653\): authenticated still holds SELECT on public\.user_availability/],
      ["a column grant on quick_availability_status", M3653, "GRANT SELECT (status) ON public.quick_availability_status TO anon;", /POSTCONDITION FAILED \(3653\): anon still holds SELECT on public\.quick_availability_status/],
      ["a grant to PUBLIC", M3653, "GRANT DELETE ON public.user_availability TO PUBLIC;", /POSTCONDITION FAILED \(3653\): anon still holds DELETE on public\.user_availability/],
      ["open_to_meet handed back to anon", M3762, "GRANT SELECT (open_to_meet) ON public.profiles TO anon;", /POSTCONDITION FAILED \(3762\): anon can still SELECT public\.profiles\.open_to_meet/],
    ];
    for (const [what, file, breakIt, expected] of cases) {
      const out = inRolledBackTx(`${CLOSE()}\n${breakIt}\n${postcondition(file)}`);
      assert.notEqual(out.status, 0, `the postcondition passed over ${what}`);
      assert.match(out.stderr, expected, `${what}: ${out.stderr}`);
    }
  });

  it("DC3: both postconditions pass alone on the committed database, and 3740's still does after 3762", () => {
    for (const f of [M3653, M3762, M3740]) {
      const out = psql(postcondition(f));
      assert.equal(out.status, 0, `${f}: ${out.stderr}`);
    }
  });

  it("DC4: both bodies are idempotent", () => {
    const out = inRolledBackTx(`${CLOSE()}${CLOSE()}`);
    assert.equal(out.status, 0, out.stderr);
  });

  it("DC5: 3762 refuses while a client role holds TABLE-level SELECT on profiles (the pre-3740 replay)", () => {
    const out = inRolledBackTx(`GRANT SELECT ON public.profiles TO anon;\n${body(M3762)}`);
    assert.notEqual(out.status, 0, "3762 reported a narrowing a table-level grant defeats");
    assert.match(out.stderr, /PRECONDITION FAILED \(3762\): anon hold\(s\) TABLE-level SELECT on public\.profiles/, out.stderr);
  });
});
