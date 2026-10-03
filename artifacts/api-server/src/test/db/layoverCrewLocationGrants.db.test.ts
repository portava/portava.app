/**
 * layoverCrewLocationGrants — spec §14 L4 / census-layover L124, L132: migration
 * 3516's grant store, probed against real PostgreSQL with real rows and real roles.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/layoverCrewLocationGrants.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THIS FILE IS NAMED BY 3516 ITSELF, in WHERE THE REAL-RLS EVIDENCE LIVES: the
 * migration inserts nothing and assumes no role, because a probe inside its own
 * transaction can only undo itself by aborting — which rolls back the DDL
 * batched with it while the migration still reports success (2195's defect,
 * which src/test/migrationDeployability.test.ts now forbids). So the probe is
 * here, and it observes from SEPARATE CONNECTIONS: every localDb call is its own
 * psql process, so nothing asserted below is read inside the transaction that
 * produced it unless the comment says so and says why.
 *
 * WHAT THIS TABLE IS. One row per act of consent to share a live location: who
 * said yes, to which crew, from which of their sessions, from when, until when,
 * and whether they have since revoked. The evidence matters more than usual
 * because a defect here is not a wrong number on a screen — it is a traveller's
 * whereabouts shown to somebody they did not authorise, or for longer than they
 * authorised.
 *
 * PROPERTIES (each seen red by mutating the live database; see the mutation log
 * in the suite's handover — never by editing the migration)
 *   G0  the catalogue: RLS on, ZERO permissive policies, exactly FOUR restrictive
 *       client denials (one per operation, by name), no client table or column
 *       privilege of any kind, and service_role holding all four operations.
 *   G1  the write boundary, privilege layer: for anon AND authenticated, each of
 *       SELECT / INSERT / UPDATE / DELETE is refused with SQLSTATE 42501
 *       ("permission denied for table"), and the table's whole contents are
 *       byte-identical before and after EACH attempt.
 *   G2  the write boundary, policy layer — the part that matters. 3516's header
 *       names the policy somebody will plausibly add later: "a traveller may read
 *       and write their own grants", `granted_by_user_id = auth.uid()`. This
 *       property COMMITS exactly that policy and re-GRANTs the four privileges —
 *       so that the refusals are the policies' and not the revoked privilege's —
 *       and the restrictive denials still refuse: the client cannot write itself
 *       a grant, and above all cannot choose its own `expires_at`. The reopening
 *       is undone in a `finally` and the restored posture is re-asserted.
 *   G3  NON-VACUITY: service_role inserts, selects back and updates. Without this
 *       control, "nothing can write" would pass against a table that does not work.
 *   G4  a grant with no window is NOT EXPRESSIBLE: `expires_at` is NOT NULL with
 *       no default in the catalogue, and an INSERT omitting it is REFUSED
 *       (23502, column `expires_at`) rather than defaulted — row count unchanged.
 *   G5  `layover_crew_location_grants_positive_window` refuses `expires_at`
 *       equal to and earlier than `granted_at`, by constraint name, 23514.
 *   G6  `layover_crew_location_grants_revocation_after_grant` refuses a
 *       `revoked_at` before `granted_at`, by constraint name, 23514 — and admits
 *       one equal to and after it.
 *   G7  RE-GRANTING AFTER REVOCATION WORKS, and RE-GRANTING AFTER EXPIRY WORKS:
 *       both rows coexist for one (crew_id, granted_by_user_id) pair. This is the
 *       evidence that NEITHER form of the "obvious" unique index exists — the
 *       unqualified one would forbid the first, the partial
 *       `WHERE revoked_at IS NULL` one would forbid the second.
 *   G8  revocation PRESERVES THE ROW: the UPDATE leaves it present with its
 *       original `granted_at` and `expires_at` intact. A reader that skipped
 *       revoked rows would report `never_granted` for somebody who actually
 *       revoked, and that is the one confusion `locationPrecisionFor` must not make.
 *   G9  `layover_crew_location_grants_newest_idx` exists on
 *       (crew_id, granted_by_user_id, granted_at DESC), is not unique, and is NOT
 *       PARTIAL — `pg_index.indpred` IS NULL.
 *   G10 ON DELETE CASCADE from `layover_crews`, from `profiles` and from
 *       `layover_sessions` each remove the grant, observed one FK at a time.
 *   G11 NO COORDINATE COLUMN: not on this table, and not on `layover_crews` or
 *       `layover_crew_members` either. 3516's postcondition asserts the latter so
 *       that applying this file is not read as licence to add one next door.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const TABLE = "layover_crew_location_grants";
const OPS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Op = (typeof OPS)[number];
type Role = "anon" | "authenticated";
const ROLES: Role[] = ["anon", "authenticated"];

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

interface Attempt { ok: boolean; sqlstate: string; constraint: string | null; column: string | null; stdout: string[]; stderr: string }

/** The PostgREST prelude the neighbours use: the role plus the GUCs auth.uid() reads. */
function prelude(who: Who): string {
  if (who.role === "anon") {
    return `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`;
  }
  return (
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${who.uid}', true);` +
    ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
    `SET LOCAL ROLE authenticated;\n`
  );
}

/**
 * One psql invocation, verbose — so the SQLSTATE and the constraint/column name
 * come back. `single` wraps the script in one transaction (psql -1); a script
 * that writes its own BEGIN … ROLLBACK passes `single: false`.
 */
function attempt(script: string, opts: { single?: boolean } = {}): Attempt {
  const r = psql(`\\set VERBOSITY verbose\n${script}`, { single: opts.single ?? true });
  const stdout = r.stdout.split("\n").filter((l) => l.length > 0);
  if (r.status === 0) return { ok: true, sqlstate: "", constraint: null, column: null, stdout, stderr: r.stderr };
  return {
    ok: false,
    sqlstate: /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)?.[1] ?? "",
    constraint: /CONSTRAINT NAME:\s+(\S+)/.exec(r.stderr)?.[1] ?? null,
    column: /COLUMN NAME:\s+(\S+)/.exec(r.stderr)?.[1] ?? null,
    stdout,
    stderr: r.stderr,
  };
}
const attemptAs = (who: Who, sql: string): Attempt => attempt(prelude(who) + sql);
/** The server's own path. */
const asService = (sql: string): Attempt => attempt(`SET LOCAL ROLE service_role;\n${sql}`);
function serviceOk(sql: string, why: string): string[] {
  const r = asService(sql);
  assert.equal(r.ok, true, `${why}\n${r.stderr}`);
  return r.stdout;
}

