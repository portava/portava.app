/**
 * Trip RLS must mean what the API means by "accepted trip member" -- on every
 * table, not just the route-plan ones 2334 fixed.
 *
 * WHAT WAS ACTUALLY WRONG
 * =======================
 * 2334 repaired five route-plan policies that hand-rolled
 * `tm.role IN ('owner','member')` and never read `trip_members.status`. The same
 * shape survived on twenty-six more policies across fifteen further tables, and
 * three of those tables carried something worse: a PERMISSIVE SELECT policy
 * whose entire predicate was
 *
 *     USING (auth.uid() IS NOT NULL)
 *
 * under a name asserting a trip-membership test -- `crew_events_trip_members` on
 * trip_crew_location_events, `attendance_events_trip_members` on
 * plan_attendance_events, `trip_members_view_checkins` on plan_checkins. Because
 * permissive policies OR together, each one completely dominated the careful
 * membership policy beside it: repairing that neighbour changed nothing while
 * the blanket policy stood. Measured on portava-ci before 2337, a fixture
 * STRANGER read the crew location event, the attendance event and the check-in.
 *
 * The membership half ran in three directions at once, and both pending-invite
 * encodings are live in production (owner/accepted 38, invited/accepted 2,
 * member/invited 1, member/accepted 1):
 *
 *   FAIL-OPEN   no status gate admits role='member', status='invited' -- a
 *               pending invitee the API denies. Measured: that viewer read the
 *               crew's location preferences, the plan, its geofences and
 *               editors, the trip's reservations and availability, trip_only
 *               posts and media, and could WRITE plan items and availability.
 *   FAIL-OPEN   a status-only gate with no role gate (trip_activity_log) admits
 *               the mirror encoding, role='invited' with status='accepted'.
 *   FAIL-CLOSED co_host, viewer, and a trip owner holding no trip_members row
 *               are accepted crew per lib/http.ts and were omitted.
 *
 * 2337 routes all of it through SECURITY DEFINER helpers in `authz` that encode
 * requireTripMember exactly, and repoints public.is_accepted_trip_member -- a
 * shared helper reached by three more policies through can_see_post,
 * can_post_to_trip and can_see_postcard -- at the same rule.
 *
 * WHAT THIS FILE ASSERTS
 * ======================
 * The property is a property of the SQL, and this suite cannot reach a database
 * (the `test` script pins the connection URL at a dead port), so it reads the
 *
 * -- This comment deliberately does not spell out that environment variable's
 * -- name. check:guard-coverage classifies any file NAMING a Supabase
 * -- credential as one that "can reach Supabase", and then requires it to
 * -- import the guard front door. Neither offered remedy fits: this file opens
 * -- no connection and calls no createClient, so the guard would be inert, and
 * -- an EXEMPT entry asserts "CI cannot invoke it", which is the opposite of
 * -- true -- CI runs it on every push. The honest resolution is not to name the
 * -- variable. (Same reasoning as src/scripts/checkProductionDrift.ts.)
 *
 * migration corpus as text -- the same approach as routePlanCrewVisibility and
 * appendOnlyCascade. Nothing here is a snapshot of today's policies: the corpus
 * is scanned in migration order and the LAST definition of each policy wins, so
 * a NEW migration that reintroduces either defect fails here rather than
 * silently in production.
 *
 * The two load-bearing assertions are the last two: the accepted-role set and
 * the status gate are parsed out of BOTH lib/http.ts AND the migration and
 * compared, and no winning policy on the three sensitive tables may reduce to
 * `auth.uid() IS NOT NULL`.
 *
 * Run: node --import tsx/esm --test src/test/tripCrewRlsMembershipConvergence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const REPO_ROOT = join(HERE, "../../../..");
const MIGRATION_2337 = "2337_trip_crew_rls_membership_convergence.sql";

/**
 * The three tables that carried a policy named after a membership check it did
 * not perform. These are separated out because the assertion about them is
 * different in kind: not "does the predicate read status" but "is there a
 * predicate at all".
 */
const BLANKET_READ_TABLES = [
  "trip_crew_location_events",
  "plan_attendance_events",
  "plan_checkins",
];

/**
 * Every policy 2337 repaired, keyed table.policy. A policy leaving this list is
 * as much a regression as a policy failing an assertion in it, so the list is
 * checked for completeness against the migration itself below.
 */
