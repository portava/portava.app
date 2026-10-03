/**
 * layoverCrewItineraryBoundary — the probe migration 3513 names in its own
 * header section "WHERE THE REAL-RLS EVIDENCE LIVES", run against real
 * PostgreSQL with real rows and real roles.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 *      (or LOCAL_DB_URL=postgresql://… node --import tsx/esm --test
 *       src/test/db/layoverCrewItineraryBoundary.db.test.ts)
 * Skips without a database, like every src/test/db suite;
 * scripts/local-db/run-tests.sh is the run that refuses skipped > 0.
 *
 * ── WHY IT IS NOT IN THE MIGRATION ───────────────────────────────────────────
 * 3513's own header: a probe inside the migration's transaction can only undo
 * itself by aborting, which rolls back the DDL batched with it while the
 * migration still reports success (2195's defect, which
 * src/test/migrationDeployability.test.ts forbids). So 3513 inserts nothing and
 * assumes no role, and every assertion here is made from a SEPARATE psql
 * connection — localDb.psql() is one process per call — against the committed
 * database, never from inside an aborted transaction.
 *
 * ── WHAT EACH ASSERTION IS ABOUT ─────────────────────────────────────────────
 * CONTRIBUTING.md: "verify the resulting STATE, not the return value", and a
 * check that cannot establish its result must FAIL. So every refusal here is
 * checked twice: the statement is refused with the SQLSTATE and the constraint
 * or policy NAME that 3513 relies on (a refusal for the wrong reason is not
 * evidence), AND the table's contents are re-read afterwards and asserted
 * unchanged. Every admitted write is read back before it is believed.
 *
 * PROPERTIES
 *   B0  catalogue: the facts only the catalogue can state — no coordinate
 *       column, no default on travel_min, no unique index over stop_order, the
 *       composite PK, and the eight restrictive denials.
 *   B1  anon and authenticated cannot SELECT / INSERT / UPDATE / DELETE either
 *       table: 42501, and the contents are unchanged afterwards.
 *   B2  the four RESTRICTIVE deny policies bite ON THEIR OWN — with the revoked
 *       privilege GRANTed back, the client still reads no row, writes nothing
 *       and is refused its INSERT by policy name. (B1 alone would still pass if
 *       the policies were missing and only the grants were revoked, which is
 *       exactly the failure 3513's header says a bare "no policy" cannot cover.)
 *   B3  NON-VACUITY: service_role performs every write the crew routes need and
 *       the row is read back from another connection. Without this, "nothing can
 *       write" would pass against a table that simply does not work.
 *   B4  the CHECK constraints refuse the values the header says they refuse.
 *   B5  travel_min has no default: an INSERT omitting it is refused (23502),
 *       not silently zeroed.
 *   B6  two stops may share a stop_order in one branch (no uniqueness race).
 *   B7  ON DELETE CASCADE from layover_crews removes stops and assignments.
 *   B8  PRIMARY KEY (crew_id, user_id): one branch per person per crew.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const STOPS = "layover_crew_stops";
const ASSIGNMENTS = "layover_crew_branch_assignments";
const OPS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Op = (typeof OPS)[number];
const CLIENT_ROLES = ["anon", "authenticated"] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];

let A = ""; // the crew's founder, and the proposer of the baseline stop
let B = ""; // a second member, for the composite-PK probe
let SESSION = "";
let CREW = "";
let BASE_STOP = "";

/* ── running a statement as somebody ─────────────────────────────────────── */

/** The PostgREST path: the client role plus the JWT GUCs auth.uid() reads. */
function prelude(role: ClientRole, uid: string | null): string {
  const claims = [`PERFORM set_config('request.jwt.claim.role', '${role}', true);`];
  if (uid) claims.unshift(`PERFORM set_config('request.jwt.claim.sub', '${uid}', true);`);
  return `\\set VERBOSITY verbose\nDO $p$ BEGIN ${claims.join(" ")} END $p$;\nSET LOCAL ROLE ${role};\n`;
}

function asClient(role: ClientRole, sql: string) {
  return psql(prelude(role, role === "authenticated" ? A : null) + sql, { single: true });
}

/** The server path: the role the API's service client is. */
function asService(sql: string) {
  return psql(`\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${sql}`, { single: true });
}

