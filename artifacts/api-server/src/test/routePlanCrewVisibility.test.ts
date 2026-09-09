/**
 * Route-plan RLS must mean what the API means by "accepted trip member".
 *
 * WHAT WAS ACTUALLY WRONG
 * =======================
 * The trips census recorded route_plans/route_stops/route_legs as having
 * "owner-only RLS -- a trip's crew cannot read the trip's own route plan".
 * That was not true and never was: 0058 and 0059 shipped a crew SELECT policy
 * on every one of the four tables, and pg_policies on BOTH production and
 * portava-ci matched the committed files byte for byte.
 *
 * The real defect was narrower, and ran in both directions at once. All five
 * crew policies hand-rolled the same predicate:
 *
 *     tm.role IN ('owner','member')
 *
 * while every route-plan HTTP handler authorizes through `requireTripMember`
 * (src/lib/http.ts), which accepts a viewer when EITHER a trip_members row
 * exists with role in (owner, co_host, member, viewer) AND an accepted status,
 * OR no row exists and trips.owner_id is the viewer. Three divergences:
 *
 *   FAIL-OPEN   `status` was not checked at all. trip_members.status is
 *               `text NOT NULL DEFAULT 'accepted'` with live non-accepted
 *               values, so a PENDING INVITEE (role='member', status='invited')
 *               was admitted by RLS and refused by the API. Measured on
 *               portava-ci against a fixture trip, the pre-fix policies served
 *               that viewer the plan, both stops and the leg. `anon` and
 *               `authenticated` hold the full DML set on these tables, so RLS
 *               is the only control on the direct-PostgREST path -- which 0059
 *               says in its own words it exists to close.
 *
 *   FAIL-CLOSED `co_host` and `viewer` are accepted crew everywhere in the
 *               application and appeared in none of the policies.
 *
 *   FAIL-CLOSED A trip owner with no trip_members row is crew per http.ts, and
 *               the policies joined trip_members without ever consulting
 *               trips.owner_id.
 *
 * 2334 replaced all five predicates with one SECURITY DEFINER helper,
 * authz.is_trip_crew(uuid), that encodes requireTripMember's rule exactly.
 *
 * WHAT THIS FILE ASSERTS
 * ======================
 * The property being protected IS a property of the SQL, and this suite cannot
 * reach a database, so it reads the migration corpus as text -- the same
 * approach as appendOnlyCascade.test.ts. Nothing here is a hardcoded list of
 * today's policies: the corpus is scanned in migration order and the LAST
 * definition of each policy wins, so a NEW migration that reintroduces the
 * hand-rolled predicate fails here rather than silently in production.
 *
 * The load-bearing assertion is the last one: the accepted-role set and the
 * status gate are parsed out of BOTH lib/http.ts AND the migration, and
 * compared. Neither side can drift without turning this red.
 *
 * Run: node --import tsx/esm --test src/test/routePlanCrewVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const REPO_ROOT = join(HERE, "../../../..");

/** The four tables the route-plan feature owns. */
const ROUTE_TABLES = ["route_plans", "route_stops", "route_legs", "route_plan_members"];

/** The five policies that decide what a trip's CREW may see or do. */
const CREW_POLICIES = [
  "route_plans_member_select",
  "route_stops_member_select",
  "route_legs_member_select",
  "rpm_select_trip",
  "rpm_insert_own",
];

interface PolicyDef {
  policy: string;
  table: string;
  body: string;
  file: string;
  order: number;
}

/** Migration files in applied order (numeric prefix). */
function migrationsInOrder(): Array<{ file: string; sql: string; order: number }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8"), order: Number.parseInt(f, 10) }))
    .filter((m) => Number.isFinite(m.order))
    .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
}

/**
 * Every CREATE POLICY statement in one file, with its full body.
 * Scans to the `;` that closes the statement at paren depth zero, so nested
 * subqueries (every one of these policies has them) are captured whole.
 */
function parsePolicies(sql: string, file: string, order: number): PolicyDef[] {
  const out: PolicyDef[] = [];
  const re = /CREATE\s+POLICY\s+"?([A-Za-z0-9_]+)"?\s+ON\s+(?:public\.)?"?([A-Za-z0-9_]+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let depth = 0;
    let end = re.lastIndex;
    for (let i = re.lastIndex; i < sql.length; i++) {
      const c = sql[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) { end = i; break; }
    }
    out.push({ policy: m[1], table: m[2], body: sql.slice(m.index, end), file, order });
  }
  return out;
}