/**
 * The whole table, every column of every row, as sorted text — the STATE that
 * must be identical across a refused attempt. Read on its own connection.
 */
function snapshot(): string[] {
  return rows<{ r: string }>(`SELECT to_jsonb(g)::text AS r FROM public.${TABLE} g ORDER BY 1`).map((x) => x.r);
}
const grantCount = (): number => Number(scalar(`SELECT count(*) FROM public.${TABLE}`));
/** One grant row's durable fields, as the reader would see them. */
interface GrantRow { id: string; crew_id: string; granted_by_user_id: string; session_id: string; granted_at: string; expires_at: string; revoked_at: string | null }
const grantsOf = (crew: string, granter: string): GrantRow[] =>
  rows<GrantRow>(
    `SELECT id::text, crew_id::text, granted_by_user_id::text, session_id::text,
            to_json(granted_at)#>>'{}' AS granted_at, to_json(expires_at)#>>'{}' AS expires_at,
            to_json(revoked_at)#>>'{}' AS revoked_at
       FROM public.${TABLE}
      WHERE crew_id = '${crew}' AND granted_by_user_id = '${granter}'
      ORDER BY granted_at DESC`,
  );

/** An INSERT of one grant, every column explicit, then overridden per case. */
function insertGrant(over: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    crew_id: `'${CREW}'`,
    granted_by_user_id: `'${A}'`,
    session_id: `'${SESSION_A}'`,
    granted_at: `now()`,
    expires_at: `now() + interval '30 minutes'`,
    ...over,
  };
  const keys = Object.keys(cols).filter((k) => cols[k] !== "OMIT");
  return `INSERT INTO public.${TABLE} (${keys.join(", ")}) VALUES (${keys.map((k) => cols[k]).join(", ")}) RETURNING id::text;`;
}

let A = "";         // the crew's creator, and a granter
let P = "";         // a second granter — the profiles-cascade fixture, isolated from A
let SESSION_A = ""; // A's layover session
let CREW = "";      // the crew the grants are scoped to
let BASELINE: string[] = [];