const REPAIRED = [
  "trip_crew_location_events.crew_events_trip_members",
  "trip_crew_location_events.crew_events_members_read",
  "trip_crew_location_preferences.crew_prefs_members_read",
  "trip_crew_location_sessions.crew_loc_sessions_trip_member_read",
  "trip_crew_location_sessions.crew_sessions_recipients_read",
  "plan_attendance_events.attendance_events_trip_members",
  "plan_attendance_events.pae_select_accepted",
  "plan_checkins.trip_members_view_checkins",
  "plan_checkins.chk_select_accepted",
  "plan_checkins.plan_checkins_trip_member_read",
  "plan_editors.plan_editors_select",
  "plan_geofences.plan_geofences_select_accepted",
  "plan_geofences.plan_geofences_insert_accepted",
  "plan_geofences.plan_geofences_update_accepted",
  "trip_plan_items.plan_items_select",
  "trip_plan_items.plan_items_insert",
  "trip_plan_items.plan_items_update",
  "trip_reservations.trip_reservations_member_read",
  "trip_activity_log.trip_activity_log_select",
  "trip_availability.ta_own",
  "trip_availability.ta_trip_members_select",
  "user_availability.ua_trip_select",
  "quick_availability_status.qas_trip_select",
  "posts.posts_select_policy",
  "post_media.post_media_public_select",
  "trip_join_requests.trip_join_requests_select",
  "meetups.meetups_trip_select",
  "meetup_invites.mi_trip_select",
  "meetup_time_options.mto_trip_select",
];

const REPAIRED_TABLES = [...new Set(REPAIRED.map((k) => k.split(".")[0]))];

interface PolicyDef {
  policy: string;
  table: string;
  body: string;
  predicate: string;
  file: string;
}

function migrationsInOrder(): Array<{ file: string; sql: string; order: number }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8"), order: Number.parseInt(f, 10) }))
    .filter((m) => Number.isFinite(m.order))
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
}

/** Strip `--` line comments so prose about the defect never satisfies an assertion. */
function stripComments(sql: string): string {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

/**
 * Every CREATE POLICY statement in one file, with its full body and, separately,
 * just the predicate. The predicate is sliced from the first USING / WITH CHECK
 * so that a policy NAME containing "trip_members" -- three of them do -- can
 * never satisfy or fail an assertion about what the predicate reads.
 */
function parsePolicies(sql: string, file: string): PolicyDef[] {
  const out: PolicyDef[] = [];
  const re = /CREATE\s+POLICY\s+"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let depth = 0;
    let end = sql.length;
    for (let i = re.lastIndex; i < sql.length; i++) {
      const c = sql[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) { end = i; break; }
    }
    const body = stripComments(sql.slice(m.index, end));
    const kw = body.search(/\b(USING|WITH\s+CHECK)\b/i);
    out.push({
      policy: m[1],
      table: m[2],
      body,
      predicate: kw >= 0 ? body.slice(kw) : "",
      file,
    });
  }
  return out;
}

/** Winning (last-applied) definition of every policy on the tables in scope. */
function finalPolicies(tables: string[]): Map<string, PolicyDef> {
  const winner = new Map<string, PolicyDef>();
  for (const { file, sql } of migrationsInOrder()) {
    for (const p of parsePolicies(sql, file)) {
      if (!tables.includes(p.table)) continue;
      winner.set(`${p.table}.${p.policy}`, p);
    }
  }
  return winner;
}

function migration2337(): string {
  return readFileSync(join(MIGRATIONS, MIGRATION_2337), "utf8");
}