/** The winning (last-applied) definition of every route-table policy. */
function finalRoutePolicies(): Map<string, PolicyDef> {
  const winner = new Map<string, PolicyDef>();
  for (const { file, sql, order } of migrationsInOrder()) {
    for (const p of parsePolicies(sql, file, order)) {
      if (!ROUTE_TABLES.includes(p.table)) continue;
      winner.set(`${p.table}.${p.policy}`, p);
    }
  }
  return winner;
}

/** Strip `--` line comments so prose about the defect never satisfies an assertion. */
function stripComments(sql: string): string {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

const MIGRATION_2334 = "2334_route_plan_crew_visibility.sql";

describe("route-plan crew visibility (migration 2334)", () => {
  it("2334 exists and carries an idempotent rollback", () => {
    assert.ok(
      existsSync(join(MIGRATIONS, MIGRATION_2334)),
      `${MIGRATION_2334} is missing from the migration corpus`,
    );
    const rollbacks = readdirSync(join(REPO_ROOT, "db/rollback"));
    assert.ok(
      rollbacks.some((f) => f.includes("2334")),
      `no rollback in db/rollback/ mentions 2334; found: ${rollbacks.join(", ")}`,
    );
  });

  it("every crew policy's winning definition routes through authz.is_trip_crew", () => {
    const finals = finalRoutePolicies();
    for (const name of CREW_POLICIES) {
      const entry = [...finals.entries()].find(([k]) => k.endsWith(`.${name}`));
      assert.ok(entry, `crew policy ${name} has no CREATE POLICY anywhere in the corpus`);
      const [key, def] = entry;
      assert.match(
        stripComments(def.body),
        /authz\.is_trip_crew\s*\(/,
        `${key} (last defined in ${def.file}) does not route through authz.is_trip_crew -- ` +
          `a hand-rolled membership predicate here is how the status gate got lost the first time`,
      );
    }
  });

  it("no route-plan policy joins trip_members directly any more", () => {
    // The hand-rolled shape is the defect itself: any predicate that reaches
    // into trip_members inline has re-acquired the freedom to forget `status`.
    const offenders: string[] = [];
    for (const [key, def] of finalRoutePolicies()) {
      if (/\btrip_members\b/i.test(stripComments(def.body))) offenders.push(`${key} (${def.file})`);
    }
    assert.deepEqual(
      offenders,
      [],
      `these route-plan policies still reference trip_members inline instead of using ` +
        `authz.is_trip_crew: ${offenders.join(", ")}`,
    );
  });

  it("the owner policies survive 2334 untouched", () => {
    // 2334 is a crew-predicate change. If it ever starts rewriting the owner
    // policies too, that is a much larger change than its header claims.
    const finals = finalRoutePolicies();
    const ownerPolicies = [
      "route_plans.route_plans_owner_select",
      "route_plans.route_plans_owner_insert",
      "route_plans.route_plans_owner_update",
      "route_plans.route_plans_owner_delete",
      "route_stops.route_stops_owner_all",
      "route_legs.route_legs_owner_all",
      "route_plan_members.rpm_select_own",
      "route_plan_members.rpm_delete_own",
    ];
    for (const key of ownerPolicies) {
      const def = finals.get(key);
      assert.ok(def, `owner policy ${key} vanished from the corpus`);
      assert.notEqual(
        def.file,
        MIGRATION_2334,
        `${key} was redefined by ${MIGRATION_2334}, which claims to touch only the crew predicates`,
      );
    }
  });

  it("authz.is_trip_crew is a SECURITY DEFINER helper in the authz schema", () => {
    const sql = stripComments(readFileSync(join(MIGRATIONS, MIGRATION_2334), "utf8"));
    assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.is_trip_crew\s*\(\s*t_id\s+uuid\s*\)/i,
      "the helper must live in authz, not public: PostgREST exposes public functions as RPC");
    assert.match(sql, /SECURITY\s+DEFINER/i,
      "must be SECURITY DEFINER or the membership read recurses into the policy that calls it");
    assert.match(sql, /\bSTABLE\b/i, "must be STABLE so the planner may cache it per statement");
    assert.match(sql, /SET\s+search_path\s+TO\s+'public',\s*'pg_catalog'/i,
      "an unpinned search_path on a SECURITY DEFINER function is a privilege-escalation vector");
    // The 2199 trap: revoking EXECUTE does not harden this, it breaks every read.
    assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+authz\.is_trip_crew\(uuid\)\s+TO\s+[^;]*\banon\b/i,
      "anon must retain EXECUTE -- RLS predicates evaluate with the querying role's privileges");
    assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+authz\.is_trip_crew\(uuid\)\s+TO\s+[^;]*\bauthenticated\b/i,
      "authenticated must retain EXECUTE, or every crew read fails closed");
    // auth.uid() is read INSIDE the function, never passed in, so the only
    // question anyone can ask is "am I crew", whose answer they already have.
    assert.ok(!/is_trip_crew\s*\(\s*t_id\s+uuid\s*,/i.test(sql),
      "the helper must not take a viewer parameter -- that would make it a membership oracle");
    assert.match(sql, /auth\.uid\(\)/, "the viewer must be read from auth.uid() inside the function");
  });

  it("the helper honours the trips.owner_id fallback for owners with no membership row", () => {
    const sql = stripComments(readFileSync(join(MIGRATIONS, MIGRATION_2334), "utf8"));
    const fn = sql.slice(sql.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.is_trip_crew/i));
    assert.match(fn, /public\.trips\s+t\b[\s\S]{0,200}?t\.owner_id\s*=\s*auth\.uid\(\)/i,
      "requireTripMember (lib/http.ts) treats trips.owner_id as crew when no trip_members row exists " +
        "(pinned by gemsFeed.test.ts:600); the helper must do the same or trip owners lose their own plans");
  });

  it("the SQL accepted-role set and status gate match lib/http.ts exactly", () => {
    // THE LOAD-BEARING ASSERTION. Both sides are parsed; neither is hardcoded
    // here. requireTripMember is the definition of record, so if it gains or
    // loses a role, or stops gating on status, this fails until the migration
    // is brought back into step.
    const http = readFileSync(join(HERE, "../lib/http.ts"), "utf8");

    const rolesMatch = http.match(/const\s+acceptedRoles\s*=\s*\[([^\]]+)\]/);
    assert.ok(rolesMatch, "could not find `acceptedRoles` in lib/http.ts -- requireTripMember was restructured");
    const tsRoles = [...rolesMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    assert.ok(tsRoles.length > 0, "acceptedRoles parsed empty");

    const sql = stripComments(readFileSync(join(MIGRATIONS, MIGRATION_2334), "utf8"));
    const fn = sql.slice(sql.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+authz\.is_trip_crew/i));
    const sqlRolesMatch = fn.match(/m\.role\s+IN\s*\(([^)]+)\)/i);
    assert.ok(sqlRolesMatch, "authz.is_trip_crew has no `m.role IN (...)` list");
    const sqlRoles = [...sqlRolesMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    assert.deepEqual(
      sqlRoles,
      tsRoles,
      `authz.is_trip_crew accepts [${sqlRoles.join(", ")}] but lib/http.ts requireTripMember accepts ` +
        `[${tsRoles.join(", ")}]. RLS and the API must agree on who the crew is -- a role in one and ` +
        `not the other is either a leak or a lockout.`,
    );

    // http.ts:474 -- `row.status != null && row.status !== "accepted"` -> deny.
    assert.match(
      http,
      /row\.status\s*!=\s*null\s*&&\s*row\.status\s*!==\s*"accepted"/,
      "requireTripMember no longer gates on an accepted status; re-derive the SQL predicate before editing this",
    );
    assert.match(
      fn,
      /coalesce\(\s*m\.status\s*,\s*'accepted'\s*\)\s*=\s*'accepted'/i,
      "authz.is_trip_crew must gate on an accepted status. Omitting it is the original fail-open defect: " +
        "a pending invitee (role='member', status='invited') reads the trip's whole route plan off PostgREST.",
    );
  });
});