describe("spec §14 L4 — 3516: the crew location grant store, on real PostgreSQL", { skip: !HAVE_DB }, () => {
  before(() => {
    // exec() throws on any psql failure, so a half-built fixture fails the suite
    // rather than letting a later assertion pass against nothing. The explicit
    // assertions below close the other half of that door: a silently-empty
    // fixture (0127/2984 missing, a cascade firing early) is a FAILURE here.
    // Residue from a run that died before its after() hook would make the
    // whole-table snapshot below disagree with the fixture, so this suite's own
    // synthetic accounts are purged first — by the handle prefix only it uses,
    // and nothing else. profiles cascades layover_sessions -> layover_crews ->
    // this table, so the grants go with them.
    exec(`SET LOCAL ROLE service_role;
          DELETE FROM public.${TABLE} g USING public.profiles p
           WHERE p.id = g.granted_by_user_id AND p.handle LIKE 'l4grant\\_%';
          RESET ROLE;
          DELETE FROM public.layover_crews WHERE created_by IN (SELECT id FROM public.profiles WHERE handle LIKE 'l4grant\\_%');
          DELETE FROM public.layover_sessions WHERE user_id IN (SELECT id FROM public.profiles WHERE handle LIKE 'l4grant\\_%');
          DELETE FROM auth.users WHERE id IN (SELECT id FROM public.profiles WHERE handle LIKE 'l4grant\\_%');
          DELETE FROM public.profiles WHERE handle LIKE 'l4grant\\_%';`, { single: true });

    A = seedUser("l4grant_a");
    P = seedUser("l4grant_p");
    SESSION_A = randomUUID();
    CREW = randomUUID();
    exec(`
      INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time)
        VALUES ('${SESSION_A}', '${A}', now(), now() + interval '6 hours');
      INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, expires_at)
        VALUES ('${CREW}', 'L4 Probe City', '${A}', '${SESSION_A}', 'l4 grant probe crew', now() + interval '5 hours');
    `);
    assert.equal(scalar(`SELECT count(*) FROM public.layover_crews WHERE id = '${CREW}'`), "1", "fixture: the crew must exist");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_sessions WHERE id = '${SESSION_A}'`), "1", "fixture: the session must exist");
    assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id IN ('${A}', '${P}')`), "2", "fixture: both granters must exist");
    // One committed grant, written the only way it can be written, so every
    // refusal below has a real row to fail to read, change or remove.
    const seeded = serviceOk(insertGrant(), "fixture: the service role must be able to write the baseline grant");
    assert.equal(seeded.length, 1, "fixture: the baseline grant must have been inserted");
    BASELINE = snapshot();
    assert.equal(BASELINE.length, 1, "fixture: the table must hold exactly the baseline grant");
  });

  after(() => {
    // G2 commits a GRANT and a permissive policy and undoes them in its own
    // `finally`; this is the belt to that braces, so a process killed mid-probe
    // cannot leave the live table client-writable for the next suite.
    exec(`DROP POLICY IF EXISTS ${TABLE}_probe_permissive ON public.${TABLE};\n` +
      `REVOKE ALL ON public.${TABLE} FROM PUBLIC, anon, authenticated;`, { single: true });

    if (!A) return;
    // G10b erases P itself, so the list is whoever is left.
    const who = [A, P].filter((x) => x !== "").map((x) => `'${x}'`).join(", ");
    // profiles cascades layover_sessions -> layover_crews -> this table, but the
    // grants are deleted explicitly first so the suite is re-runnable even if a
    // cascade assertion left a parent behind.
    exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.${TABLE} WHERE granted_by_user_id IN (${who}) OR crew_id = '${CREW}';\nRESET ROLE;\n` +
      `DELETE FROM public.layover_crews WHERE created_by IN (${who});\n` +
      `DELETE FROM public.layover_sessions WHERE user_id IN (${who});`, { single: true });
    deleteUser(A);
    if (P) deleteUser(P);
  });

  // ── G0 ────────────────────────────────────────────────────────────────────
  it("G0. the catalogue: RLS on, 0 permissive, 4 named restrictive client denials, no client privilege, service_role complete", () => {
    const failures: string[] = [];

    if (scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${TABLE}'::regclass`) !== "t") {
      failures.push("RLS is not enabled: every REVOKE below is decoration and service_role's bypass stops being the only way in");
    }

    const pol = rows<{ polname: string; cmd: string; permissive: boolean; roles: string[]; qual: string | null; wcheck: string | null }>(`
      SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive AS permissive,
             ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE r::regrole::text END FROM unnest(p.polroles) r) AS roles,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
        FROM pg_policy p WHERE p.polrelid = 'public.${TABLE}'::regclass`);

    // ZERO permissive. Even an own-rows policy lets a client choose its own
    // expires_at, and the bound that keeps a grant temporary is route-side
    // arithmetic over the crew's life and the granter's certified hard return.
    const permissive = pol.filter((p) => p.permissive);
    if (permissive.length !== 0) failures.push(`${permissive.length} permissive policy/policies (${permissive.map((p) => p.polname).join(", ")}), expected 0`);

    // FOUR restrictive denials, written down rather than left to RLS's bare
    // denial: "no policy at all" denies by absence and stops denying the moment
    // the absence ends, while a RESTRICTIVE policy ANDs with every later
    // permissive one. G2 is the behavioural half of this sentence.
    const restrictive = pol.filter((p) => !p.permissive);
    if (restrictive.length !== 4) failures.push(`${restrictive.length} restrictive policy/policies, expected 4`);
    const cmdOf: Record<Op, string> = { SELECT: "r", INSERT: "a", UPDATE: "w", DELETE: "d" };
    for (const op of OPS) {
      const name = `${TABLE}_deny_${op.toLowerCase()}_clients`;
      const p = pol.find((x) => x.polname === name);
      if (!p) { failures.push(`${name}: missing`); continue; }
      if (p.permissive) failures.push(`${name}: permissive, must be RESTRICTIVE`);
      if (p.cmd !== cmdOf[op]) failures.push(`${name}: names ${p.cmd}, not ${op}`);
      for (const role of ROLES) if (!p.roles.includes(role)) failures.push(`${name}: does not name ${role}`);
      const expectedQual = op === "INSERT" ? null : "false";
      const expectedCheck = op === "INSERT" || op === "UPDATE" ? "false" : null;
      if (p.qual !== expectedQual) failures.push(`${name}: USING is ${p.qual}, expected ${expectedQual}`);
      if (p.wcheck !== expectedCheck) failures.push(`${name}: WITH CHECK is ${p.wcheck}, expected ${expectedCheck}`);
    }

    // No client grant of ANY kind, read included, at table OR column level.
    for (const role of ROLES) {
      for (const priv of [...OPS, "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        if (scalar(`SELECT has_table_privilege('${role}', 'public.${TABLE}', '${priv}')`) === "t") failures.push(`${role} holds ${priv}`);
      }
      for (const priv of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        if (scalar(`SELECT has_any_column_privilege('${role}', 'public.${TABLE}', '${priv}')`) === "t") failures.push(`${role} holds a column ${priv}`);
      }
    }
    const colGrants = Number(scalar(
      `SELECT count(*) FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = '${TABLE}' AND grantee IN ('anon','authenticated')`));
    if (colGrants !== 0) failures.push(`${colGrants} client column grant(s), expected 0`);

    // And the server's path works, or the ladder loses its row source and
    // silently returns to never_granted for everybody.
    for (const op of OPS) {
      if (scalar(`SELECT has_table_privilege('service_role', 'public.${TABLE}', '${op}')`) !== "t") failures.push(`service_role lacks ${op}`);
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });

  // ── G1 ────────────────────────────────────────────────────────────────────
  it("G1. the write boundary, privilege layer: anon and authenticated are refused every operation, and the contents are unchanged after each", () => {
    assert.deepEqual(snapshot(), BASELINE, "precondition: the baseline grant must be on the table before the refusals are probed");

    const statements: Record<Op, string> = {
      SELECT: `SELECT id FROM public.${TABLE};`,
      // The forgery that matters: a client writing itself a grant and choosing
      // its own expires_at — a week, not the route's derived bound.
      INSERT: `INSERT INTO public.${TABLE} (crew_id, granted_by_user_id, session_id, expires_at)
                 VALUES ('${CREW}', '${A}', '${SESSION_A}', now() + interval '7 days');`,
      // And the same choice made by widening a grant that already exists.
      UPDATE: `UPDATE public.${TABLE} SET expires_at = now() + interval '7 days', revoked_at = NULL;`,
      DELETE: `DELETE FROM public.${TABLE};`,
    };

    for (const role of ROLES) {
      const who: Who = role === "anon" ? { role: "anon" } : { role: "authenticated", uid: A };
      for (const op of OPS) {
        const r = attemptAs(who, statements[op]);
        assert.equal(r.ok, false, `${role} ${op}: ADMITTED, expected a refusal\n${r.stdout.join("\n")}`);
        assert.equal(r.sqlstate, "42501", `${role} ${op}: refused with ${r.sqlstate}, expected 42501 insufficient_privilege\n${r.stderr}`);
        assert.match(r.stderr, new RegExp(`permission denied for table ${TABLE}`),
          `${role} ${op}: the refusal must be the privilege refusal, by table name\n${r.stderr}`);
        // THE STATE, not the return value: read the whole table back on a fresh
        // connection after EACH attempt. A refusal that still changed a row is
        // the defect this file exists to catch.
        assert.deepEqual(snapshot(), BASELINE, `${role} ${op}: the table's contents changed across a refused attempt`);
      }
    }
  });

  // ── G2 ────────────────────────────────────────────────────────────────────
  it("G2. the write boundary, policy layer: the plausible own-rows policy plus the privileges back does NOT reopen the write", () => {
    // 3516's WRITE BOUNDARY names the policy somebody will add later verbatim:
    // "a traveller may read and write their own grants", granted_by_user_id =
    // auth.uid(), "which looks unimpeachable. It is not." So add exactly that,
    // re-GRANT what the migration revoked, and show the restrictive denials
    // still refuse on their own.
    //
    // THE REOPENING IS COMMITTED, NOT WRAPPED IN AN ABORTED TRANSACTION.
    // CONTRIBUTING's rule — "a passing assertion inside an aborted transaction
    // proves nothing" — applies with full force here: a client attempt made in
    // a transaction that is about to roll back cannot be distinguished from one
    // that was refused. So the GRANT and the policy are committed, each client
    // attempt is its own connection and its own committed transaction, the state
    // is read back on yet another connection, and the reopening is undone in a
    // `finally` whose effect is re-asserted at the end of the test.
    //
    // AND WHY THE REOPENING IS NECESSARY AT ALL: 3516 revokes every client
    // privilege, so without it every attempt dies at `42501 permission denied
    // for table` BEFORE any policy is consulted (that is G1). The policies would
    // be unevidenced. Note also that dropping a restrictive deny is INVISIBLE to
    // a behavioural probe when no permissive policy is present — RLS then
    // default-denies with an identical error — which is why the four denials are
    // also asserted by name, command, roles and predicate in G0.
    //
    // Two permissive forms are tried: the one the header names, and the widest
    // one anybody could write. If the denials survive `USING (true) WITH CHECK
    // (true)` they survive anything. The own-rows form is probed as
    // `authenticated` only: for anon auth.uid() is NULL, so that predicate
    // matches nothing and a refusal would not be attributable to the restrictive
    // policy. The wide-open form is what isolates it for anon.
    const PROBE_POLICY = `${TABLE}_probe_permissive`;
    const PERMISSIVE: Array<{ label: string; clauses: string; whos: Who[] }> = [
      {
        label: "the own-rows policy the header names",
        clauses: `USING (granted_by_user_id = auth.uid()) WITH CHECK (granted_by_user_id = auth.uid())`,
        whos: [{ role: "authenticated", uid: A }],
      },
      {
        label: "a wide-open permissive policy",
        clauses: `USING (true) WITH CHECK (true)`,
        whos: [{ role: "anon" }, { role: "authenticated", uid: A }],
      },
    ];
    const close = () => exec(
      `DROP POLICY IF EXISTS ${PROBE_POLICY} ON public.${TABLE};\n` +
      `REVOKE ALL ON public.${TABLE} FROM PUBLIC, anon, authenticated;`, { single: true });

    const probed = new Set<string>();
    for (const { label, clauses, whos } of PERMISSIVE) {
      try {
        exec(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${TABLE} TO anon, authenticated;\n` +
          `CREATE POLICY ${PROBE_POLICY} ON public.${TABLE} FOR ALL TO anon, authenticated ${clauses};`,
          { single: true });

        // The reopening must really have happened, or every refusal below is
        // just G1 again and this test proves nothing about the policies.
        for (const role of ROLES) {
          for (const op of OPS) {
            assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.${TABLE}', '${op}')`), "t",
              `${label}: the probe must actually hold ${op} as ${role}, or the refusal would be the privilege refusal and not the policy's`);
          }
        }
        assert.equal(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}' AND permissive = 'PERMISSIVE'`), "1",
          `${label}: the probe's permissive policy must be in place`);

        for (const who of whos) {
          const at = `${who.role} with ${label}`;
          probed.add(who.role);

          // SELECT: a RESTRICTIVE USING (false) ANDs with the permissive
          // predicate, so the row is invisible. Who may learn that A shares
          // their location with a crew is the composed question the route layer
          // answers; a membership-scoped policy would be the weaker second
          // answer underneath it, and 3516 declined one.
          const sel = attemptAs(who, `SELECT 'visible:' || count(*) FROM public.${TABLE};`);
          assert.equal(sel.ok, true, `${at}: the SELECT must run now that the privilege is back\n${sel.stderr}`);
          assert.deepEqual(sel.stdout, ["visible:0"], `${at}: the client must still see NO grant`);

          // UPDATE: widening an existing grant to a week. Reaches no row, and
          // the table is read back on a separate connection afterwards.
          const upd = attemptAs(who, `UPDATE public.${TABLE} SET expires_at = now() + interval '7 days', revoked_at = NULL RETURNING 'updated:' || id::text;`);
          assert.equal(upd.ok, true, `${at}: the UPDATE must run and simply reach nothing\n${upd.stderr}`);
          assert.deepEqual(upd.stdout, [], `${at}: no row may have been updated`);
          assert.deepEqual(snapshot(), BASELINE, `${at}: the committed UPDATE changed the table`);

          // DELETE: erasing the record that somebody once said yes.
          const del = attemptAs(who, `DELETE FROM public.${TABLE} RETURNING 'deleted:' || id::text;`);
          assert.equal(del.ok, true, `${at}: the DELETE must run and simply reach nothing\n${del.stderr}`);
          assert.deepEqual(del.stdout, [], `${at}: no row may have been deleted`);
          assert.deepEqual(snapshot(), BASELINE, `${at}: the committed DELETE removed a row`);

          // INSERT: the client writing itself a seven-day grant — the defect the
          // whole WRITE BOUNDARY section exists to prevent, because the bound
          // that keeps a grant temporary is route-side arithmetic.
          const forged = attemptAs(who,
            `INSERT INTO public.${TABLE} (crew_id, granted_by_user_id, session_id, expires_at)\n` +
            `  VALUES ('${CREW}', '${A}', '${SESSION_A}', now() + interval '7 days');`);
          assert.equal(forged.ok, false, `${at}: the forged seven-day grant was ADMITTED\n${forged.stdout.join("\n")}`);
          assert.equal(forged.sqlstate, "42501", `${at}: refused with ${forged.sqlstate}, expected 42501\n${forged.stderr}`);
          // Matched by regex, not equality. PostgreSQL names the policy only
          // when one policy decided the row, which is the case here BECAUSE a
          // permissive policy is present and passing; a pure restrictive set is
          // reported unnamed.
          assert.match(forged.stderr,
            new RegExp(`new row violates row-level security policy "${TABLE}_deny_insert_clients" for table "${TABLE}"`),
            `${at}: the refusal must come from 3516's restrictive deny policy, BY NAME — a refusal from the absent privilege would not prove the policy carries it\n${forged.stderr}`);
          assert.deepEqual(snapshot(), BASELINE, `${at}: the refused INSERT left a row behind`);
        }
      } finally {
        close();
      }
    }

    assert.deepEqual([...probed].sort(), ["anon", "authenticated"], "both client roles must have been probed");

    // THE POSTURE IS BACK, re-asserted rather than assumed — this test mutated
    // the live catalogue, and leaving a client grant behind would be a worse
    // defect than the one it was probing for.
    assert.equal(Number(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.${TABLE}'::regclass`)), 4,
      "the probe's permissive policy must be gone again: exactly 3516's four restrictive denials remain");
    assert.equal(Number(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}' AND permissive = 'PERMISSIVE'`)), 0,
      "no permissive policy may remain");
    for (const role of ROLES) {
      for (const op of OPS) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.${TABLE}', '${op}')`), "f",
          `the probe's GRANT of ${op} to ${role} must have been revoked again`);
      }
      assert.equal(scalar(`SELECT has_any_column_privilege('${role}', 'public.${TABLE}', 'SELECT')`), "f",
        `${role} must hold no column privilege either`);
    }
    assert.deepEqual(snapshot(), BASELINE, "the policy-layer probe must have left the contents untouched");
  });

  // ── G3 ────────────────────────────────────────────────────────────────────
  it("G3. non-vacuity: service_role inserts, selects back and updates — the table works", () => {
    // Without this control, G1 and G2 would pass unchanged against a table
    // nothing at all can write, and "no client may write a grant" would be
    // evidence of a broken table rather than of a boundary.
    const before = grantCount();
    const id = serviceOk(insertGrant({ expires_at: `now() + interval '45 minutes'` }), "service_role must be able to INSERT a grant")[0]!;
    assert.match(id, /^[0-9a-f-]{36}$/, "the insert must return the new row's id");

    // Read back from a SEPARATE connection: the row is committed, not merely accepted.
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "1",
      "the inserted grant must be readable afterwards from another connection");
    assert.equal(grantCount(), before + 1, "exactly one row must have been added");
    assert.equal(serviceOk(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}';`, "service_role must be able to SELECT")[0], "1");

    serviceOk(`UPDATE public.${TABLE} SET revoked_at = now() WHERE id = '${id}';`, "service_role must be able to UPDATE a grant");
    assert.equal(scalar(`SELECT revoked_at IS NOT NULL FROM public.${TABLE} WHERE id = '${id}'`), "t",
      "the revocation must be visible in the row afterwards, not merely reported by the UPDATE");

    serviceOk(`DELETE FROM public.${TABLE} WHERE id = '${id}';`, "service_role must be able to DELETE");
    assert.equal(grantCount(), before, "the control's row must be gone again");
  });

  // ── G4 ────────────────────────────────────────────────────────────────────
  it("G4. a grant with no window is not expressible: expires_at is NOT NULL with no default, and omitting it is refused", () => {
    // The catalogue half. Both are asserted because either alone is defeatable:
    // a nullable column admits the "forever" §14 L4 has no word for, and a
    // default admits a duration nobody chose.
    const col = rows<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${TABLE}' AND column_name = 'expires_at'`);
    assert.equal(col.length, 1, "expires_at must exist");
    assert.equal(col[0]!.is_nullable, "NO", "expires_at must be NOT NULL: NULL would be the 'forever' the ladder has no word for");
    assert.equal(col[0]!.column_default, null, "expires_at must have NO default: a default is a duration, and no duration has been chosen for a §14 L4 grant");

    // The behavioural half, which is the one a default would silently defeat.
    const before = snapshot();
    const r = asService(insertGrant({ expires_at: "OMIT" }));
    assert.equal(r.ok, false, `an INSERT omitting expires_at was ADMITTED — a grant with no window must not be expressible\n${r.stdout.join("\n")}`);
    assert.equal(r.sqlstate, "23502", `refused with ${r.sqlstate}, expected 23502 not_null_violation\n${r.stderr}`);
    assert.equal(r.column, "expires_at", `the refusal must name expires_at, not another column (it named ${r.column})\n${r.stderr}`);
    assert.deepEqual(snapshot(), before, "no row may have been defaulted into existence");

    // An explicit NULL is refused by the same column, for the same reason.
    const explicitNull = asService(insertGrant({ expires_at: "NULL" }));
    assert.equal(explicitNull.ok, false, "an explicit NULL expires_at was ADMITTED");
    assert.equal(explicitNull.sqlstate, "23502", explicitNull.stderr);
    assert.equal(explicitNull.column, "expires_at", explicitNull.stderr);
    assert.deepEqual(snapshot(), before, "no row may have been written by the explicit-NULL attempt");
  });

  // ── G5 ────────────────────────────────────────────────────────────────────
  it("G5. layover_crew_location_grants_positive_window refuses expires_at equal to and earlier than granted_at", () => {
    const CONSTRAINT = `${TABLE}_positive_window`;
    const before = snapshot();

    // Equal: not a short grant, a row that reads as a grant and authorises
    // nothing — locationPrecisionFor would report no_live_grant:ttl_elapsed,
    // blaming the TTL for a write that was never valid.
    const cases: Array<[string, Record<string, string>]> = [
      ["expires_at = granted_at", { granted_at: `'2026-10-03T12:00:00Z'`, expires_at: `'2026-10-03T12:00:00Z'` }],
      ["expires_at < granted_at", { granted_at: `'2026-10-03T12:00:00Z'`, expires_at: `'2026-10-03T11:00:00Z'` }],
    ];
    for (const [label, over] of cases) {
      const r = asService(insertGrant(over));
      assert.equal(r.ok, false, `${label} was ADMITTED\n${r.stdout.join("\n")}`);
      assert.equal(r.sqlstate, "23514", `${label}: refused with ${r.sqlstate}, expected 23514 check_violation\n${r.stderr}`);
      assert.equal(r.constraint, CONSTRAINT,
        `${label}: refused by ${r.constraint}, not by ${CONSTRAINT} — a test that passes on the wrong error is not evidence\n${r.stderr}`);
      assert.deepEqual(snapshot(), before, `${label}: no row may have been written`);
    }

    // One microsecond of window is admitted: the CHECK is the stated predicate
    // and not a disguised minimum TTL. 3516 chooses no duration.
    const ok = asService(insertGrant({ granted_at: `'2026-10-03T12:00:00Z'`, expires_at: `'2026-10-03T12:00:00.000001Z'` }));
    assert.equal(ok.ok, true, `a positive window of one microsecond must be admitted — 3516 states no minimum TTL\n${ok.stderr}`);
    serviceOk(`DELETE FROM public.${TABLE} WHERE id = '${ok.stdout[0]}';`, "cleanup of the positive-window control");
    assert.deepEqual(snapshot(), before, "the control row must be gone again");
  });

  // ── G6 ────────────────────────────────────────────────────────────────────
  it("G6. layover_crew_location_grants_revocation_after_grant refuses a revoked_at before granted_at", () => {
    const CONSTRAINT = `${TABLE}_revocation_after_grant`;
    const before = snapshot();
    const at = (t: string) => ({ granted_at: `'2026-10-03T12:00:00Z'`, expires_at: `'2026-10-03T18:00:00Z'`, revoked_at: `'${t}'` });

    // A revocation before the grant is not a shorter grant, it is an impossible
    // row: evaluateCrewLocationShare takes the EARLIEST terminator at or before
    // now, so it would report user_revoked at an instant preceding the consent
    // it claims to withdraw.
    const r = asService(insertGrant(at("2026-10-03T11:59:59Z")));
    assert.equal(r.ok, false, `a revoked_at before granted_at was ADMITTED\n${r.stdout.join("\n")}`);
    assert.equal(r.sqlstate, "23514", `refused with ${r.sqlstate}, expected 23514\n${r.stderr}`);
    assert.equal(r.constraint, CONSTRAINT, `refused by ${r.constraint}, not by ${CONSTRAINT}\n${r.stderr}`);
    assert.deepEqual(snapshot(), before, "no impossible row may have been written");

    // Equal and later are admitted — the predicate is `>=`, so an instant
    // revocation is expressible.
    for (const t of ["2026-10-03T12:00:00Z", "2026-10-03T13:00:00Z"]) {
      const ok = asService(insertGrant(at(t)));
      assert.equal(ok.ok, true, `revoked_at = ${t} must be admitted\n${ok.stderr}`);
      assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${ok.stdout[0]}' AND revoked_at = '${t}'`), "1",
        `the admitted row must carry revoked_at = ${t}`);
      serviceOk(`DELETE FROM public.${TABLE} WHERE id = '${ok.stdout[0]}';`, "cleanup of the revocation control");
    }
    assert.deepEqual(snapshot(), before, "the controls' rows must be gone again");
  });

  // ── G7 ────────────────────────────────────────────────────────────────────
  it("G7. re-granting after a REVOCATION works: both rows coexist for one (crew_id, granted_by_user_id) pair", () => {
    // The unqualified unique index "one grant per person per crew" would forbid
    // exactly this: a traveller who revoked and changed their mind could not say
    // yes again without the row they already have being deleted — and deleting
    // it is what REVOCATION IS A COLUMN refuses.
    const g1 = serviceOk(insertGrant({ granted_at: `now() - interval '2 hours'`, expires_at: `now() + interval '4 hours'` }), "the first grant")[0]!;
    serviceOk(`UPDATE public.${TABLE} SET revoked_at = now() - interval '90 minutes' WHERE id = '${g1}';`, "the revocation");
    assert.equal(scalar(`SELECT revoked_at IS NOT NULL FROM public.${TABLE} WHERE id = '${g1}'`), "t", "the first grant must be revoked");

    const g2 = serviceOk(insertGrant({ granted_at: `now() - interval '1 hour'`, expires_at: `now() + interval '5 hours'` }),
      "re-granting after a revocation must be possible: an unqualified unique index on (crew_id, granted_by_user_id) would refuse this")[0]!;

    const live = grantsOf(CREW, A).filter((g) => g.id === g1 || g.id === g2);
    assert.equal(live.length, 2, "BOTH rows must coexist: one act of consent per row, and the revoked one is the only record that the traveller once said yes");
    assert.deepEqual(live.map((g) => g.id), [g2, g1], "newest-first is the read the ladder makes, whatever the revocation state");
    assert.notEqual(live.find((g) => g.id === g1)!.revoked_at, null, "the older row must still carry its revocation");
    assert.equal(live.find((g) => g.id === g2)!.revoked_at, null, "the re-grant must be live");

    serviceOk(`DELETE FROM public.${TABLE} WHERE id IN ('${g1}', '${g2}');`, "cleanup of the re-grant-after-revocation pair");
    assert.deepEqual(snapshot(), BASELINE, "the pair must be gone again");
  });

  it("G7b. re-granting after an EXPIRY works too — the partial WHERE revoked_at IS NULL index would refuse this one", () => {
    // Expiry is the common case, so the partial form is the one that breaks the
    // feature in ordinary use: an expired-but-unrevoked row is still a row and
    // would block the new one.
    const expired = serviceOk(insertGrant({ granted_at: `now() - interval '3 hours'`, expires_at: `now() - interval '2 hours'` }),
      "a grant may be inserted that has already run out (granted_at < expires_at < now)")[0]!;
    assert.equal(scalar(`SELECT expires_at < now() AND revoked_at IS NULL FROM public.${TABLE} WHERE id = '${expired}'`), "t",
      "the first row must be expired and NOT revoked — that is the state the partial index would key on");

    const renewed = serviceOk(insertGrant({ granted_at: `now() - interval '1 minute'`, expires_at: `now() + interval '2 hours'` }),
      "renewing after an expiry must be possible: a partial unique index WHERE revoked_at IS NULL would refuse this")[0]!;

    const both = grantsOf(CREW, A).filter((g) => g.id === expired || g.id === renewed);
    assert.equal(both.length, 2, "the expired row and its renewal must coexist");
    assert.deepEqual(both.map((g) => g.id), [renewed, expired], "newest-first: the renewal is the one in force");
    assert.equal(both.every((g) => g.revoked_at === null), true, "neither row is revoked — so only a PARTIAL unique index could have been in the way, and it is not");

    // And the catalogue, from the other direction: NEITHER form of the index
    // exists. The primary key on (id) is the only unique index on the table.
    const unique = rows<{ idx: string; cols: string; pred: string | null }>(`
      SELECT i.relname AS idx,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
               WHERE a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey::int2[])) AS cols,
             pg_get_expr(x.indpred, x.indrelid) AS pred
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indrelid = 'public.${TABLE}'::regclass AND x.indisunique`);
    assert.deepEqual(unique.map((u) => `${u.idx}|${u.cols}|${u.pred ?? ""}`), [`${TABLE}_pkey|id|`],
      "the primary key on (id) must be the ONLY unique index: a unique index over (crew_id, granted_by_user_id), in either form, would forbid one of the two re-grants above");
    assert.equal(
      unique.filter((u) => u.cols.split(",").includes("crew_id") && u.cols.split(",").includes("granted_by_user_id")).length, 0,
      "no unique index may cover (crew_id, granted_by_user_id)");

    serviceOk(`DELETE FROM public.${TABLE} WHERE id IN ('${expired}', '${renewed}');`, "cleanup of the expiry-then-renewal pair");
    assert.deepEqual(snapshot(), BASELINE, "the pair must be gone again");
  });

  // ── G8 ────────────────────────────────────────────────────────────────────
  it("G8. revocation preserves the row: granted_at and expires_at survive it intact", () => {
    // Deleting the row on revocation would collapse user_revoked into
    // never_granted — "the two are different answers and only one of them means
    // a traveller once said yes". So the row must still be READABLE afterwards,
    // with the window it originally recorded.
    const id = serviceOk(insertGrant({ granted_at: `now() - interval '20 minutes'`, expires_at: `now() + interval '40 minutes'` }), "the grant to revoke")[0]!;
    const original = rows<GrantRow>(
      `SELECT id::text, crew_id::text, granted_by_user_id::text, session_id::text,
              to_json(granted_at)#>>'{}' AS granted_at, to_json(expires_at)#>>'{}' AS expires_at,
              to_json(revoked_at)#>>'{}' AS revoked_at
         FROM public.${TABLE} WHERE id = '${id}'`)[0]!;
    assert.equal(original.revoked_at, null, "it must start unrevoked");

    serviceOk(`UPDATE public.${TABLE} SET revoked_at = now() WHERE id = '${id}';`, "the revocation");

    const after = rows<GrantRow>(
      `SELECT id::text, crew_id::text, granted_by_user_id::text, session_id::text,
              to_json(granted_at)#>>'{}' AS granted_at, to_json(expires_at)#>>'{}' AS expires_at,
              to_json(revoked_at)#>>'{}' AS revoked_at
         FROM public.${TABLE} WHERE id = '${id}'`);
    assert.equal(after.length, 1, "the revoked grant must STILL BE PRESENT: a reader that cannot see it reports never_granted for somebody who actually revoked");
    assert.notEqual(after[0]!.revoked_at, null, "revoked_at must be set");
    assert.equal(after[0]!.granted_at, original.granted_at, "granted_at must be untouched by the revocation — it is when consent was given, not when it ended");
    assert.equal(after[0]!.expires_at, original.expires_at, "expires_at must be untouched: revocation is not expiry, and the two terminators stay distinguishable");
    assert.equal(after[0]!.crew_id, original.crew_id, "the scope must be untouched");
    assert.equal(after[0]!.session_id, original.session_id, "the session must be untouched");

    serviceOk(`DELETE FROM public.${TABLE} WHERE id = '${id}';`, "cleanup of the revocation fixture");
    assert.deepEqual(snapshot(), BASELINE, "the fixture must be gone again");
  });

  // ── G9 ────────────────────────────────────────────────────────────────────
  it("G9. layover_crew_location_grants_newest_idx exists, is not unique, and is NOT PARTIAL", () => {
    const idx = rows<{ idx: string; def: string; is_unique: boolean; pred: string | null }>(`
      SELECT i.relname AS idx, pg_get_indexdef(x.indexrelid) AS def, x.indisunique AS is_unique,
             pg_get_expr(x.indpred, x.indrelid) AS pred
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indrelid = 'public.${TABLE}'::regclass AND i.relname = '${TABLE}_newest_idx'`);
    assert.equal(idx.length, 1, "the newest-grant index must exist: it serves both the ladder's read and revocation's write");
    assert.equal(idx[0]!.is_unique, false, "it must not be unique — see G7/G7b: grants accumulate, one row per act of consent");
    assert.match(idx[0]!.def, /\(crew_id, granted_by_user_id, granted_at DESC\)/,
      `it must index (crew_id, granted_by_user_id, granted_at DESC) — the read the ladder makes\n${idx[0]!.def}`);

    // THE MISTAKE THIS ASSERTS AGAINST: a PARTIAL index `WHERE revoked_at IS
    // NULL`. That is the index for a read that SKIPS REVOKED ROWS — and a reader
    // that skips them cannot see a revocation at all, so it reports
    // never_granted for a traveller who said yes and then took it back. pg_index
    // .indpred is the predicate of a partial index and is NULL when there is none.
    assert.equal(idx[0]!.pred, null,
      `the index must have NO WHERE clause: its predicate is ${idx[0]!.pred}, and a partial index on revoked_at IS NULL would be the index for a read that cannot name user_revoked`);
    assert.equal(scalar(`SELECT indpred IS NULL FROM pg_index WHERE indexrelid = 'public.${TABLE}_newest_idx'::regclass`), "t",
      "pg_index.indpred must be NULL, read directly");
    assert.doesNotMatch(idx[0]!.def, /\bWHERE\b/, `the index definition must carry no WHERE clause\n${idx[0]!.def}`);
  });

  // ── G10 ───────────────────────────────────────────────────────────────────
  it("G10. ON DELETE CASCADE from layover_crews removes the grant", () => {
    // 2984 cascades crew_id and layoverCrewExpiryScheduler deletes expired
    // crews, so every grant row goes with its crew. That is the whole retention
    // answer for this table — there is no second sweep, and must not be one.
    const crew2 = randomUUID();
    exec(`INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, expires_at)
            VALUES ('${crew2}', 'L4 Cascade City', '${A}', '${SESSION_A}', 'l4 cascade crew', now() + interval '2 hours');`);
    const id = serviceOk(insertGrant({ crew_id: `'${crew2}'` }), "the grant on the doomed crew")[0]!;
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "1", "the grant must exist before the crew is deleted");

    exec(`DELETE FROM public.layover_crews WHERE id = '${crew2}';`);

    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "0", "deleting the crew must have removed the grant");
    // And nothing else went with it: the cascade under test is crew_id's alone.
    assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${A}'`), "1", "the granter must survive");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_sessions WHERE id = '${SESSION_A}'`), "1", "the session must survive");
    assert.deepEqual(snapshot(), BASELINE, "only the doomed grant may have gone");
  });

  it("G10b. ON DELETE CASCADE from profiles removes the grant", () => {
    // The granter's erasure takes their recorded acts of consent with it. P is a
    // granter with no session and no crew of its own, so this deletion can reach
    // the grant by the granted_by_user_id FK and by no other path.
    const id = serviceOk(insertGrant({ granted_by_user_id: `'${P}'` }), "the grant from the doomed granter")[0]!;
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "1", "the grant must exist before the profile is deleted");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_sessions WHERE user_id = '${P}'`), "0",
      "P must own no session, or this test could not tell the profiles cascade from the sessions cascade");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_crews WHERE created_by = '${P}'`), "0", "P must own no crew, for the same reason");

    deleteUser(P);
    P = ""; // after() must not try again

    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "0", "deleting the granter's profile must have removed the grant");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_crews WHERE id = '${CREW}'`), "1", "the crew must survive");
    assert.deepEqual(snapshot(), BASELINE, "only the doomed grant may have gone");
  });

  it("G10c. ON DELETE CASCADE from layover_sessions removes the grant", () => {
    // session_expired is one of §14.1's five terminators; session_id is what
    // makes it derivable rather than guessed, and the row does not outlive the
    // session it names.
    const session2 = randomUUID();
    exec(`INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time)
            VALUES ('${session2}', '${A}', now(), now() + interval '3 hours');`);
    const id = serviceOk(insertGrant({ session_id: `'${session2}'` }), "the grant on the doomed session")[0]!;
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "1", "the grant must exist before the session is deleted");

    exec(`DELETE FROM public.layover_sessions WHERE id = '${session2}';`);

    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE id = '${id}'`), "0", "deleting the session must have removed the grant");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_crews WHERE id = '${CREW}'`), "1", "the crew must survive");
    assert.equal(scalar(`SELECT count(*) FROM public.profiles WHERE id = '${A}'`), "1", "the granter must survive");
    assert.deepEqual(snapshot(), BASELINE, "only the doomed grant may have gone");
  });

  // ── G11 ───────────────────────────────────────────────────────────────────
  it("G11. no coordinate column: not on the grant store, and not on 2984's crew tables either", () => {
    // THIS FILE STORES PERMISSION, NOT POSITION. A stale grant grants nothing,
    // because evaluateCrewLocationShare is evaluated against the clock at read
    // time; a stale POSITION is a traveller's whereabouts, published for as long
    // as nothing deletes it. 3516's postcondition re-checks 2984's tables from
    // here so that applying the grant store is not read as licence to add one
    // next door, and this is the same assertion against the live database.
    const TABLES = [TABLE, "layover_crews", "layover_crew_members"] as const;
    // The migration's own exact list, plus a token match that also catches
    // lat_deg, pickup_lng, geom_4326 and the rest of the near misses.
    const EXACT = ["lat", "lng", "latitude", "longitude", "location", "geog", "geom", "point", "coords"];
    const found = rows<{ tbl: string; col: string }>(`
      SELECT table_name AS tbl, column_name AS col
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (${TABLES.map((t) => `'${t}'`).join(", ")})
         AND (column_name IN (${EXACT.map((c) => `'${c}'`).join(", ")})
              OR column_name ~ '(^|_)(lat|lng|latitude|longitude|geog|geom|coord|coords)($|_)')
       ORDER BY 1, 2`);
    assert.deepEqual(found, [],
      `coordinate column(s) found: ${found.map((f) => `${f.tbl}.${f.col}`).join(", ")}. This table is the thing that DECIDES whether a position may be shown; a column to hold one here is the exact ordering 2984 refused, and where a position is eventually held is a separate decision with its own retention answer.`);

    // And the table holds what it is supposed to hold, so the assertion above
    // cannot be passing by looking at the wrong relation.
    assert.deepEqual(
      rows<{ col: string }>(`SELECT column_name AS col FROM information_schema.columns
                              WHERE table_schema = 'public' AND table_name = '${TABLE}' ORDER BY 1`).map((c) => c.col),
      ["created_at", "crew_id", "expires_at", "granted_at", "granted_by_user_id", "id", "revoked_at", "session_id"],
      "the grant store's columns are exactly who said yes, to which crew, from which session, from when, until when, and whether they revoked");
  });
});