function serviceOk(sql: string): string[] {
  const r = asService(sql);
  assert.equal(r.status, 0, `service_role must be able to run this:\n${sql}\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

interface Refusal { code: string; message: string; constraint: string | null; column: string | null }

/** The SQLSTATE and names PostgreSQL reported, or null when the statement was ADMITTED. */
function refusalOf(r: { status: number; stderr: string }): Refusal | null {
  if (r.status === 0) return null;
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(r.stderr);
  return {
    code: m ? m[1]! : "?????",
    message: m ? m[2]!.trim() : r.stderr.trim().split("\n")[0] ?? "",
    constraint: /CONSTRAINT NAME:\s+(\S+)/.exec(r.stderr)?.[1] ?? null,
    column: /COLUMN NAME:\s+(\S+)/.exec(r.stderr)?.[1] ?? null,
  };
}

/* ── observing the state, always from a fresh superuser connection ───────── */

interface StopRow { id: string; branch_id: string; stop_order: number; title: string; duration_min: number; travel_min: number; inside_airport: boolean; location_label: string | null; proposed_by: string }
interface AssignmentRow { crew_id: string; user_id: string; branch_id: string; assigned_by: string }

function stopsOf(crew: string): StopRow[] {
  return rows<StopRow>(
    `SELECT id::text, branch_id, stop_order, title, duration_min, travel_min, inside_airport,
            location_label, proposed_by::text
       FROM public.${STOPS} WHERE crew_id = '${crew}' ORDER BY stop_order, created_at, id`,
  );
}

function assignmentsOf(crew: string): AssignmentRow[] {
  return rows<AssignmentRow>(
    `SELECT crew_id::text, user_id::text, branch_id, assigned_by::text
       FROM public.${ASSIGNMENTS} WHERE crew_id = '${crew}' ORDER BY user_id`,
  );
}

/** Whole-table counts too: a probe with no WHERE clause could hit somebody else's row. */
function totals(): { stops: number; assignments: number } {
  return {
    stops: Number(scalar(`SELECT count(*) FROM public.${STOPS};`)),
    assignments: Number(scalar(`SELECT count(*) FROM public.${ASSIGNMENTS};`)),
  };
}

interface World { stops: StopRow[]; assignments: AssignmentRow[]; totals: { stops: number; assignments: number } }
function world(): World {
  return { stops: stopsOf(CREW), assignments: assignmentsOf(CREW), totals: totals() };
}

/* ── the statements under probe ──────────────────────────────────────────── */

const STOP_COLUMNS = ["crew_id", "branch_id", "stop_order", "title", "duration_min", "travel_min", "inside_airport", "location_label", "proposed_by"] as const;
type StopColumn = (typeof STOP_COLUMNS)[number];

/**
 * One stop INSERT. `over` replaces a column's SQL, `omit` leaves the column out
 * entirely (B5's case), and `id` pins the row so a later read can find exactly it.
 */
function insertStop(over: Partial<Record<StopColumn, string>> = {}, omit: readonly StopColumn[] = [], id: string | null = null): string {
  const v: Record<StopColumn, string> = {
    crew_id: `'${CREW}'`,
    branch_id: `'all'`,
    stop_order: "0",
    title: `'probe stop'`,
    duration_min: "30",
    travel_min: "10",
    inside_airport: "true",
    location_label: `'Terminal 2 food court'`,
    proposed_by: `'${A}'`,
    ...over,
  };
  const cols = STOP_COLUMNS.filter((c) => !omit.includes(c));
  const names = [...(id ? ["id"] : []), ...cols];
  const values = [...(id ? [`'${id}'`] : []), ...cols.map((c) => v[c])];
  return `INSERT INTO public.${STOPS} (${names.join(", ")}) VALUES (${values.join(", ")})`;
}

function insertAssignment(over: { crew_id?: string; user_id?: string; branch_id?: string; assigned_by?: string } = {}): string {
  const v = { crew_id: `'${CREW}'`, user_id: `'${B}'`, branch_id: `'north'`, assigned_by: `'${A}'`, ...over };
  return `INSERT INTO public.${ASSIGNMENTS} (crew_id, user_id, branch_id, assigned_by) VALUES (${v.crew_id}, ${v.user_id}, ${v.branch_id}, ${v.assigned_by})`;
}

/** What a client would attempt, per table per operation, against rows that DO exist. */
function clientAttempt(table: string, op: Op): string {
  if (table === STOPS) {
    switch (op) {
      case "SELECT": return `SELECT id::text, title FROM public.${STOPS};`;
      case "INSERT": return `${insertStop({ title: `'client wrote this'` })};`;
      case "UPDATE": return `UPDATE public.${STOPS} SET title = 'client hijacked this';`;
      case "DELETE": return `DELETE FROM public.${STOPS};`;
    }
  }
  switch (op) {
    case "SELECT": return `SELECT user_id::text, branch_id FROM public.${ASSIGNMENTS};`;
    case "INSERT": return `${insertAssignment({ user_id: `'${A}'`, branch_id: `'client wrote this'` })};`;
    case "UPDATE": return `UPDATE public.${ASSIGNMENTS} SET branch_id = 'client hijacked this';`;
    case "DELETE": return `DELETE FROM public.${ASSIGNMENTS};`;
  }
}

describe("3513 — the crew itinerary's write boundary, on a real database", { skip: !HAVE_DB }, () => {
  before(() => {
    // The chain must already be applied. A missing table is a SETUP FAILURE and
    // must not look like a pass, so it throws here rather than skipping.
    for (const t of [STOPS, ASSIGNMENTS]) {
      assert.equal(
        scalar(`SELECT to_regclass('public.${t}')::text;`), t,
        `${t} does not exist — apply 3513 before running this suite; this suite must not pass without it`,
      );
    }

    A = seedUser("l3513_a");
    B = seedUser("l3513_b");
    SESSION = randomUUID();
    CREW = randomUUID();
    BASE_STOP = randomUUID();
    exec(
      `INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time)
         VALUES ('${SESSION}', '${A}', NOW(), NOW() + INTERVAL '8 hours');
       INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, expires_at)
         VALUES ('${CREW}', 'doha', '${A}', '${SESSION}', '3513 probe crew', NOW() + INTERVAL '8 hours');`,
    );
    // The baseline itinerary, written through the role the routes use, so the
    // deny probes below have a REAL row to fail to read, change or remove.
    serviceOk(
      `${insertStop({ title: `'baseline stop'` }, [], BASE_STOP)};
       ${insertAssignment({ user_id: `'${A}'`, branch_id: `'all'` })};`,
    );
    const seeded = world();
    assert.equal(seeded.stops.length, 1, "setup failed: the baseline stop was not written");
    assert.equal(seeded.stops[0]!.id, BASE_STOP, "setup failed: the baseline stop is not the row this suite probes");
    assert.equal(seeded.assignments.length, 1, "setup failed: the baseline assignment was not written");
  });

  after(() => {
    // Re-runnable: the crew cascades its stops and assignments away (B7 proves
    // that cascade is real), then the users go.
    if (CREW) exec(`DELETE FROM public.layover_crews WHERE id = '${CREW}';`);
    if (SESSION) exec(`DELETE FROM public.layover_sessions WHERE id = '${SESSION}';`);
    if (A) deleteUser(A);
    if (B) deleteUser(B);
  });

  it("B0. the catalogue states what only the catalogue can: no coordinate, no travel_min default, no unique stop_order, the composite PK, eight restrictive denials", () => {
    // NO COORDINATES — the one claim in 3513's WHAT IS DELIBERATELY NOT IN
    // THESE TABLES that no row can evidence: an absent column cannot be probed.
    const coords = rows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('${STOPS}', '${ASSIGNMENTS}')
          AND column_name IN ('lat','lng','latitude','longitude','location','geog','geom','point','coords')`,
    );
    assert.deepEqual(coords, [], "3513 carries no coordinate column: branchNeededMinutes reads none");

    // travel_min: NO DEFAULT. `layover_plan_stops` carries DEFAULT 0 and that
    // difference is the whole of 3513's TRAVEL TIME section, so both are read.
    assert.equal(
      scalar(`SELECT coalesce(column_default, '<none>') FROM information_schema.columns
               WHERE table_schema='public' AND table_name='${STOPS}' AND column_name='travel_min';`),
      "<none>", "a default on travel_min turns an unstated landside journey into a measured zero (census L47)",
    );
    assert.equal(
      scalar(`SELECT coalesce(column_default, '<none>') FROM information_schema.columns
               WHERE table_schema='public' AND table_name='layover_plan_stops' AND column_name='travel_min';`),
      "0", "the contrast 3513 argues with: the solo table does default travel_min to 0",
    );

    // stop_order: NOT unique, and the index that does exist is the itinerary read.
    assert.equal(
      scalar(`SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
               WHERE t.relnamespace = 'public'::regnamespace AND t.relname = '${STOPS}' AND i.indisunique
                 AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid
                              AND a.attnum = ANY (i.indkey::int[]) AND a.attname = 'stop_order');`),
      "0", "a unique index over stop_order makes two members proposing at once a 23505 for whichever lost",
    );

    // ONE BRANCH PER PERSON PER CREW, as the composite PK it must be.
    assert.equal(
      scalar(`SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
               WHERE t.relnamespace = 'public'::regnamespace AND t.relname = '${ASSIGNMENTS}' AND c.contype = 'p'
               GROUP BY c.oid;`),
      "crew_id,user_id", "a PK on crew_id alone allows one assignment per crew; on user_id alone, one branch per person ever",
    );

    // RLS on, the eight denials written down, no permissive policy, no client grant.
    const posture = rows<{ tbl: string; rls: boolean; restrictive: number; permissive: number; client_grants: number }>(
      `SELECT c.relname AS tbl, c.relrowsecurity AS rls,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname AND p.permissive='RESTRICTIVE')::int AS restrictive,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname AND p.permissive='PERMISSIVE')::int AS permissive,
              (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema='public' AND g.table_name=c.relname AND g.grantee IN ('anon','authenticated'))::int AS client_grants
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('${STOPS}', '${ASSIGNMENTS}')
        ORDER BY c.relname`,
    );
    assert.deepEqual(posture, [
      { tbl: ASSIGNMENTS, rls: true, restrictive: 4, permissive: 0, client_grants: 0 },
      { tbl: STOPS, rls: true, restrictive: 4, permissive: 0, client_grants: 0 },
    ], "RLS on, four restrictive client denials per table, no permissive policy, no client grant of any kind");

    // Named, per operation, per client role — a count of four could be four SELECTs.
    const denials = rows<{ tbl: string; polname: string; cmd: string; roles: string; qual: string | null; wcheck: string | null }>(
      `SELECT c.relname AS tbl, p.polname, p.polcmd::text AS cmd,
              (SELECT string_agg(r::regrole::text, ',' ORDER BY r::regrole::text) FROM unnest(p.polroles) r) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('${STOPS}', '${ASSIGNMENTS}') AND NOT p.polpermissive
        ORDER BY c.relname, p.polcmd::text`,
    );
    const expected = [ASSIGNMENTS, STOPS].flatMap((t) =>
      ([["a", "INSERT"], ["d", "DELETE"], ["r", "SELECT"], ["w", "UPDATE"]] as const).map(([cmd, op]) => ({
        tbl: t, polname: `${t}_deny_${op.toLowerCase()}_clients`, cmd, roles: "anon,authenticated",
        qual: op === "INSERT" ? null : "false",
        wcheck: op === "INSERT" || op === "UPDATE" ? "false" : null,
      })),
    );
    assert.deepEqual(denials, expected, "each of the four operations is denied by name, for both client roles, with a false predicate");
  });

  for (const table of [STOPS, ASSIGNMENTS]) {
    for (const role of CLIENT_ROLES) {
      it(`B1. ${role} cannot SELECT, INSERT, UPDATE or DELETE ${table}, and its contents are unchanged`, () => {
        const before_ = world();
        assert.ok(before_.stops.length > 0 && before_.assignments.length > 0, "the probe needs real rows to fail against");
        for (const op of OPS) {
          const sql = clientAttempt(table, op);
          const r = asClient(role, sql);
          const refusal = refusalOf(r);
          assert.ok(refusal, `${role} ${op} on ${table} was ADMITTED:\n${sql}\n${r.stdout}`);
          assert.equal(refusal.code, "42501", `${role} ${op} on ${table} must be refused as insufficient privilege, not for some other reason:\n${r.stderr}`);
          assert.equal(refusal.message, `permission denied for table ${table}`,
            `${role} ${op} on ${table}: the refusal must be the revoked grant, by table name:\n${r.stderr}`);
          assert.equal(r.stdout.trim(), "", `${role} ${op} on ${table} returned output, so something was read or written`);
        }
        assert.deepEqual(world(), before_, `${role} changed ${table} despite every operation being refused`);
      });
    }
  }

  it("B2. the four RESTRICTIVE policies bite on their own: with the revoked privileges GRANTed back, a client still reads nothing, writes nothing and is refused by policy name", () => {
    // B1 passes on revoked grants alone. 3513's header is explicit that denial
    // by ABSENCE is the failure mode a later permissive policy reopens, so the
    // policies are probed with the privilege present. The GRANT is COMMITTED
    // (an assertion inside an aborted transaction proves nothing) and taken
    // back in the finally, which then re-asserts the posture.
    const before_ = world();
    const granted: string[] = [];
    try {
      for (const t of [STOPS, ASSIGNMENTS]) {
        exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${t} TO anon, authenticated;`);
        granted.push(t);
      }
      for (const role of CLIENT_ROLES) {
        assert.equal(
          scalar(`SELECT count(*) FILTER (WHERE has_table_privilege('${role}', 'public.' || t, 'SELECT')) FROM (VALUES ('${STOPS}'), ('${ASSIGNMENTS}')) v(t);`),
          "2", `the ${role} privilege must really be back, or this test proves nothing`,
        );

        // SELECT: the privilege is held, so this SUCCEEDS and must see nothing.
        for (const t of [STOPS, ASSIGNMENTS]) {
          const sel = asClient(role, `SELECT count(*)::text FROM public.${t};`);
          assert.equal(sel.status, 0, `with SELECT granted the statement should run and simply see no row:\n${sel.stderr}`);
          assert.equal(sel.stdout.trim(), "0", `${role} saw rows in ${t}; the restrictive USING (false) must hide every one`);
        }

        // INSERT: refused by the restrictive policy, by name.
        for (const [t, sql] of [[STOPS, clientAttempt(STOPS, "INSERT")], [ASSIGNMENTS, clientAttempt(ASSIGNMENTS, "INSERT")]] as const) {
          const ins = asClient(role, sql);
          const refusal = refusalOf(ins);
          assert.ok(refusal, `${role} INSERT into ${t} was admitted once the grant was back:\n${sql}\n${ins.stdout}`);
          assert.equal(refusal.code, "42501");
          // PostgreSQL names the policy here only when ONE policy decided the
          // row; with no permissive policy to combine with, the restrictive set
          // is reported unnamed. Both shapes are accepted and nothing else is:
          // the message must be the ROW-LEVEL SECURITY refusal for THIS table,
          // and when a name is given it must be 3513's deny policy. (A
          // "permission denied" here would mean the grant never came back and
          // this test proved nothing; B0 pins the four policies by name.)
          assert.match(refusal.message,
            new RegExp(`^new row violates row-level security policy ("${t}_deny_insert_clients" )?for table "${t}"$`),
            `the refusal must be ${t}_deny_insert_clients, the only policy on ${t} that names INSERT for ${role}:\n${ins.stderr}`);
        }

        // UPDATE and DELETE: admitted, and they reach NO row.
        for (const t of [STOPS, ASSIGNMENTS]) {
          const col = t === STOPS ? "title" : "branch_id";
          const upd = asClient(role, `UPDATE public.${t} SET ${col} = 'client hijacked this' RETURNING 1;`);
          assert.equal(upd.status, 0, `with UPDATE granted the statement should run and match no row:\n${upd.stderr}`);
          assert.equal(upd.stdout.trim(), "", `${role} updated a row in ${t}`);
          const del = asClient(role, `DELETE FROM public.${t} RETURNING 1;`);
          assert.equal(del.status, 0, `with DELETE granted the statement should run and match no row:\n${del.stderr}`);
          assert.equal(del.stdout.trim(), "", `${role} deleted a row from ${t}`);
        }
      }
      assert.deepEqual(world(), before_, "a client with every privilege granted must still have changed nothing");
    } finally {
      for (const t of granted) exec(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
    }
    // The posture 3513 commits to is back, asserted rather than assumed.
    assert.equal(
      scalar(`SELECT count(*) FROM information_schema.role_table_grants
               WHERE table_schema='public' AND table_name IN ('${STOPS}','${ASSIGNMENTS}') AND grantee IN ('anon','authenticated');`),
      "0", "this suite must leave no client grant behind",
    );
    assert.deepEqual(world(), before_, "the grant-and-revoke round trip must have changed no row");
  });

  it("B3. NON-VACUITY: service_role performs the writes the crew routes need, and every one is read back from another connection", () => {
    const id = randomUUID();
    // INSERT, read back from a SEPARATE connection.
    serviceOk(`${insertStop({ branch_id: `'north'`, stop_order: "3", title: `'service wrote this'`, travel_min: "25" }, [], id)};`);
    let got = rows<StopRow>(`SELECT id::text, branch_id, stop_order, title, duration_min, travel_min, inside_airport, location_label, proposed_by::text FROM public.${STOPS} WHERE id = '${id}'`);
    assert.equal(got.length, 1, "service_role's INSERT must land — if it cannot write, 'nothing can write' proves nothing");
    assert.equal(got[0]!.title, "service wrote this");
    assert.equal(got[0]!.travel_min, 25, "the travel time supplied must be stored, not replaced");

    // UPDATE, read back.
    serviceOk(`UPDATE public.${STOPS} SET title = 'service updated this', stop_order = 4 WHERE id = '${id}';`);
    got = rows<StopRow>(`SELECT id::text, branch_id, stop_order, title, duration_min, travel_min, inside_airport, location_label, proposed_by::text FROM public.${STOPS} WHERE id = '${id}'`);
    assert.equal(got[0]!.title, "service updated this", "service_role's UPDATE must be visible from another connection");
    assert.equal(got[0]!.stop_order, 4);

    // The assignment write: a real split.
    serviceOk(`${insertAssignment({ branch_id: `'south'` })};`);
    assert.deepEqual(assignmentsOf(CREW).map((a) => [a.user_id, a.branch_id]).sort(),
      [[A, "all"], [B, "south"]].sort(), "service_role must be able to split a crew");
    serviceOk(`UPDATE public.${ASSIGNMENTS} SET branch_id = 'north' WHERE crew_id = '${CREW}' AND user_id = '${B}';`);
    assert.equal(assignmentsOf(CREW).find((a) => a.user_id === B)!.branch_id, "north", "service_role must be able to move a member between branches");

    // SELECT as service_role itself, not as the superuser the observer is.
    assert.equal(serviceOk(`SELECT count(*)::text FROM public.${STOPS} WHERE crew_id = '${CREW}';`)[0], "2",
      "service_role must be able to READ the itinerary it wrote");

    // DELETE, and the row is gone.
    serviceOk(`DELETE FROM public.${STOPS} WHERE id = '${id}';`);
    serviceOk(`DELETE FROM public.${ASSIGNMENTS} WHERE crew_id = '${CREW}' AND user_id = '${B}';`);
    assert.deepEqual(stopsOf(CREW).map((s) => s.id), [BASE_STOP], "service_role's DELETE must remove the row it wrote and nothing else");
    assert.deepEqual(assignmentsOf(CREW).map((a) => a.user_id), [A], "the baseline assignment must survive");
  });

  it("B4. the CHECK constraints refuse the values 3513 says they refuse, and nothing lands", () => {
    const cases: Array<{ what: string; sql: string; constraint: string }> = [
      { what: "stop_order below 0", sql: `${insertStop({ stop_order: "-1" })};`, constraint: `${STOPS}_stop_order_check` },
      { what: "stop_order above 999", sql: `${insertStop({ stop_order: "1000" })};`, constraint: `${STOPS}_stop_order_check` },
      { what: "an empty title", sql: `${insertStop({ title: `''` })};`, constraint: `${STOPS}_title_check` },
      { what: "a title of 121 characters", sql: `${insertStop({ title: `repeat('x', 121)` })};`, constraint: `${STOPS}_title_check` },
      { what: "duration_min below 5", sql: `${insertStop({ duration_min: "4" })};`, constraint: `${STOPS}_duration_min_check` },
      { what: "duration_min above 720", sql: `${insertStop({ duration_min: "721" })};`, constraint: `${STOPS}_duration_min_check` },
      { what: "a negative travel_min", sql: `${insertStop({ travel_min: "-1" })};`, constraint: `${STOPS}_travel_min_check` },
      { what: "travel_min above 240", sql: `${insertStop({ travel_min: "241" })};`, constraint: `${STOPS}_travel_min_check` },
      { what: "an empty branch_id on a stop", sql: `${insertStop({ branch_id: `''` })};`, constraint: `${STOPS}_branch_id_check` },
      { what: "a branch_id of 65 characters on a stop", sql: `${insertStop({ branch_id: `repeat('b', 65)` })};`, constraint: `${STOPS}_branch_id_check` },
      { what: "an empty location_label", sql: `${insertStop({ location_label: `''` })};`, constraint: `${STOPS}_location_label_check` },
      { what: "a location_label of 201 characters", sql: `${insertStop({ location_label: `repeat('l', 201)` })};`, constraint: `${STOPS}_location_label_check` },
      { what: "an empty branch_id on an assignment", sql: `${insertAssignment({ branch_id: `''` })};`, constraint: `${ASSIGNMENTS}_branch_id_check` },
      { what: "a branch_id of 65 characters on an assignment", sql: `${insertAssignment({ branch_id: `repeat('b', 65)` })};`, constraint: `${ASSIGNMENTS}_branch_id_check` },
    ];
    // Attempted as service_role: the role that CAN write, so the only thing
    // that can refuse these is the CHECK itself and not a missing privilege.
    for (const c of cases) {
      const before_ = world();
      const r = asService(c.sql);
      const refusal = refusalOf(r);
      assert.ok(refusal, `${c.what} was ADMITTED:\n${c.sql}`);
      assert.equal(refusal.code, "23514", `${c.what} must be refused by a CHECK, not by something else:\n${r.stderr}`);
      assert.equal(refusal.constraint, c.constraint, `${c.what} must be refused by ${c.constraint}:\n${r.stderr}`);
      assert.deepEqual(world(), before_, `${c.what} was refused but the table changed anyway`);
    }
    // The bounds are inclusive, so the refusals above are about the range and
    // not about the column being unwritable at all.
    const started = stopsOf(CREW).map((row) => row.id).sort();
    const edges = randomUUID();
    serviceOk(`${insertStop({ stop_order: "0", duration_min: "5", travel_min: "0", title: `repeat('e', 120)`, branch_id: `repeat('b', 64)`, location_label: `repeat('l', 200)` }, [], edges)};`);
    serviceOk(`${insertStop({ stop_order: "999", duration_min: "720", travel_min: "240", title: `'upper edge'` })};`);
    assert.equal(
      scalar(`SELECT count(*) FROM public.${STOPS} WHERE crew_id = '${CREW}'
               AND NOT (id = ANY (ARRAY[${started.map((x) => `'${x}'`).join(", ")}]::uuid[]));`),
      "2", "both inclusive edges must be accepted, or the refusals above are about the wrong thing",
    );
    serviceOk(`DELETE FROM public.${STOPS} WHERE crew_id = '${CREW}' AND NOT (id = ANY (ARRAY[${started.map((x) => `'${x}'`).join(", ")}]::uuid[]));`);
    assert.deepEqual(stopsOf(CREW).map((row) => row.id).sort(), started, "this test leaves the itinerary as it found it");
  });

  it("B5. travel_min has no default: an INSERT that omits it is refused, not silently zeroed", () => {
    const before_ = world();
    const sql = `${insertStop({}, ["travel_min"])};`;
    const r = asService(sql);
    const refusal = refusalOf(r);
    assert.ok(refusal, `an INSERT omitting travel_min was ADMITTED — it would have stored a journey nobody measured:\n${sql}\n${r.stdout}`);
    assert.equal(refusal.code, "23502", `the refusal must be the NOT NULL, which is what a missing default produces:\n${r.stderr}`);
    assert.equal(refusal.column, "travel_min", `the refusal must be about travel_min:\n${r.stderr}`);
    assert.match(refusal.message, /null value in column "travel_min"/);
    assert.deepEqual(world(), before_, "no row may land from an INSERT that stated no travel time");
    // And the same INSERT with the column stated does land — so B5 is about the
    // omission, not about the statement being broken.
    const stated = randomUUID();
    serviceOk(`${insertStop({ travel_min: "0" }, [], stated)};`);
    assert.equal(rows<StopRow>(`SELECT travel_min FROM public.${STOPS} WHERE id = '${stated}'`)[0]!.travel_min, 0,
      "an airside zero that was actually STATED is a fact and must be storable");
    serviceOk(`DELETE FROM public.${STOPS} WHERE id = '${stated}';`);
    assert.deepEqual(world(), before_);
  });

  it("B6. two stops may share a stop_order in one branch: no uniqueness race for two members proposing at once", () => {
    const started = stopsOf(CREW).map((row) => row.id).sort();
    const first = randomUUID();
    const second = randomUUID();
    for (const [id, who] of [[first, A], [second, B]] as const) {
      const r = asService(`${insertStop({ branch_id: `'all'`, stop_order: "7", title: `'proposed by ${who.slice(0, 8)}'`, proposed_by: `'${who}'` }, [], id)};`);
      assert.equal(r.status, 0, `a second stop at order 7 must be admitted, not reported to a traveller who did nothing wrong:\n${r.stderr}`);
    }
    const shared = stopsOf(CREW).filter((s) => s.stop_order === 7);
    assert.equal(shared.length, 2, "both proposals must be rows: 'these two were proposed at once' is two rows, not an error");
    assert.deepEqual(shared.map((s) => s.id).sort(), [first, second].sort());
    assert.deepEqual([...new Set(shared.map((s) => s.branch_id))], ["all"], "and in the SAME branch, which is where a unique index would have bitten");
    serviceOk(`DELETE FROM public.${STOPS} WHERE id IN ('${first}', '${second}');`);
    assert.deepEqual(stopsOf(CREW).map((row) => row.id).sort(), started, "this test leaves the itinerary as it found it");
  });

  it("B8. PRIMARY KEY (crew_id, user_id): a second branch for the same member in the same crew is refused, and the first assignment is untouched", () => {
    const before_ = assignmentsOf(CREW);
    assert.deepEqual(before_.map((a) => [a.user_id, a.branch_id]), [[A, "all"]], "the baseline assignment is what the second write must collide with");
    const r = asService(`${insertAssignment({ user_id: `'${A}'`, branch_id: `'north'` })};`);
    const refusal = refusalOf(r);
    assert.ok(refusal, "a second branch for the same member in the same crew was ADMITTED; certifyCrewPlan's member_assigned_twice would be reachable by a double tap");
    assert.equal(refusal.code, "23505", `the refusal must be the unique violation:\n${r.stderr}`);
    assert.equal(refusal.constraint, `${ASSIGNMENTS}_pkey`, `the refusal must come from the composite primary key:\n${r.stderr}`);
    assert.deepEqual(assignmentsOf(CREW), before_, "the member's existing branch must be unchanged by the refused write");

    // The key is on the PAIR: the same person in ANOTHER crew, and another
    // person in THIS crew, are both fine.
    const otherCrew = randomUUID();
    exec(`INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, expires_at)
            VALUES ('${otherCrew}', 'doha', '${A}', '${SESSION}', '3513 probe crew 2', NOW() + INTERVAL '8 hours');`);
    serviceOk(`${insertAssignment({ crew_id: `'${otherCrew}'`, user_id: `'${A}'`, branch_id: `'north'` })};`);
    serviceOk(`${insertAssignment({ user_id: `'${B}'`, branch_id: `'north'` })};`);
    assert.equal(assignmentsOf(otherCrew).length, 1, "the same member in a different crew is a different key");
    assert.deepEqual(assignmentsOf(CREW).map((a) => a.user_id).sort(), [A, B].sort(), "a different member in this crew is a different key");
    exec(`DELETE FROM public.layover_crews WHERE id = '${otherCrew}';`);
    serviceOk(`DELETE FROM public.${ASSIGNMENTS} WHERE crew_id = '${CREW}' AND user_id = '${B}';`);
    assert.deepEqual(assignmentsOf(CREW), before_);
  });

  it("B7. ON DELETE CASCADE from layover_crews removes the stops and the assignments", () => {
    // A crew of its own, so the baseline this suite probes is not the evidence.
    const baseline = world();
    const crew = randomUUID();
    exec(`INSERT INTO public.layover_crews (id, city, created_by, created_session_id, title, expires_at)
            VALUES ('${crew}', 'doha', '${A}', '${SESSION}', '3513 cascade crew', NOW() + INTERVAL '8 hours');`);
    serviceOk(
      `${insertStop({ crew_id: `'${crew}'`, title: `'cascade stop one'` })};
       ${insertStop({ crew_id: `'${crew}'`, stop_order: "1", title: `'cascade stop two'`, branch_id: `'north'` })};
       ${insertAssignment({ crew_id: `'${crew}'`, user_id: `'${A}'` })};
       ${insertAssignment({ crew_id: `'${crew}'`, user_id: `'${B}'`, branch_id: `'south'` })};`,
    );
    assert.equal(stopsOf(crew).length, 2, "the cascade needs rows to remove");
    assert.equal(assignmentsOf(crew).length, 2);
    assert.equal(totals().stops, baseline.totals.stops + 2, "the cascade crew's stops are extra rows in the table");
    assert.equal(totals().assignments, baseline.totals.assignments + 2);

    const del = asService(`DELETE FROM public.layover_crews WHERE id = '${crew}';`);
    assert.equal(del.status, 0, `the crew delete must be admitted; a cascade that cannot run is not a cascade:\n${del.stderr}`);

    assert.deepEqual(stopsOf(crew), [], "every stop of a deleted crew must be gone");
    assert.deepEqual(assignmentsOf(crew), [], "every assignment of a deleted crew must be gone");
    assert.equal(scalar(`SELECT count(*) FROM public.layover_crews WHERE id = '${crew}';`), "0");
    assert.deepEqual(world(), baseline, "the cascade must reach only the deleted crew's rows");
  });
});