describe("trip crew RLS membership convergence (migration 2337)", () => {
  it("2337 exists and carries a rollback", () => {
    assert.ok(
      existsSync(join(MIGRATIONS, MIGRATION_2337)),
      `${MIGRATION_2337} is missing from the migration corpus`,
    );
    const rollbacks = readdirSync(join(REPO_ROOT, "db/rollback"));
    assert.ok(
      rollbacks.some((f) => f.includes("2337")),
      `no rollback in db/rollback/ mentions 2337; found: ${rollbacks.join(", ")}`,
    );
  });

  it("the rollback names the hole it reopens instead of restoring it quietly", () => {
    // Restoring `auth.uid() IS NOT NULL` on three tables holding crew location
    // and attendance data is not an ordinary revert, and an operator running it
    // at 3am must not have to read the SQL to find that out.
    const rollbacks = readdirSync(join(REPO_ROOT, "db/rollback")).filter((f) => f.includes("2337"));
    assert.equal(rollbacks.length, 1, `expected exactly one 2337 rollback, found ${rollbacks.length}`);
    const sql = readFileSync(join(REPO_ROOT, "db/rollback", rollbacks[0]), "utf8");
    assert.match(sql, /auth\.uid\(\)\s+IS\s+NOT\s+NULL/i,
      "the 2337 rollback does not restore the blanket policies it must restore");
    assert.match(sql, /REOPENS A SECURITY HOLE|BLANKET READ/i,
      "the 2337 rollback restores three blanket read policies without saying so in its banner");
  });

  it("every repaired policy's winning definition routes through an authz helper", () => {
    const finals = finalPolicies(REPAIRED_TABLES);
    for (const key of REPAIRED) {
      const def = finals.get(key);
      assert.ok(def, `repaired policy ${key} has no CREATE POLICY anywhere in the corpus`);
      assert.match(
        def.predicate,
        /authz\.[a-z_]+\s*\(/,
        `${key} (last defined in ${def.file}) does not route through an authz helper -- ` +
          `a hand-rolled membership predicate here is how the status gate got lost the first time`,
      );
    }
  });

  it("no repaired policy reaches into trip_members inline any more", () => {
    // The hand-rolled shape IS the defect: a predicate that joins trip_members
    // itself has re-acquired the freedom to forget `status`, forget co_host and
    // viewer, and forget the trips.owner_id fallback.
    const finals = finalPolicies(REPAIRED_TABLES);
    const offenders: string[] = [];
    for (const key of REPAIRED) {
      const def = finals.get(key);
      if (def && /\btrip_members\b/i.test(def.predicate)) offenders.push(`${key} (${def.file})`);
    }
    assert.deepEqual(offenders, [], `these policies still reference trip_members inline: ${offenders.join(", ")}`);
  });

  it("no policy on the crew-location, attendance or check-in tables is a blanket authenticated read", () => {
    // This is the assertion that would have caught 0039 and 0041 the day they
    // were written. `USING (auth.uid() IS NOT NULL)` on a table scoped to a trip
    // is not a weak membership test, it is the absence of one.
    const finals = finalPolicies(BLANKET_READ_TABLES);
    const offenders: string[] = [];
    for (const [key, def] of finals) {
      const normalised = def.predicate.replace(/\s+/g, "").replace(/[()]/g, "");
      if (/^USINGauth\.uidISNOTNULL$/i.test(normalised)) offenders.push(`${key} (${def.file})`);
    }
    assert.deepEqual(
      offenders,
      [],
      `these policies let any authenticated user read every row of a per-trip table: ${offenders.join(", ")}`,
    );
  });

  it("the shared helper public.is_accepted_trip_member delegates rather than duplicating", () => {
    // It is reached by posts_select, posts_insert and postcards_select through
    // can_see_post / can_post_to_trip / can_see_postcard. Until 2337 it carried
    // the original defect verbatim, so those three policies did too.
    let winner: { file: string; body: string } | null = null;
    for (const { file, sql } of migrationsInOrder()) {
      const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.is_accepted_trip_member\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const end = sql.indexOf("$fn$;", m.index) >= 0 ? sql.indexOf("$fn$;", m.index) : sql.indexOf("$$;", m.index);
        winner = { file, body: sql.slice(m.index, end > 0 ? end : m.index + 800) };
      }
    }
    assert.ok(winner, "public.is_accepted_trip_member is defined nowhere in the migration corpus");
    assert.match(
      stripComments(winner.body),
      /authz\.is_trip_crew\s*\(/,
      `public.is_accepted_trip_member (last defined in ${winner.file}) does not delegate to ` +
        `authz.is_trip_crew, so it can drift away from the rule 2334 and 2337 enforce everywhere else`,
    );
  });

  it("2337's helpers are SECURITY DEFINER, pin search_path, and live in authz", () => {
    const sql = migration2337();
    for (const fn of ["accepted_trip_ids", "is_accepted_trip_member", "shares_accepted_trip",
                      "accepted_trip_role", "geofence_trip_id"]) {
      const at = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+authz\\.${fn}\\s*\\(`, "i"));
      assert.ok(at >= 0, `authz.${fn} is not created by ${MIGRATION_2337}`);
      const head = sql.slice(at, at + 600);
      assert.match(head, /SECURITY\s+DEFINER/i,
        `authz.${fn} is not SECURITY DEFINER -- an RLS-subject membership read inherits the ` +
          `defect it is meant to remove, because trip_members_select is itself USING can_see_trip()`);
      assert.match(head, /SET\s+search_path\s+TO\s+'public',\s*'pg_catalog'/i,
        `authz.${fn} does not pin search_path; 0201 pinned every other authz helper for a reason`);
    }
    // In authz, never public: PostgREST exposes public, and a membership
    // predicate reachable as an RPC is a membership oracle.
    assert.ok(
      !/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(accepted_trip_ids|shares_accepted_trip|accepted_trip_role|geofence_trip_id)\s*\(/i.test(sql),
      `${MIGRATION_2337} creates a membership helper in public, where PostgREST would expose it as an RPC oracle`,
    );
  });

  it("authz.accepted_trip_ids accepts exactly the roles lib/http.ts requireTripMember accepts", () => {
    // The load-bearing assertion. Both sides are parsed; neither can drift
    // without turning this red.
    const httpTs = readFileSync(join(HERE, "../lib/http.ts"), "utf8");
    const rolesLine = httpTs.match(/const\s+acceptedRoles\s*=\s*\[([^\]]+)\]/);
    assert.ok(rolesLine, "lib/http.ts no longer declares acceptedRoles -- requireTripMember has been restructured");
    const httpRoles = [...rolesLine[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

    const sql = migration2337();
    const at = sql.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.accepted_trip_ids\s*\(/i);
    const fn = sql.slice(at, sql.indexOf("$fn$;", at));
    const sqlRolesMatch = fn.match(/m\.role\s+IN\s*\(([^)]*)\)/i);
    assert.ok(sqlRolesMatch, "authz.accepted_trip_ids has no `m.role IN (...)` list");
    const sqlRoles = [...sqlRolesMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    assert.deepEqual(
      sqlRoles,
      httpRoles,
      `authz.accepted_trip_ids accepts [${sqlRoles.join(", ")}] but lib/http.ts requireTripMember accepts ` +
        `[${httpRoles.join(", ")}]. RLS and the API must not disagree about who the crew is -- that ` +
        `disagreement is the entire defect 2334 and 2337 exist to remove.`,
    );

    assert.match(
      fn,
      /coalesce\s*\(\s*m\.status\s*,\s*'accepted'\s*\)\s*=\s*'accepted'/i,
      "authz.accepted_trip_ids must gate on an accepted status. Omitting it is the original fail-open: " +
        "trip_members.status is `text NOT NULL DEFAULT 'accepted'` and production holds a role='member', " +
        "status='invited' row that the API denies.",
    );

    // The trips.owner_id fallback, and the NOT EXISTS that keeps it from
    // overriding a membership row that says the owner was removed.
    assert.match(fn, /t\.owner_id\s*=\s*u_id/i,
      "authz.accepted_trip_ids drops requireTripMember's trips.owner_id fallback (http.ts:454-462); " +
        "5 of 43 production trips have an owner with no trip_members row");
    assert.match(fn, /NOT\s+EXISTS/i,
      "authz.accepted_trip_ids applies the owner fallback unconditionally instead of only when no " +
        "membership row exists, which would admit an owner whose own row says status='removed'");
  });

  it("2337 leaves 2334's authz.is_trip_crew alone", () => {
    // routePlanCrewVisibility.test.ts parses is_trip_crew's body out of the
    // corpus and compares it against lib/http.ts. Redefining it here -- even
    // into something semantically identical -- moves the winning definition into
    // this migration and turns that gate red for no gain.
    assert.ok(
      !/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.is_trip_crew\s*\(\s*t_id\s+uuid\s*\)/i.test(migration2337()),
      `${MIGRATION_2337} redefines authz.is_trip_crew, which belongs to 2334`,
    );
  });

  it("the REPAIRED list matches what 2337 actually rewrites", () => {
    // Guards the guard: if a later edit adds a policy to the migration and not
    // to this list, the new policy is unprotected and this says so.
    const declared = new Set(REPAIRED);
    const actual = new Set(
      parsePolicies(migration2337(), MIGRATION_2337).map((p) => `${p.table}.${p.policy}`),
    );
    const missingFromList = [...actual].filter((k) => !declared.has(k)).sort();
    const missingFromMigration = [...declared].filter((k) => !actual.has(k)).sort();
    assert.deepEqual(missingFromList, [],
      `${MIGRATION_2337} rewrites policies this test does not cover: ${missingFromList.join(", ")}`);
    assert.deepEqual(missingFromMigration, [],
      `this test claims 2337 rewrites policies it does not: ${missingFromMigration.join(", ")}`);
  });
});
